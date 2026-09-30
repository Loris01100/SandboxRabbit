/**
 * Tout ce qui fait entrer ou sortir un monde : la galerie et l'API, la
 * sauvegarde, le lien partagé, l'image et la vidéo.
 *
 * Ce module ne connaît ni l'annulation ni les défis : `initShare()` reçoit les
 * deux gestes dont il a besoin (charger une grille, lancer un défi) plutôt que
 * d'importer main.ts, ce qui bouclerait.
 */
import { HEIGHT, WIDTH, askFilm, askGrid, canvas } from "./world.ts";
import { FILM_MAX, pack, parse, unpack, type Recording } from "./replay.ts";
import { thumbnail } from "./sim/render.ts";
import { decode } from "./sim/codec.ts";
import { EMPTY, MATERIALS, PALETTE } from "./sim/materials.ts";
import { type Challenge } from "./challenges.ts";
import { goalText, read, write } from "./ui.ts";

/**
 * Les mondes déposés depuis ce navigateur : `{ id: jeton }`. Le Worker rend le
 * jeton une seule fois, à la sauvegarde, et l'exige pour supprimer — c'est ce
 * qui remplace les comptes qu'on n'a pas. Perdu (autre machine, stockage vidé),
 * le monde n'est plus supprimable : le ménage nocturne finira par l'emporter.
 */
const OWNED = "sandbox-rabbit:mondes";

function owned(): Record<string, string> {
  try {
    return JSON.parse(read(OWNED) ?? "{}") as Record<string, string>;
  } catch {
    return {};
  }
}

export interface Deps {
  /**
   * Pose une grille encodée dans le bac, à sa taille (pile d'annulation
   * comprise). Renvoie false si elle n'a pas pu l'être — grille illisible ou
   * taille refusée : la galerie a déjà dit pourquoi, elle n'écrase pas.
   */
  load(data: string, width?: number): Promise<boolean>;
  /**
   * Démarre un défi : chrono et affichage du but. `goal` — l'objectif encodé
   * d'un monde de la galerie — arme en plus la condition de victoire du bac,
   * qui est seul à pouvoir la vérifier.
   */
  start(challenge: Challenge, goal?: string): void;
  /** Donne au bac un rejeu importé (lien, fichier), déjà validé, et le fait jouer. */
  watch(rec: Recording): void;
}

let deps: Deps;

export function initShare(hooks: Deps): void {
  deps = hooks;
}

/**
 * Défi bâti sur un monde partagé : la grille est déjà chargée, `build` n'a rien
 * à faire, et la condition de victoire est surveillée par le bac (on lui passe
 * l'objectif encodé). Il ne reste ici qu'un libellé et un chrono.
 */
function challengeOf(w: World, objective: string): Challenge {
  return { name: w.name, goal: objective, build: () => {}, won: () => false };
}

/** Recopie la frame courante dans la vidéo en cours, s'il y en a une. */
export function captureFrame(): void {
  if (recCtx) recCtx.drawImage(canvas, 0, 0, recCtx.canvas.width, recCtx.canvas.height);
}

const statusEl = document.querySelector<HTMLParagraphElement>("#status")!;
const galleryEl = document.querySelector<HTMLDialogElement>("#gallery")!;
const galleryGrid = document.querySelector<HTMLDivElement>("#gallery-grid")!;

interface World { id: string; name: string; createdAt: string; width: number; height: number; data: string; views: number; goal?: string | null }

/**
 * Galerie : une seule requête ramène les mondes avec leur grille, qui devient la
 * vignette. Ouverte en modale (`<dialog>`), le panneau est trop étroit pour
 * montrer des images.
 */
let worlds: World[] = [];

async function openGallery(): Promise<void> {
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

// Le tri se fait sur la liste déjà en main : elle est plafonnée à 100 mondes,
// inutile de redemander au Worker.
const sortInput = document.querySelector<HTMLSelectElement>("#gallery-sort")!;
sortInput.addEventListener("change", drawGallery);

function drawGallery(): void {
  const sorted = [...worlds].sort((a, b) =>
    sortInput.value === "views" ? (b.views ?? 0) - (a.views ?? 0) : b.createdAt.localeCompare(a.createdAt),
  );
  galleryGrid.replaceChildren(
    ...(sorted.length ? sorted.map(card) : [note("Aucun monde. « Sauvegarder » en dépose un.")]),
  );
}

function note(text: string): HTMLParagraphElement {
  const p = document.createElement("p");
  p.className = "hint";
  p.textContent = text;
  return p;
}

function card(w: World): HTMLDivElement {
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
  date.textContent = `${new Date(w.createdAt).toLocaleDateString("fr-FR")} · ${w.views ?? 0} vue${(w.views ?? 0) > 1 ? "s" : ""}`;
  button.append(name, date);

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
    const done = deps.load(fresh?.data ?? w.data, w.width);
    galleryEl.close();
    if (!(await done)) return;
    statusEl.textContent = fresh?.data
      ? `« ${w.name} » chargé.`
      : `« ${w.name} » chargé sans son état vivant (serveur injoignable).`;
    // Un monde porteur d'un objectif se joue comme un défi : la scène est déjà
    // en place, il ne reste que la condition à surveiller.
    if (objective) deps.start(challengeOf(w, objective), w.goal ?? undefined);
  });

  // Suppression : seulement les siens. Le bouton n'apparaît que si on a le
  // jeton rendu à la sauvegarde, et le Worker le redemande de toute façon.
  const token = owned()[w.id];
  slot.append(button);
  if (token) slot.append(del(w, token, slot));
  return slot;
}

