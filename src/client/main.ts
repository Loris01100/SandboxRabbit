import "./style.css";
import { Engine } from "./sim/engine.ts";
import { Renderer, thumbnail } from "./sim/render";
import { decode, decodeFrozen, encode } from "./sim/codec";
import { CATEGORIES, EMPTY, MAGNET, MATERIALS, PALETTE, SAND, SHORTCUTS, SOURCE, STONE, SWITCH, WATER, type MaterialId } from "./sim/materials.ts";
import { CHALLENGES, count, type Challenge } from "./challenges.ts";

// La taille de la grille est un réglage : `Engine` et `Renderer` sont recréés
// à chaque changement (le rendu écrit dans un ImageData de la taille exacte).
let WIDTH = 320;
let HEIGHT = 180;

const canvas = document.querySelector<HTMLCanvasElement>("#world")!;
let engine = new Engine(WIDTH, HEIGHT);
let renderer = new Renderer(canvas, engine);

let current: MaterialId = SAND;
let brush = 5;
let running = true;

/* ---------------------------------------------------------------- palette */

const paletteEl = document.querySelector<HTMLDivElement>("#palette")!;
const hintEl = document.querySelector<HTMLParagraphElement>("#hint")!;

// Une famille = un <details> repliable (natif) contenant sa grille de boutons.
for (const [n, cat] of CATEGORIES.entries()) {
  const box = document.createElement("details");
  box.className = "cat";
  box.open = n === 0; // seule la première famille est déployée au départ
  const title = document.createElement("summary");
  title.textContent = cat.name;
  const grid = document.createElement("div");
  grid.className = "palette";
  for (const id of cat.ids) grid.append(swatch(id));
  box.append(title, grid);
  paletteEl.append(box);
}

function swatch(id: MaterialId): HTMLButtonElement {
  const m = MATERIALS[id];
  const button = document.createElement("button");
  button.type = "button";
  button.dataset.id = String(id);
  button.setAttribute("aria-pressed", String(id === current));
  button.innerHTML = `<span class="swatch" style="background:rgb(${m.color.join(",")})"></span>${m.name}`;
  button.addEventListener("click", () => select(id));
  button.addEventListener("pointerenter", () => (hintEl.textContent = m.hint));
  return button;
}
paletteEl.addEventListener("pointerleave", () => (hintEl.textContent = MATERIALS[current].hint));

function select(id: MaterialId): void {
  current = id;
  // Une source crache la dernière matière choisie avant elle.
  if (id !== SOURCE && id !== EMPTY) engine.emit = id;
  hintEl.textContent = MATERIALS[id].hint;
  for (const b of paletteEl.querySelectorAll("button")) {
    b.setAttribute("aria-pressed", String(Number(b.dataset.id) === id));
  }
}
select(current);

// Raccourcis : 1..9 puis 0 pour la gomme.
addEventListener("keydown", (e) => {
  if (e.key === " ") { toggleRun(); e.preventDefault(); return; }
  if ((e.ctrlKey || e.metaKey) && (e.key === "y" || (e.key === "Z" && e.shiftKey))) { redo(); e.preventDefault(); return; }
  if (e.key === "z" && (e.ctrlKey || e.metaKey)) { undo(); e.preventDefault(); return; }
  const n = Number(e.key);
  if (!Number.isNaN(n) && SHORTCUTS[n - 1] !== undefined) select(SHORTCUTS[n - 1]);
  if (e.key === "0") select(EMPTY);
  if (e.key === "g") flipGravity();
  if (e.key === "f") toolInput.value = toolInput.value === "paint" ? "freeze" : "paint";
  if (e.key === "h") { heatmapInput.checked = !heatmapInput.checked; renderer.heatmap = heatmapInput.checked; }
});

/* ------------------------------------------------------------------ souris */

let painting = false;
let last: { x: number; y: number } | null = null;

function toCell(e: PointerEvent): { x: number; y: number } {
  const r = canvas.getBoundingClientRect();
  return {
    x: Math.floor(((e.clientX - r.left) / r.width) * WIDTH),
    y: Math.floor(((e.clientY - r.top) / r.height) * HEIGHT),
  };
}

/** Un coup de pinceau, plus son reflet si la symétrie est cochée. */
function paintAt(x: number, y: number): void {
  dab(x, y);
  if (mirrorInput.checked) dab(WIDTH - 1 - x, y);
}

