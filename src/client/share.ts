/**
 * Tout ce qui fait entrer ou sortir un monde : la galerie et l'API, la
 * sauvegarde, le lien partagé, l'image et la vidéo.
 *
 * Ce module ne connaît ni l'annulation ni les défis : `initShare()` reçoit les
 * deux gestes dont il a besoin (charger une grille, lancer un défi) plutôt que
 * d'importer main.ts, ce qui bouclerait.
 */
import { HEIGHT, WIDTH, canvas, engine } from "./world.ts";
import { thumbnail } from "./sim/render.ts";
import { encode, decode } from "./sim/codec.ts";
import { EMPTY, MATERIALS, PALETTE } from "./sim/materials.ts";
import { count, type Challenge } from "./challenges.ts";
import { goalText, parseGoal } from "./ui.ts";

export interface Deps {
  /**
   * Pose une grille encodée dans le bac, à sa taille (pile d'annulation
   * comprise). Renvoie false si elle n'a pas pu l'être — grille illisible ou
   * taille refusée : la galerie a déjà dit pourquoi, elle n'écrase pas.
   */
  load(data: string, width?: number): boolean;
  /** Démarre un défi : chrono et affichage du but. */
  start(challenge: Challenge): void;
}

let deps: Deps;

export function initShare(hooks: Deps): void {
  deps = hooks;
}

/**
 * La grille **et** son état vivant : un incendie enregistré repart chaud.
 * Ça coûte ~20 caractères sur une scène au repos, ~1,8 ko en plein feu.
 */
export function snapshotData(): string {
  return encode(engine.cells, engine.frozen, engine.life, engine.temp);
}

/** Défi bâti sur un monde partagé : la grille est déjà chargée, `build` n'a rien à faire. */
function challengeOf(w: World, objective: string): Challenge {
  const { op, id, n } = parseGoal(w.goal)!;
  return {
    name: w.name,
    goal: objective,
    build: () => {},
    won: (e) => (op === "ge" ? count(e, id) >= n : count(e, id) < n),
  };
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

// Le tri se fait sur la liste déjà en main : elle est plafonnée à 50 mondes,
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
    // passage qui compte la vue. Injoignable, on se rabat sur la copie.
    const fresh = await fetch(`/api/worlds/${w.id}`).then((r) => r.json() as Promise<World>).catch(() => w);
    // Le monde emmène sa taille : le bac s'y met, plus de carte morte.
    const done = deps.load(fresh.data ?? w.data, w.width);
    galleryEl.close();
    if (!done) return;
    statusEl.textContent = `« ${w.name} » chargé.`;
    // Un monde porteur d'un objectif se joue comme un défi : la scène est déjà
    // en place, il ne reste que la condition à surveiller.
    if (objective) deps.start(challengeOf(w, objective));
  });

  // Suppression : rien ne protège les mondes des autres, comme la sauvegarde
  // n'identifie personne. ponytail: ajouter un jeton le jour où ça compte.
  const del = document.createElement("button");
  del.type = "button";
  del.className = "del";
  del.title = "Supprimer";
  del.textContent = "×";
  del.addEventListener("click", async () => {
    if (!confirm(`Supprimer « ${w.name} » ?`)) return;
    const res = await fetch(`/api/worlds/${w.id}`, { method: "DELETE" });
    if (res.ok) slot.remove();
    else statusEl.textContent = "Échec de la suppression.";
  });

  slot.append(button, del);
  return slot;
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

document.querySelector<HTMLButtonElement>("#save")!.addEventListener("click", async () => {
  const name = prompt("Nom du monde ?", `bac-${new Date().toLocaleTimeString("fr-FR")}`);
  if (!name) return;
  statusEl.textContent = "Sauvegarde…";
  const res = await fetch("/api/worlds", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      name, width: WIDTH, height: HEIGHT, data: snapshotData(),
      goal: goalOp.value ? `${goalOp.value}:${goalId.value}:${goalN.value}` : null,
    }),
  });
  statusEl.textContent = res.ok ? "Sauvegardé — visible dans la galerie." : "Échec de la sauvegarde.";
});

// Partage : le monde entier tient dans l'URL (RLE + base64, ~1 ko). La largeur
// de la grille passe devant (« 320~… ») : sans elle, un bac 480 relu dans un
// bac 320 se décale d'une ligne à chaque rangée. Le `~` n'est pas échappé par
// `encodeURIComponent`, et le codec n'en produit jamais.
document.querySelector<HTMLButtonElement>("#share")!.addEventListener("click", async () => {
  location.hash = encodeURIComponent(`${WIDTH}~${snapshotData()}`);
  try {
    await navigator.clipboard.writeText(location.href);
    statusEl.textContent = "Lien copié.";
  } catch {
    statusEl.textContent = "Lien dans la barre d'adresse.";
  }
});


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