/**
 * Pourquoi une écriture a échoué. Sans réponse (réseau coupé, déploiement en
 * cours), la sauvegarde restait sur « Sauvegarde… » sans fin ; et un refus de
 * débit disait « échec » quand il suffit d'attendre une minute.
 */
function failure(res: Response | null, what: string): string {
  if (!res) return `Échec de ${what} : serveur injoignable.`;
  if (res.status === 429) return "Trop de requêtes : réessayez dans une minute.";
  return `Échec de ${what}.`;
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

document.querySelector<HTMLButtonElement>("#gallery-open")!.addEventListener("click", () => void openGallery());

// Objectif facultatif : « au moins / moins de N cellules de X ». Deux
// comparaisons suffisent — « plus aucun X » s'écrit « moins de 1 ».
const goalOp = document.querySelector<HTMLSelectElement>("#goal-op")!;
const goalN = document.querySelector<HTMLInputElement>("#goal-n")!;
const goalId = document.querySelector<HTMLSelectElement>("#goal-id")!;
for (const id of PALETTE) {
  if (id === EMPTY) continue;
  goalId.append(new Option(MATERIALS[id].name, String(id)));
}

/** Plafond d'un monde côté Worker (`POST /api/worlds`, app.ts). */
const HEAVY = 200_000;

document.querySelector<HTMLButtonElement>("#save")!.addEventListener("click", async () => {
  // L'état vivant (vies, températures) fait l'essentiel du poids : un incendie
  // en 640×360 passait le plafond, et la sauvegarde échouait sans dire
  // pourquoi. On garde alors la matière et le figé — les deux premiers blocs du
  // codec, ce que reçoit déjà un invité de salon.
  let data = await askGrid();
  const alive = data.length <= HEAVY;
  if (!alive) data = data.split(".").slice(0, 2).join(".");
  if (data.length > HEAVY) {
    statusEl.textContent = "Monde trop chargé pour la galerie, même sans son état vivant.";
    return;
  }
  const name = prompt("Nom du monde ?", `bac-${new Date().toLocaleTimeString("fr-FR")}`);
  if (!name) return;
  statusEl.textContent = "Sauvegarde…";
  const res = await fetch("/api/worlds", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      name, width: WIDTH, height: HEIGHT, data,
      goal: goalOp.value ? `${goalOp.value}:${goalId.value}:${goalN.value}` : null,
    }),
  }).catch(() => null);
  if (!res?.ok) { statusEl.textContent = failure(res, "la sauvegarde"); return; }
  // Le jeton n'est rendu que là : gardé maintenant ou perdu pour de bon.
  const { id, token } = (await res.json()) as { id: string; token?: string };
  if (token) write(OWNED, JSON.stringify({ ...owned(), [id]: token }));
  statusEl.textContent = alive
    ? "Sauvegardé — visible dans la galerie."
    : "Sauvegardé sans son état vivant (trop lourd) — visible dans la galerie.";
});

// Partage : le monde entier tient dans l'URL (RLE + base64, ~1 ko). La largeur
// de la grille passe devant (« 320~… ») : sans elle, un bac 480 relu dans un
// bac 320 se décale d'une ligne à chaque rangée. Le `~` n'est pas échappé par
// `encodeURIComponent`, et le codec n'en produit jamais.
document.querySelector<HTMLButtonElement>("#share")!.addEventListener("click", async () => {
  location.hash = encodeURIComponent(`${WIDTH}~${await askGrid()}`);
  try {
    await navigator.clipboard.writeText(location.href);
    statusEl.textContent = "Lien copié.";
  } catch {
    statusEl.textContent = "Lien dans la barre d'adresse.";
  }
});

/* -------------------------------------------------------------------- rejeu */