/* ------------------------------------------------------------- vue (zoom) */

// Le canvas est transformé en CSS : `toCell()` passe par `getBoundingClientRect()`,
// qui tient déjà compte du zoom et du décalage — rien à corriger ailleurs.
// ponytail: pas de bornes sur le décalage, on peut pousser le bac hors du cadre
// (la molette à fond inverse remet tout d'aplomb).
let zoom = 1;
let panX = 0;
let panY = 0;
let panning = false;

function applyView(): void {
  canvas.style.transformOrigin = "0 0";
  canvas.style.transform = zoom === 1 ? "" : `translate(${panX}px, ${panY}px) scale(${zoom})`;
}

/**
 * Zoome autour d'un point de l'écran, qui ne bouge pas. La boîte non
 * transformée se déduit de la boîte affichée : origine `r.left - panX`,
 * largeur `r.width / zoom`.
 */
function zoomAt(clientX: number, clientY: number, next: number): void {
  const r = canvas.getBoundingClientRect();
  const fx = (clientX - r.left) / r.width;
  const fy = (clientY - r.top) / r.height;
  panX = clientX - (r.left - panX) - fx * (r.width / zoom) * next;
  panY = clientY - (r.top - panY) - fy * (r.height / zoom) * next;
  zoom = next;
  if (zoom === 1) { panX = 0; panY = 0; }
  applyView();
}

const clampZoom = (z: number): number => Math.min(12, Math.max(1, z));

canvas.addEventListener("wheel", (e) => {
  e.preventDefault();
  zoomAt(e.clientX, e.clientY, clampZoom(zoom * (e.deltaY < 0 ? 1.2 : 1 / 1.2)));
}, { passive: false });

// Pincement : la molette n'existe pas sur mobile, tout le reste y marche déjà.
// Deux doigts posés = on ne peint plus, on manipule la vue (zoom + déplacement).
const touches = new Map<number, { x: number; y: number }>();
let pinch: { gap: number; x: number; y: number } | null = null;

