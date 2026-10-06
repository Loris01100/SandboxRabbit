/**
 * Le classement des défis livrés, côté page. Chargé par main.ts au premier
 * défi lancé (`import()`) : la page a un budget de 84 Kio, et qui ne joue pas
 * aux défis n'en a pas besoin.
 *
 * Chaque record porte son rejeu, et le Worker ne le vérifie pas (trop de
 * calcul pour l'offre gratuite). Ce module le fait donc ici : chaque record
 * servi part au fil du juge (sim/judge.ts), qui le rejoue depuis la grille du
 * défi, et seuls ceux qui gagnent bien en le temps annoncé s'affichent. Un
 * faux record est écarté chez chacun, au prix de quelques secondes de calcul
 * dans un fil à part.
 *
 * Le temps est en ticks de simulation (60 par seconde), pas l'horloge murale
 * du record personnel (main.ts) : seul le premier se prouve par un rejeu.
 */
import { pack, unpack, type Recording } from "./replay.ts";
import type { Case } from "./sim/judge.ts";

const boardEl = document.querySelector<HTMLDivElement>("#board")!;
const titleEl = document.querySelector<HTMLParagraphElement>("#board-title")!;
const listEl = document.querySelector<HTMLOListElement>("#board-list")!;
const publishEl = document.querySelector<HTMLButtonElement>("#board-publish")!;
const nickInput = document.querySelector<HTMLInputElement>("#nick")!;

/** Records affichés au plus ; le Worker en sert davantage (`BOARD`), pour qu'il en reste dix une fois les faux écartés. */
const SHOWN = 10;

/** Un record tel que le sert `GET /api/records/:défi`. */
interface Entry { id: string; name: string; ticks: number; film: string }

const seconds = (ticks: number): string =>
  `${(ticks / 60).toLocaleString("fr-FR", { minimumFractionDigits: 1, maximumFractionDigits: 1 })} s`;

const refusedLabel = (count: number): string =>
  count > 0 ? ` (${count} écarté${count > 1 ? "s" : ""} : rejeu qui ne gagne pas)` : "";

let judge: Worker | null = null;
const pending = new Map<string, (ok: boolean) => void>();

/** Rejoue un record dans le fil du juge ; false s'il ne tient pas, ou si le fil ne peut pas naître. */
function verify(c: Case): Promise<boolean> {
  if (!judge) {
    try {
      judge = new Worker(new URL("./sim/judge.ts", import.meta.url), { type: "module" });
    } catch {
      return Promise.resolve(false);
    }
    judge.onmessage = (e: MessageEvent<{ id: string; ok: boolean }>) => {
      pending.get(e.data.id)?.(e.data.ok);
      pending.delete(e.data.id);
    };
    // Un fil qui tombe ne répondra plus : rien de ce qu'il jugeait ne tient.
    judge.onerror = () => {
      for (const done of pending.values()) done(false);
      pending.clear();
      judge = null;
    };
  }
  const worker = judge;
  return new Promise((done) => {
    pending.set(c.id, done);
    worker.postMessage(c);
  });
}

/** Le défi affiché, et un numéro de passage : un classement plus récent rend caducs les verdicts de l'ancien. */
let shown = "";
let run = 0;

/** Affiche le classement du défi `challenge`, records vérifiés un à un. `watch` rejoue un record dans le bac. */
export async function show(challenge: string, watch: (rec: Recording) => void): Promise<void> {
  const mine = ++run;
  shown = challenge;
  boardEl.hidden = false;
  publishEl.hidden = true;
  listEl.replaceChildren();
  titleEl.textContent = `Classement — ${challenge} : chargement…`;
  const res = await fetch(`/api/records/${encodeURIComponent(challenge)}`).catch(() => null);
  const entries = res?.ok ? ((await res.json()) as Entry[]) : null;
  if (mine !== run) return;
  if (!entries) { titleEl.textContent = `Classement — ${challenge} : indisponible.`; return; }
  if (entries.length === 0) { titleEl.textContent = `Classement — ${challenge} : aucun record pour l'instant.`; return; }
  titleEl.textContent = `Classement — ${challenge} : vérification des rejeux…`;
  let kept = 0, refused = 0;
  for (const e of entries) {
    if (kept >= SHOWN) break;
    const ok = await verify({ id: e.id, challenge, ticks: e.ticks, film: e.film });
    if (mine !== run) return;
    if (!ok) { refused++; continue; }
    kept++;
    const li = document.createElement("li");
    li.textContent = `${e.name} — ${seconds(e.ticks)}`;
    const play = document.createElement("button");
    play.type = "button";
    play.textContent = "▶";
    play.title = "Voir le rejeu";
    play.addEventListener("click", () => void unpack(e.film).then((rec) => { if (rec) watch(rec); }));
    li.append(play);
    listEl.append(li);
  }
  titleEl.textContent = kept === 0
    ? `Classement — ${challenge} : aucun record ne tient.`
    : `Classement — ${challenge}${refusedLabel(refused)}`;
}

/** La partie à publier, après une victoire. */
let pendingFilm: { challenge: string; film: Recording; watch: (rec: Recording) => void } | null = null;

/** Défi gagné : propose de publier la partie, si le bac l'a jugée recevable (`fair()`), sinon dit pourquoi. */
export function won(challenge: string, film: Recording | null, watch: (rec: Recording) => void): void {
  if (challenge !== shown) void show(challenge, watch);
  if (!film) {
    pendingFilm = null;
    publishEl.hidden = true;
    titleEl.textContent = `Classement — ${challenge} : partie hors classement (annulée, collée, rejeu lancé ou plus de cinq minutes).`;
    return;
  }
  pendingFilm = { challenge, film, watch };
  publishEl.hidden = false;
  publishEl.disabled = false;
  publishEl.textContent = `Publier au classement (${seconds(film.ticks)})`;
}

publishEl.addEventListener("click", () => {
  const p = pendingFilm;
  if (!p) return;
  publishEl.disabled = true;
  void pack(p.film)
    .then((film) => fetch("/api/records", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ challenge: p.challenge, name: nickInput.value, ticks: p.film.ticks, film }),
    }))
    .catch(() => null)
    .then((res) => {
      if (!res?.ok) {
        publishEl.disabled = false;
        titleEl.textContent = `Classement — ${p.challenge} : publication refusée${res?.status === 429 ? " (trop de requêtes, réessayez dans une minute)" : ""}.`;
        return;
      }
      pendingFilm = null;
      void show(p.challenge, p.watch);
    });
});