// Un rejeu sort en lien ou en fichier. Le lien porte le JSON compressé
// (`pack()`), derrière un préfixe qui le distingue d'un monde (« 320~… ») ;
// le fichier, le JSON lisible. À l'entrée, `vet()` le passe au crible : c'est
// une partie qu'on n'a pas jouée, rejouée dans notre bac.
export const FILM_LINK = "rejeu~";

/** Le rejeu à exporter, ou null — la barre de statut dit alors comment en avoir un. */
async function film(): Promise<Recording | null> {
  const rec = await askFilm();
  if (!rec) statusEl.textContent = "Aucun rejeu : « Enregistrer », jouer, puis « Arrêter ».";
  return rec;
}

document.querySelector<HTMLButtonElement>("#film-link")!.addEventListener("click", async () => {
  const rec = await film();
  if (!rec) return;
  location.hash = FILM_LINK + (await pack(rec));
  const ko = Math.max(1, Math.round(location.href.length / 1024));
  try {
    await navigator.clipboard.writeText(location.href);
    statusEl.textContent = `Lien du rejeu copié (~${ko} ko).`;
  } catch {
    statusEl.textContent = `Lien du rejeu dans la barre d'adresse (~${ko} ko).`;
  }
});

document.querySelector<HTMLButtonElement>("#film-save")!.addEventListener("click", async () => {
  const rec = await film();
  if (!rec) return;
  download(new Blob([JSON.stringify(rec)], { type: "application/json" }), "rejeu.json");
  statusEl.textContent = "Rejeu téléchargé.";
});

const filmFile = document.querySelector<HTMLInputElement>("#film-file")!;
document.querySelector<HTMLButtonElement>("#film-open")!.addEventListener("click", () => filmFile.click());
filmFile.addEventListener("change", async () => {
  const file = filmFile.files?.[0];
  filmFile.value = ""; // sinon rouvrir le même fichier ne redéclenche rien
  if (!file) return;
  const rec = file.size > FILM_MAX ? null : parse(await file.text());
  if (!rec) { statusEl.textContent = "Rejeu illisible (fichier abîmé, trop lourd ou d'un autre format)."; return; }
  deps.watch(rec);
});

/** Un lien de rejeu à l'ouverture de la page (sans le préfixe `FILM_LINK`). */
export async function openFilmLink(text: string): Promise<void> {
  const rec = await unpack(text);
  if (!rec) { statusEl.textContent = "Lien de rejeu illisible (coupé ou abîmé)."; return; }
  deps.watch(rec);
}

/** Télécharge un blob sous un nom horodaté. */
function download(blob: Blob, extension: string): void {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `bac-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.${extension}`;
  a.click();
  // Révoquée trop tôt, l'URL annule le téléchargement chez Firefox.
  setTimeout(() => URL.revokeObjectURL(a.href), 0);
}

/** Le bac agrandi ×4 sans lissage : un rendu à la taille de la grille est illisible. */
function upscale(): HTMLCanvasElement {
  const big = document.createElement("canvas");
  big.width = WIDTH * 4;
  big.height = HEIGHT * 4;
  return big;
}

document.querySelector<HTMLButtonElement>("#png")!.addEventListener("click", () => {
  const big = upscale();
  const ctx = big.getContext("2d")!;
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(canvas, 0, 0, big.width, big.height);
  big.toBlob((blob) => blob && download(blob, "png"));
});

// Vidéo : `MediaRecorder` sur le flux d'un canvas, tout est natif. On filme la
// copie agrandie, pas le bac : un .webm de 320×180 ne se regarde pas.
// La boucle de rendu y recopie chaque frame tant que `recCtx` existe.
let recorder: MediaRecorder | null = null;
let recCtx: CanvasRenderingContext2D | null = null;
const recordButton = document.querySelector<HTMLButtonElement>("#record")!;

recordButton.addEventListener("click", () => {
  if (recorder) { recorder.stop(); return; }
  const big = upscale();
  const chunks: Blob[] = [];
  try {
    recorder = new MediaRecorder(big.captureStream(30), { mimeType: "video/webm" });
  } catch {
    statusEl.textContent = "Ce navigateur ne sait pas enregistrer de vidéo.";
    return;
  }
  recCtx = big.getContext("2d");
  if (recCtx) recCtx.imageSmoothingEnabled = false;
  recorder.addEventListener("dataavailable", (e) => chunks.push(e.data));
  recorder.addEventListener("stop", () => {
    recorder = null;
    recCtx = null;
    recordButton.textContent = "Vidéo";
    statusEl.textContent = "Vidéo téléchargée.";
    download(new Blob(chunks, { type: "video/webm" }), "webm");
  });
  recorder.start();
  recordButton.textContent = "■ Arrêter";
  statusEl.textContent = "Enregistrement…";
});