/** Écart et milieu des deux doigts posés. */
function span(): { gap: number; x: number; y: number } {
  const [a, b] = [...touches.values()];
  return { gap: Math.hypot(a.x - b.x, a.y - b.y), x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

// Clic du milieu : déplacer la vue. `translate` précède `scale`, donc un pixel
// de souris vaut un pixel d'écran, quel que soit le zoom.
canvas.addEventListener("auxclick", (e) => e.preventDefault());

/** Les liquides et gaz sont déposés en pointillé, sinon on en crée trop d'un coup. */
function dab(x: number, y: number): void {
  if (toolInput.value !== "paint") {
    engine.setFrozen(x, y, brush, toolInput.value === "freeze");
    return;
  }
  const kind = MATERIALS[current].kind;
  const density = kind === "liquid" || kind === "gas" ? 0.35 : 1;
  // Gomme sélective : on n'efface que la dernière matière choisie avant la gomme.
  const only = current === EMPTY && onlyInput.checked ? engine.emit : undefined;
  engine.paint(x, y, brush, current, density, !keepInput.checked, only);
  // Invité d'un salon : c'est l'hôte qui fait foi, il faut lui repasser le geste.
  if (socket?.readyState === WebSocket.OPEN && !host) {
    socket.send(JSON.stringify({ type: "paint", x, y, r: brush, id: current, density }));
  }
}

/** Trace un segment de cellules (geste rapide, ou ligne droite au Maj). */
function strokeTo(from: { x: number; y: number }, to: { x: number; y: number }): void {
  const steps = Math.max(Math.abs(to.x - from.x), Math.abs(to.y - from.y));
  for (let s = 1; s < steps; s++) {
    paintAt(
      Math.round(from.x + ((to.x - from.x) * s) / steps),
      Math.round(from.y + ((to.y - from.y) * s) / steps),
    );
  }
  paintAt(to.x, to.y);
}

// Le clic droit sert au remplissage : pas de menu contextuel sur le bac.
canvas.addEventListener("contextmenu", (e) => e.preventDefault());

canvas.addEventListener("pointerdown", (e) => {
  if (e.pointerType === "touch") {
    touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (touches.size === 2) {
      painting = false; // le second doigt annule le trait en cours
      pinch = span();
      return;
    }
  }
  if (e.button === 1) {
    panning = true;
    canvas.setPointerCapture(e.pointerId);
    e.preventDefault();
    return;
  }
  const p = toCell(e);
  // Pipette : Alt+clic reprend la matière sous le curseur, sans rien modifier.
  if (e.altKey) { select(engine.get(p.x, p.y) as MaterialId); return; }
  snapshot();
  if (e.button === 2) { engine.fill(p.x, p.y, current); return; }
  // Cliquer un interrupteur (ou un aimant) déjà posé le bascule au lieu d'en reposer un.
  if (current === SWITCH && engine.get(p.x, p.y) === SWITCH) { engine.toggleSwitch(p.x, p.y); return; }
  if (current === MAGNET && engine.get(p.x, p.y) === MAGNET) { engine.toggleMagnet(p.x, p.y); return; }
  canvas.setPointerCapture(e.pointerId);
  painting = true;
  // Maj : on relie le dernier point posé, même si le pinceau a été relâché entre-temps.
  if (e.shiftKey && last) strokeTo(last, p);
  else paintAt(p.x, p.y);
  last = p;
});

const probeEl = document.querySelector<HTMLSpanElement>("#probe")!;

/** Matière et température sous le curseur : c'est ce qui rend la vue thermique lisible. */
function probe(p: { x: number; y: number }): void {
  if (!engine.inBounds(p.x, p.y)) { probeEl.textContent = "–"; return; }
  const i = engine.index(p.x, p.y);
  probeEl.textContent = `${MATERIALS[engine.cells[i]].name} · ${Math.round(engine.temp[i])} °C`;
}

canvas.addEventListener("pointermove", (e) => {
  if (e.pointerType === "touch" && touches.has(e.pointerId)) {
    touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (touches.size === 2 && pinch) {
      const now = span();
      // Le milieu des doigts déplace la vue, leur écartement la zoome autour de
      // ce même milieu : un seul geste pour les deux.
      panX += now.x - pinch.x;
      panY += now.y - pinch.y;
      applyView();
      zoomAt(now.x, now.y, clampZoom(zoom * (now.gap / pinch.gap)));
      pinch = now;
      return;
    }
  }
  if (panning) {
    panX += e.movementX;
    panY += e.movementY;
    applyView();
    return;
  }
  const at = toCell(e);
  probe(at);
  if (!painting) return;
  const p = at;
  // Interpolation : à 60 fps un geste rapide saute des dizaines de cellules.
  if (last) strokeTo(last, p);
  else paintAt(p.x, p.y);
  last = p;
});

for (const type of ["pointerup", "pointercancel", "pointerleave"] as const) {
  // `last` est conservé : c'est l'ancre de la ligne droite au Maj.
  canvas.addEventListener(type, (e) => {
    painting = false;
    panning = false;
    touches.delete((e as PointerEvent).pointerId);
    if (touches.size < 2) pinch = null;
  });
}
canvas.addEventListener("pointerleave", () => (probeEl.textContent = "–"));

/* ----------------------------------------------------------------- annuler */

// Une copie des quatre tableaux avant chaque geste destructeur, dix crans
// gardés (~230 ko le cran, `temp` étant en Float32 : 2,3 Mo au plus).
const UNDO_MAX = 10;
type Snapshot = { cells: Uint8Array; life: Uint8Array; temp: Float32Array; frozen: Uint8Array };
const undoStack: Snapshot[] = [];
const redoStack: Snapshot[] = [];

function capture(): Snapshot {
  return {
    cells: engine.cells.slice(),
    life: engine.life.slice(),
    temp: engine.temp.slice(),
    frozen: engine.frozen.slice(),
  };
}

function restore(state: Snapshot): void {
  engine.cells.set(state.cells);
  engine.life.set(state.life);
  engine.temp.set(state.temp);
  engine.frozen.set(state.frozen);
}

function snapshot(): void {
  undoStack.push(capture());
  if (undoStack.length > UNDO_MAX) undoStack.shift();
  redoStack.length = 0; // un nouveau geste referme la branche annulée
}

/** Dépile d'un côté en empilant de l'autre : annuler et rétablir sont le même geste. */
function jump(from: Snapshot[], to: Snapshot[], done: string, empty: string): void {
  const state = from.pop();
  if (!state) { statusEl.textContent = empty; return; }
  to.push(capture());
  restore(state);
  const left = from.length;
  statusEl.textContent = `${done} (${left} cran${left > 1 ? "s" : ""} restant${left > 1 ? "s" : ""}).`;
}

const undo = (): void => jump(undoStack, redoStack, "Annulé", "Rien à annuler.");
const redo = (): void => jump(redoStack, undoStack, "Rétabli", "Rien à rétablir.");

document.querySelector<HTMLButtonElement>("#undo")!.addEventListener("click", undo);
document.querySelector<HTMLButtonElement>("#redo")!.addEventListener("click", redo);

/* ----------------------------------------------------------------- réglages */

const brushInput = document.querySelector<HTMLInputElement>("#brush")!;
const brushValue = document.querySelector<HTMLOutputElement>("#brush-value")!;
brushInput.addEventListener("input", () => {
  brush = Number(brushInput.value);
  brushValue.value = brushInput.value;
});

const keepInput = document.querySelector<HTMLInputElement>("#keep")!;
const onlyInput = document.querySelector<HTMLInputElement>("#only")!;
const mirrorInput = document.querySelector<HTMLInputElement>("#mirror")!;
const toolInput = document.querySelector<HTMLSelectElement>("#tool")!;

/** Ticks de simulation par frame : 0,25 (ralenti) à 4 (accéléré). */
let speed = 1;
const speedInput = document.querySelector<HTMLInputElement>("#speed")!;
const speedValue = document.querySelector<HTMLOutputElement>("#speed-value")!;
speedInput.addEventListener("input", () => {
  speed = Number(speedInput.value) / 4;
  speedValue.value = `×${speed.toLocaleString("fr-FR")}`;
});

const windInput = document.querySelector<HTMLInputElement>("#wind")!;
const windValue = document.querySelector<HTMLOutputElement>("#wind-value")!;
windInput.addEventListener("input", () => {
  engine.wind = Number(windInput.value) / 10;
  windValue.value = windInput.value;
});

// Climat de la scène : tout retourne à cette température (hiver, four…).
const ambientInput = document.querySelector<HTMLInputElement>("#ambient")!;
const ambientValue = document.querySelector<HTMLOutputElement>("#ambient-value")!;
ambientInput.addEventListener("input", () => {
  engine.ambient = Number(ambientInput.value);
  ambientValue.value = `${ambientInput.value} °C`;
});

/**
 * Change la taille de la grille. Tout est refait — `Engine`, `Renderer`, le
 * canvas — en reportant les réglages du monde ; les piles d'annulation partent,
 * leurs tableaux n'ont plus la bonne longueur. `keep` évite de regraîner quand
 * la grille reçue d'un hôte impose sa taille.
 */
function resize(width: number, height: number, keep = false): void {
  const { wind, ambient, gravity, emit } = engine;
  WIDTH = width;
  HEIGHT = height;
  engine = new Engine(width, height);
  Object.assign(engine, { wind, ambient, gravity, emit });
  renderer = new Renderer(canvas, engine);
  renderer.heatmap = heatmapInput.checked;
  undoStack.length = 0;
  redoStack.length = 0;
  zoom = 1;
  panX = 0;
  panY = 0;
  applyView();
  if (!keep) seed();
}

const sizeInput = document.querySelector<HTMLSelectElement>("#size")!;
sizeInput.addEventListener("input", () => {
  const w = Number(sizeInput.value);
  resize(w, (w * 9) / 16);
});

const heatmapInput = document.querySelector<HTMLInputElement>("#heatmap")!;
heatmapInput.addEventListener("change", () => (renderer.heatmap = heatmapInput.checked));

// Réglages retenus d'une visite à l'autre. On rejoue l'événement "input" plutôt
// que de dupliquer les handlers ci-dessus.
// ponytail: un blob JSON sans version — un réglage renommé repart au défaut.
const SETTINGS = "sandbox-rabbit:reglages";
function remember(): void {
  localStorage.setItem(SETTINGS, JSON.stringify({
    current, brush: brushInput.value, speed: speedInput.value, wind: windInput.value,
    ambient: ambientInput.value, size: sizeInput.value,
  }));
}
for (const el of [brushInput, speedInput, windInput, ambientInput, sizeInput]) el.addEventListener("input", remember);
paletteEl.addEventListener("click", remember);

const saved = JSON.parse(localStorage.getItem(SETTINGS) ?? "null");
if (saved) {
  if (MATERIALS[saved.current as MaterialId]) select(saved.current as MaterialId);
  for (const [el, value] of [[brushInput, saved.brush], [speedInput, saved.speed], [windInput, saved.wind], [ambientInput, saved.ambient], [sizeInput, saved.size]] as const) {
    if (value === undefined) continue; // réglage absent d'une version précédente
    el.value = value;
    el.dispatchEvent(new Event("input"));
  }
}

const gravityButton = document.querySelector<HTMLButtonElement>("#gravity")!;
function flipGravity(): void {
  engine.gravity = engine.gravity === 1 ? -1 : 1;
  gravityButton.textContent = engine.gravity === 1 ? "Vers le bas ↓" : "Vers le haut ↑";
}
gravityButton.addEventListener("click", flipGravity);

const playButton = document.querySelector<HTMLButtonElement>("#play")!;
function toggleRun(): void {
  running = !running;
  playButton.textContent = running ? "Pause" : "Reprendre";
}
playButton.addEventListener("click", toggleRun);

document.querySelector<HTMLButtonElement>("#step")!.addEventListener("click", () => {
  running = false;
  playButton.textContent = "Reprendre";
  engine.step();
});

// Plein écran natif : le CSS `pixelated` fait la mise à l'échelle, le rendu ne
// change pas d'un pixel et `getBoundingClientRect()` suit le pinceau.
document.querySelector<HTMLButtonElement>("#full")!.addEventListener("click", () => {
  if (document.fullscreenElement) void document.exitFullscreen();
  else void canvas.requestFullscreen();
});

document.querySelector<HTMLButtonElement>("#clear")!.addEventListener("click", () => { snapshot(); engine.clear(); });

/* -------------------------------------------------------------- mondes/API */

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
    worlds = await (await fetch("/api/worlds")).json();
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
  const usable = w.width === WIDTH && w.height === HEIGHT;
  try {
    button.prepend(thumbnail(decode(w.data, w.width * w.height), w.width, w.height));
    if (!usable) button.title = "Taille de grille incompatible";
  } catch {
    button.title = "Monde illisible";
  }
  button.addEventListener("click", async () => {
    if (!usable) return;
    // On charge par l'API plutôt que par la copie déjà en main : c'est ce
    // passage qui compte la vue. Injoignable, on se rabat sur la copie.
    const fresh = await fetch(`/api/worlds/${w.id}`).then((r) => r.json() as Promise<World>).catch(() => w);
    load(fresh.data ?? w.data);
    galleryEl.close();
    statusEl.textContent = `« ${w.name} » chargé.`;
    // Un monde porteur d'un objectif se joue comme un défi : la scène est déjà
    // en place, il ne reste que la condition à surveiller.
    if (objective) startChallenge(challengeOf(w, objective));
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

/** Texte lisible d'un objectif encodé, ou null s'il n'en est pas un. */
function goalText(goal: string | null | undefined): string | null {
  const m = /^(ge|lt):(\d+):(\d+)$/.exec(goal ?? "");
  if (!m || !MATERIALS[Number(m[2])]) return null;
  return `${m[1] === "ge" ? "Au moins" : "Moins de"} ${m[3]} cellules de ${MATERIALS[Number(m[2])].name}`;
}

document.querySelector<HTMLButtonElement>("#save")!.addEventListener("click", async () => {
  const name = prompt("Nom du monde ?", `bac-${new Date().toLocaleTimeString("fr-FR")}`);
  if (!name) return;
  statusEl.textContent = "Sauvegarde…";
  const res = await fetch("/api/worlds", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      name, width: WIDTH, height: HEIGHT, data: encode(engine.cells, engine.frozen),
      goal: goalOp.value ? `${goalOp.value}:${goalId.value}:${goalN.value}` : null,
    }),
  });
  statusEl.textContent = res.ok ? "Sauvegardé — visible dans la galerie." : "Échec de la sauvegarde.";
});

/** Charge une grille encodée (API ou lien partagé). */
function load(data: string): void {
  snapshot();
  engine.cells.set(decode(data, WIDTH * HEIGHT));
  engine.frozen.set(decodeFrozen(data, WIDTH * HEIGHT));
  engine.life.fill(0);
  engine.temp.fill(engine.ambient);
}

// Partage : le monde entier tient dans l'URL (RLE + base64, ~1 ko).
document.querySelector<HTMLButtonElement>("#share")!.addEventListener("click", async () => {
  location.hash = encodeURIComponent(encode(engine.cells, engine.frozen));
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
  URL.revokeObjectURL(a.href);
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


/* ------------------------------------------------------------- bac partagé */

/*
 * Un salon = un Durable Object qui ne fait que relayer (src/worker/room.ts).
 * L'hôte est le seul à simuler : il diffuse sa grille quatre fois par seconde,
 * les invités lui envoient leurs coups de pinceau et affichent ce qu'ils
 * reçoivent — un seul simulateur, donc rien à réconcilier.
 * ponytail: pas d'identité ni de verrou, qui entre peint. Et seul le pinceau
 * est relayé : figer, gommer sélectivement ou vider restent locaux.
 */
const roomButton = document.querySelector<HTMLButtonElement>("#room")!;
let socket: WebSocket | null = null;
let host = false;
let beat = 0;

/** Grille reçue de l'hôte : posée sans passer par la pile d'annulation (4 par seconde). */
function applyGrid(data: string, w: number, h: number): void {
  if (w !== WIDTH || h !== HEIGHT) {
    resize(w, h, true);
    sizeInput.value = String(w);
  }
  engine.cells.set(decode(data, w * h));
  engine.frozen.set(decodeFrozen(data, w * h));
}

function leaveRoom(): void {
  clearInterval(beat);
  socket = null;
  host = false;
  roomButton.textContent = "Bac partagé";
}

roomButton.addEventListener("click", () => {
  if (socket) { socket.close(); return; }
  const name = prompt("Nom du salon ?", "public");
  if (!name) return;
  const ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/api/room/${encodeURIComponent(name)}`);
  socket = ws;
  roomButton.textContent = "Quitter le salon";
  statusEl.textContent = `Connexion au salon « ${name} »…`;

  ws.addEventListener("message", (e) => {
    const msg = JSON.parse(e.data as string);
    if (msg.type === "role") {
      host = msg.host;
      // Un invité ne simule pas : sa grille est écrasée quatre fois par seconde.
      running = host;
      playButton.textContent = running ? "Pause" : "Reprendre";
      statusEl.textContent = host
        ? `Salon « ${name} » — vous simulez pour tout le monde.`
        : `Salon « ${name} » — vous suivez l'hôte.`;
    }
    if (msg.type === "grid" && !host) applyGrid(msg.data, msg.width, msg.height);
    if (msg.type === "paint" && host) engine.paint(msg.x, msg.y, msg.r, msg.id, msg.density);
  });
  ws.addEventListener("close", () => {
    leaveRoom();
    statusEl.textContent = "Salon quitté.";
  });
  ws.addEventListener("error", () => {
    leaveRoom();
    statusEl.textContent = "Salon injoignable.";
  });

  beat = setInterval(() => {
    if (host && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "grid", width: WIDTH, height: HEIGHT, data: encode(engine.cells, engine.frozen) }));
    }
  }, 250);
});

