/**
 * La galerie : la liste des mondes déposés, leurs vignettes, la recherche par
 * nom, le tri, les « J'aime », les remix et la suppression des siens. Chargée
 * par share.ts à la première ouverture seulement (`import()`) : rien de tout
 * ça ne sert à ce qui s'affiche d'abord, et la page a un budget de 84 Kio.
 *
 * Ce qui sert aussi à la sauvegarde — les jetons des mondes déposés, l'origine
 * d'un remix, le message d'échec — reste dans share.ts.
 */
import { thumbnail } from "./sim/render.ts";
import { decode } from "./sim/codec.ts";
import { type Challenge } from "./challenges.ts";
import { goalText, matches, read, write } from "./ui.ts";
import { OWNED, failure, owned, setOrigin, shareDeps } from "./share.ts";

const statusEl = document.querySelector<HTMLParagraphElement>("#status")!;

/**
 * Les mondes pour lesquels ce navigateur a voté (`J'aime`), du plus ancien au
 * plus récent : le bouton reste allumé et ne revote pas. Le Worker ne s'en
 * souvient pas (pas de comptes) : c'est une politesse, pas un verrou.
 */
const VOTES = "sandbox-rabbit:votes";
/** Votes retenus au plus : ce qui dépasse oublie les plus anciens, sûrement déjà effacés par le ménage. */
const VOTES_MAX = 500;

function voted(): string[] {
  try {
    const list = JSON.parse(read(VOTES) ?? "[]") as unknown;
    return Array.isArray(list) ? list.filter((id): id is string => typeof id === "string") : [];
  } catch {
    return [];
  }
}

/**
 * Défi bâti sur un monde partagé : la grille est déjà chargée, `build` n'a rien
 * à faire, et la condition de victoire est surveillée par le bac (on lui passe
 * l'objectif encodé). Il ne reste ici qu'un libellé et un chrono.
 */
function challengeOf(w: World, objective: string): Challenge {
  return { name: w.name, goal: objective, build: () => {}, won: () => false };
}

const galleryEl = document.querySelector<HTMLDialogElement>("#gallery")!;
const galleryGrid = document.querySelector<HTMLDivElement>("#gallery-grid")!;

interface World {
  id: string; name: string; createdAt: string; width: number; height: number; data: string; views: number; goal?: string | null;
  /** Le monde dont celui-ci est un remix, s'il y en a un. */
  parent?: string | null;
  likes?: number;
}

/**
 * Galerie : une seule requête ramène les mondes avec leur grille, qui devient la
 * vignette. Ouverte en modale (`<dialog>`), le panneau est trop étroit pour
 * montrer des images.
 */
let worlds: World[] = [];

export async function openGallery(): Promise<void> {
  galleryEl.showModal();
  galleryGrid.replaceChildren(note("Chargement…"));
  try {
    const list = await (await fetch("/api/worlds")).json();
    if (!Array.isArray(list)) throw new Error("liste inattendue");
    worlds = list;
  } catch {
    galleryGrid.replaceChildren(note("API injoignable."));
    return;
  }
  drawGallery();
}

// Le tri et la recherche se font sur la liste déjà en main : elle est
// plafonnée (150 mondes au plus), inutile de redemander au Worker.
const sortInput = document.querySelector<HTMLSelectElement>("#gallery-sort")!;
sortInput.addEventListener("change", drawGallery);
const searchInput = document.querySelector<HTMLInputElement>("#gallery-search")!;
searchInput.addEventListener("input", drawGallery);
// Entrée dans la recherche validerait le <form method="dialog"> et fermerait la galerie.
searchInput.addEventListener("keydown", (e) => { if (e.key === "Enter") e.preventDefault(); });

const ORDER: Record<string, (a: World, b: World) => number> = {
  views: (a, b) => (b.views ?? 0) - (a.views ?? 0),
  likes: (a, b) => (b.likes ?? 0) - (a.likes ?? 0),
};
const newest = (a: World, b: World): number => b.createdAt.localeCompare(a.createdAt);

function drawGallery(): void {
  const by = ORDER[sortInput.value];
  const shown = worlds
    .filter((w) => matches(w.name, searchInput.value))
    .sort((a, b) => (by ? by(a, b) : 0) || newest(a, b));
  // Remix : le nom du parent et le nombre d'enfants, lus dans la liste en main.
  const names = new Map(worlds.map((w) => [w.id, w.name]));
  const children = new Map<string, number>();
  for (const w of worlds) if (w.parent) children.set(w.parent, (children.get(w.parent) ?? 0) + 1);
  const empty = worlds.length ? "Aucun monde ne porte ce nom." : "Aucun monde. « Sauvegarder » en dépose un.";
  galleryGrid.replaceChildren(
    ...(shown.length ? shown.map((w) => card(w, names, children.get(w.id) ?? 0)) : [note(empty)]),
  );
}

