/**
 * Tout ce qui fait entrer ou sortir un monde : la sauvegarde dans la galerie
 * (la galerie elle-même est dans gallery.ts, chargée à sa première ouverture),
 * le lien partagé, l'image, la vidéo et le rejeu.
 *
 * Ce module ne connaît ni l'annulation ni les défis : `initShare()` reçoit les
 * deux gestes dont il a besoin (charger une grille, lancer un défi) plutôt que
 * d'importer main.ts, ce qui bouclerait.
 */
import { HEIGHT, WIDTH, askFilm, askGrid, canvas } from "./world.ts";
import { FILM_MAX, pack, parse, unpack, type Recording } from "./replay.ts";
import { EMPTY, MATERIALS, PALETTE } from "./sim/materials.ts";
import { type Challenge } from "./challenges.ts";
import { read, write } from "./ui.ts";

/**
 * Les mondes déposés depuis ce navigateur : `{ id: jeton }`. Le Worker rend le
 * jeton une seule fois, à la sauvegarde, et l'exige pour supprimer — c'est ce
 * qui remplace les comptes qu'on n'a pas. Perdu (autre machine, stockage vidé),
 * le monde n'est plus supprimable : le ménage nocturne finira par l'emporter.
 */
export const OWNED = "sandbox-rabbit:mondes";

export function owned(): Record<string, string> {
  try {
    return JSON.parse(read(OWNED) ?? "{}") as Record<string, string>;
  } catch {
    return {};
  }
}

/**
 * Le monde de la galerie qui est dans le bac, s'il y en a un : une sauvegarde
 * le donne comme parent (remix). Tout ce qui remplace le bac l'oublie
 * (`forgetOrigin()`, appelé par main.ts avec l'abandon du défi) — sinon un bac
 * vidé puis redessiné partait comme le remix d'un monde dont il ne restait rien.
 */
let origin: { id: string; name: string } | null = null;

export function forgetOrigin(): void {
  origin = null;
}

/** La galerie vient de charger ce monde : resauvegardé, le bac sera son remix. */
export function setOrigin(o: { id: string; name: string }): void {
  origin = o;
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

/** Les gestes reçus de main.ts, pour la galerie (gallery.ts), chargée plus tard. */
export const shareDeps = (): Deps => deps;

/** Recopie la frame courante dans la vidéo en cours, s'il y en a une. */
export function captureFrame(): void {
  if (recCtx) recCtx.drawImage(canvas, 0, 0, recCtx.canvas.width, recCtx.canvas.height);
}

const statusEl = document.querySelector<HTMLParagraphElement>("#status")!;

// La galerie (vignettes, recherche, votes) n'est chargée qu'à sa première
// ouverture : elle ne sert pas à ce qui s'affiche d'abord, et la page a un
// budget (84 Kio). Le clic qui la charge l'ouvre aussitôt après.
document.querySelector<HTMLButtonElement>("#gallery-open")!.addEventListener("click", () => {
  void import("./gallery.ts").then((g) => g.openGallery());
});
/**
 * Pourquoi une écriture a échoué. Sans réponse (réseau coupé, déploiement en
 * cours), la sauvegarde restait sur « Sauvegarde… » sans fin ; et un refus de
 * débit disait « échec » quand il suffit d'attendre une minute.
 */
export function failure(res: Response | null, what: string): string {
  if (!res) return `Échec de ${what} : serveur injoignable.`;
  if (res.status === 429) return "Trop de requêtes : réessayez dans une minute.";
  return `Échec de ${what}.`;
}


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
      parent: origin?.id ?? null,
    }),
  }).catch(() => null);
  if (!res?.ok) { statusEl.textContent = failure(res, "la sauvegarde"); return; }
  // Le jeton n'est rendu que là : gardé maintenant ou perdu pour de bon.
  const { id, token } = (await res.json()) as { id: string; token?: string };
  if (token) write(OWNED, JSON.stringify({ ...owned(), [id]: token }));
  const remix = origin ? ` Remix de « ${origin.name} ».` : "";
  statusEl.textContent = (alive
    ? "Sauvegardé — visible dans la galerie."
    : "Sauvegardé sans son état vivant (trop lourd) — visible dans la galerie.") + remix;
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