/* -------------------------------------------------------------------- défis */

const goalEl = document.querySelector<HTMLParagraphElement>("#goal")!;
const challengesEl = document.querySelector<HTMLDivElement>("#challenges")!;
let challenge: Challenge | null = null;
/** Horloge murale : la pause et le ralenti comptent aussi, c'est un chrono de joueur. */
let startedAt = 0;

// Meilleur temps par défi, en secondes. ponytail: local à la machine, pas de classement.
const RECORDS = "sandbox-rabbit:records";
const records: Record<string, number> = JSON.parse(localStorage.getItem(RECORDS) ?? "{}");
const best = (name: string): string => (records[name] === undefined ? "" : ` (record : ${records[name]} s)`);

/** Défi bâti sur un monde partagé : la grille est déjà chargée, `build` n'a rien à faire. */
function challengeOf(w: World, objective: string): Challenge {
  const [op, id, n] = w.goal!.split(":");
  const material = Number(id);
  const target = Number(n);
  return {
    name: w.name,
    goal: objective,
    build: () => {},
    won: (e) => (op === "ge" ? count(e, material) >= target : count(e, material) < target),
  };
}

/** Lance le chrono et affiche le but. Commun aux défis livrés et aux mondes-défis. */
function startChallenge(c: Challenge): void {
  challenge = c;
  startedAt = performance.now();
  goalEl.textContent = `${c.name} — ${c.goal}${best(c.name)}`;
}