function note(text: string): HTMLParagraphElement {
  const p = document.createElement("p");
  p.className = "hint";
  p.textContent = text;
  return p;
}

function card(w: World, names: Map<string, string>, remixes: number): HTMLDivElement {
  const slot = document.createElement("div");
  slot.className = "slot";
  const button = document.createElement("button");
  button.type = "button";
  button.className = "card";
  const name = document.createElement("span");
  name.className = "name";
  const objective = goalText(w.goal);
  name.textContent = objective ? `🎯 ${w.name}` : w.name; // textContent : le nom vient d'un autre visiteur
  if (objective) button.title = objective;
  const date = document.createElement("span");
  date.className = "date";
  date.textContent = `${new Date(w.createdAt).toLocaleDateString("fr-FR")} · ${w.views ?? 0} vue${(w.views ?? 0) > 1 ? "s" : ""}`
    + (remixes ? ` · ${remixes} remix` : "");
  button.append(name, date);
  if (w.parent) {
    const from = document.createElement("span");
    from.className = "remix";
    const parent = names.get(w.parent);
    from.textContent = parent === undefined ? "↳ remix d'un monde disparu" : `↳ remix de « ${parent} »`;
    button.append(from);
  }

  // La grille sert deux fois : à dessiner la vignette, puis à charger le monde.
  try {
    button.prepend(thumbnail(decode(w.data, w.width * w.height), w.width, w.height));
  } catch {
    button.title = "Monde illisible";
  }
  button.addEventListener("click", async () => {
    // On charge par l'API plutôt que par la copie déjà en main : c'est ce
    // passage qui compte la vue, et la copie n'a que la matière. Supprimé
    // depuis l'ouverture de la galerie, le monde ne se charge plus ;
    // injoignable, on se rabat sur la copie et on le dit.
    const res = await fetch(`/api/worlds/${w.id}`).catch(() => null);
    if (res?.status === 404) {
      worlds = worlds.filter((x) => x !== w);
      slot.replaceChildren(note(`« ${w.name} » a été supprimé.`));
      return;
    }
    const fresh = res?.ok ? ((await res.json().catch(() => null)) as World | null) : null;
    // Le monde emmène sa taille : le bac s'y met, plus de carte morte.
    const done = shareDeps().load(fresh?.data ?? w.data, w.width);
    galleryEl.close();
    if (!(await done)) return;
    statusEl.textContent = fresh?.data
      ? `« ${w.name} » chargé.`
      : `« ${w.name} » chargé sans son état vivant (serveur injoignable).`;
    // Un monde porteur d'un objectif se joue comme un défi : la scène est déjà
    // en place, il ne reste que la condition à surveiller.
    if (objective) shareDeps().start(challengeOf(w, objective), w.goal ?? undefined);
    // Après le chargement, qui a oublié l'origine précédente : resauvegardé,
    // ce bac sera un remix de celui-ci.
    setOrigin({ id: w.id, name: w.name });
  });

  // Suppression : seulement les siens. Le bouton n'apparaît que si on a le
  // jeton rendu à la sauvegarde, et le Worker le redemande de toute façon.
  const token = owned()[w.id];
  slot.append(button, like(w));
  if (token) slot.append(del(w, token, slot));
  return slot;
}

/** Le bouton « J'aime » d'une carte : un vote par monde et par navigateur. */
function like(w: World): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "like";
  const show = (): void => {
    const mine = voted().includes(w.id);
    button.textContent = `${mine ? "♥" : "♡"} ${w.likes ?? 0}`;
    button.title = mine ? "Vous aimez ce monde" : "J'aime";
    button.disabled = mine;
  };
  show();
  button.addEventListener("click", async () => {
    button.disabled = true;
    const res = await fetch(`/api/worlds/${w.id}/like`, { method: "POST" }).catch(() => null);
    if (!res?.ok) {
      statusEl.textContent = res?.status === 404 ? `« ${w.name} » a été supprimé.` : failure(res, "du vote");
      button.disabled = false;
      return;
    }
    const { likes } = (await res.json()) as { likes: number };
    w.likes = likes;
    write(VOTES, JSON.stringify([...voted(), w.id].slice(-VOTES_MAX)));
    show();
  });
  return button;
}

function del(w: World, token: string, slot: HTMLDivElement): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "del";
  button.title = "Supprimer";
  button.textContent = "×";
  button.addEventListener("click", async () => {
    if (!confirm(`Supprimer « ${w.name} » ?`)) return;
    const res = await fetch(`/api/worlds/${w.id}`, { method: "DELETE", headers: { "x-world-token": token } }).catch(() => null);
    if (!res?.ok) { statusEl.textContent = failure(res, "la suppression"); return; }
    slot.remove();
    const mine = owned();
    delete mine[w.id];
    write(OWNED, JSON.stringify(mine));
  });
  return button;
}