for (const c of CHALLENGES) {
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = c.name;
  button.addEventListener("click", () => {
    // Les scènes sont écrites en dur pour 320×180 : on y revient si besoin.
    if (WIDTH !== 320) { resize(320, 180, true); sizeInput.value = "320"; }
    snapshot();
    engine.clear();
    c.build(engine);
    startChallenge(c);
  });
  challengesEl.append(button);
}

/* -------------------------------------------------------------------- scène */

/** Une petite cuvette de pierre avec du sable et de l'eau, pour ne pas démarrer devant du vide. */
function seed(): void {
  for (let x = 0; x < WIDTH; x++) {
    const bowl = Math.round(HEIGHT - 12 - 26 * Math.sin((x / WIDTH) * Math.PI));
    for (let y = bowl; y < HEIGHT; y++) engine.set(x, y, STONE);
  }
  for (let x = 60; x < 140; x++) {
    for (let y = 60; y < 90; y++) engine.set(x, y, SAND);
  }
  for (let x = 180; x < 260; x++) {
    for (let y = 50; y < 80; y++) engine.set(x, y, WATER);
  }
}

// Le bac est repris tel quel d'une visite à l'autre : le lien partagé passe
// devant, puis la dernière scène, et seulement à défaut la cuvette de départ.
// ponytail: la grille seule — température et vies repartent au repos.
const BAC = "sandbox-rabbit:bac";
const kept = localStorage.getItem(BAC);
if (location.hash.length > 1) load(decodeURIComponent(location.hash.slice(1)));
else if (kept) load(kept);
else seed();
undoStack.length = 0; // rien à annuler avant le premier geste

// `visibilitychange` plutôt que `beforeunload` : c'est le seul que les mobiles
// déclenchent vraiment quand l'onglet part en arrière-plan.
addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") localStorage.setItem(BAC, encode(engine.cells, engine.frozen));
});

/* ------------------------------------------------------------ boucle rendu */

const fpsEl = document.querySelector<HTMLSpanElement>("#fps")!;
const filledEl = document.querySelector<HTMLSpanElement>("#filled")!;
let frames = 0;
let lastReport = performance.now();

/** Reliquat de tick quand la vitesse n'est pas entière (ralenti). */
let pending = 0;

function frame(now: number): void {
  // Clic maintenu sans bouger : on continue de déposer sous le curseur.
  if (painting && last) paintAt(last.x, last.y);
  if (running) {
    pending += speed;
    // Plafonné : si une frame traîne, on saute des ticks plutôt que de s'enliser.
    for (let n = Math.min(Math.floor(pending), 8); n > 0; n--) engine.step();
    pending %= 1;
  }
  renderer.draw();
  // Enregistrement en cours : la frame part aussi dans le canvas filmé.
  if (recCtx) recCtx.drawImage(canvas, 0, 0, recCtx.canvas.width, recCtx.canvas.height);

  frames++;
  if (now - lastReport >= 500) {
    fpsEl.textContent = String(Math.round((frames * 1000) / (now - lastReport)));
    let filled = 0;
    for (let i = 0; i < engine.cells.length; i++) if (engine.cells[i] !== EMPTY) filled++;
    filledEl.textContent = filled.toLocaleString("fr-FR");
    if (challenge && challenge.won(engine)) {
      const secs = Math.round((now - startedAt) / 1000);
      const record = records[challenge.name] === undefined || secs < records[challenge.name];
      if (record) {
        records[challenge.name] = secs;
        localStorage.setItem(RECORDS, JSON.stringify(records));
      }
      goalEl.textContent = `${challenge.name} — réussi en ${secs} s${record ? " — nouveau record !" : best(challenge.name)}`;
      challenge = null;
    }
    frames = 0;
    lastReport = now;
  }
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
