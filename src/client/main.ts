import "./style.css";
import { type Clip } from "./sim/engine.ts";
import { decode, decodeFrozen, decodeLife, decodeTemp, encode } from "./sim/codec";
import { CATEGORIES, EMPTY, MAGNET, MATERIALS, SAND, SHORTCUTS, SNOW, SOURCE, SWITCH, WATER, type MaterialId } from "./sim/materials.ts";
import { CHALLENGES, SCENES, type Challenge } from "./challenges.ts";
import { panAfterZoom, pushRecent } from "./ui.ts";
import { captureFrame, initShare, snapshotData } from "./share.ts";
import { initRoom, relay } from "./room.ts";
import { HEIGHT, WIDTH, canvas, engine, onResize, renderer, resize, seed } from "./world.ts";
import "./theme.ts"; // jour / nuit : se branche tout seul


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
  // Même accordéon exclusif que les groupes : une famille ouverte à la fois,
  // sinon la palette fait à elle seule la hauteur de deux écrans.
  box.setAttribute("name", "famille");
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
  // Pastille montée en CSSOM plutôt qu'en `style="…"` : un attribut de style
  // inline tomberait sous la CSP servie par le Worker.
  const dot = document.createElement("span");
  dot.className = "swatch";
  dot.style.background = `rgb(${m.color.join(",")})`;
  button.append(dot, m.name);
  button.addEventListener("click", () => select(id));
  button.addEventListener("pointerenter", () => (hintEl.textContent = m.hint));
  return button;
}
paletteEl.addEventListener("pointerleave", () => (hintEl.textContent = MATERIALS[current].hint));


// Les six dernières matières choisies, épinglées au-dessus des familles :
// depuis que la palette est un accordéon exclusif, y revenir coûtait deux clics.
const recentEl = document.querySelector<HTMLDivElement>("#recent")!;
let recent: MaterialId[] = [];

function keepRecent(id: MaterialId): void {
  recent = pushRecent(recent, id, 6);
  recentEl.replaceChildren(...recent.map(swatch));
}

// Clavier : les flèches parcourent une grille de matières. Sans ça il faut
// quarante-six tabulations pour traverser la palette.
for (const grid of [paletteEl, recentEl]) {
  grid.addEventListener("keydown", (e) => {
    const step = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: 2, ArrowUp: -2 }[e.key];
    if (step === undefined) return;
    const box = (e.target as HTMLElement).closest(".palette");
    if (!box) return;
    const buttons = [...box.querySelectorAll("button")];
    const next = buttons[buttons.indexOf(e.target as HTMLButtonElement) + step];
    if (!next) return;
    next.focus();
    e.preventDefault();
  });
}

function select(id: MaterialId): void {
  current = id;
  keepRecent(id);
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
  // Un champ a le focus (le nombre d'un objectif, un curseur, la galerie) :
  // ses touches lui appartiennent, sinon taper « 500 » change de matière.
  const on = e.target as HTMLElement | null;
  if (on && on !== document.body && on.closest("input, select, textarea")) return;
  if (e.key === " ") { toggleRun(); e.preventDefault(); return; }
  if ((e.ctrlKey || e.metaKey) && (e.key === "y" || (e.key === "Z" && e.shiftKey))) { redo(); e.preventDefault(); return; }
  if (e.key === "z" && (e.ctrlKey || e.metaKey)) { undo(); e.preventDefault(); return; }
  if (e.key === "v" && (e.ctrlKey || e.metaKey) && clip && last) {
    snapshot();
    // Centré sur le curseur : c'est là qu'on regarde en collant.
    gesture({
      t: "clip",
      x: last.x - (clip.width >> 1),
      y: last.y - (clip.height >> 1),
      w: clip.width, h: clip.height,
      cells: encode(clip.cells, clip.frozen), life: encode(clip.life),
    });
    e.preventDefault();
    return;
  }
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
/** Morceau découpé par l'outil « Copier », reposé par Ctrl+V. */
let clip: Clip | null = null;
let selection: { x: number; y: number } | null = null;

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

/* ------------------------------------------------------- repères à l'écran */

const ringEl = document.querySelector<HTMLDivElement>("#ring")!;
const marqueeEl = document.querySelector<HTMLDivElement>("#marquee")!;

/** Côté d'une cellule à l'écran, zoom compris. */
const cellSize = (): number => canvas.getBoundingClientRect().width / WIDTH;

/** Cercle de la taille réelle du pinceau, sous le curseur. */
function showRing(e: PointerEvent): void {
  if (e.pointerType === "touch") return; // sous le doigt, personne ne le verrait
  const d = (brush * 2 + 1) * cellSize();
  ringEl.hidden = false;
  ringEl.style.width = `${d}px`;
  ringEl.style.height = `${d}px`;
  ringEl.style.left = `${e.clientX}px`;
  ringEl.style.top = `${e.clientY}px`;
}

/** Rectangle de sélection, en cellules, converti en pixels d'écran. */
function showMarquee(a: { x: number; y: number }, b: { x: number; y: number }): void {
  const r = canvas.getBoundingClientRect();
  const s = cellSize();
  marqueeEl.hidden = false;
  marqueeEl.style.left = `${r.left + Math.min(a.x, b.x) * s}px`;
  marqueeEl.style.top = `${r.top + Math.min(a.y, b.y) * s}px`;
  marqueeEl.style.width = `${(Math.abs(a.x - b.x) + 1) * s}px`;
  marqueeEl.style.height = `${(Math.abs(a.y - b.y) + 1) * s}px`;
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

/** Zoome autour d'un point de l'écran, qui ne bouge pas (math dans ui.ts). */
function zoomAt(clientX: number, clientY: number, next: number): void {
  const r = canvas.getBoundingClientRect();
  panX = panAfterZoom(clientX, r.left, r.width, panX, zoom, next);
  panY = panAfterZoom(clientY, r.top, r.height, panY, zoom, next);
  zoom = next;
  if (zoom === 1) { panX = 0; panY = 0; }
  applyView();
}

const clampZoom = (z: number): number => Math.min(12, Math.max(1, z));

// Le zoom se coupe : sans lui la molette rend la main à la page, et un bac
// laissé agrandi ne piège personne — on le remet d'aplomb en décochant.
const zoomInput = document.querySelector<HTMLInputElement>("#zoom")!;
zoomInput.addEventListener("change", () => {
  if (!zoomInput.checked) zoomAt(0, 0, 1);
});

canvas.addEventListener("wheel", (e) => {
  if (!zoomInput.checked) return; // pas de preventDefault : la page défile
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

import { applyGesture, type Gesture } from "./gestures.ts";

/**
 * Tout geste qui modifie la grille passe par ici : appliqué chez soi, puis
 * relayé à l'hôte si on est invité d'un salon. Sans ce passage unique, un
 * invité qui remplit, fige ou colle voit son geste effacé par l'instantané
 * suivant.
 */
function gesture(g: Gesture): void {
  applyGesture(g);
  relay(g);
}

/** Les liquides et gaz sont déposés en pointillé, sinon on en crée trop d'un coup. */
function dab(x: number, y: number): void {
  if (toolInput.value !== "paint") {
    // « Copier » ne touche à rien : il se contente de découper au relâchement.
    if (toolInput.value === "copy") return;
    gesture({ t: "frozen", x, y, r: brush, on: toolInput.value === "freeze" });
    return;
  }
  const kind = MATERIALS[current].kind;
  const density = kind === "liquid" || kind === "gas" ? 0.35 : 1;
  // Gomme sélective : on n'efface que la dernière matière choisie avant la gomme.
  const only = current === EMPTY && onlyInput.checked ? engine.emit : undefined;
  gesture({ t: "paint", x, y, r: brush, id: current, d: density, over: !keepInput.checked, only });
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
    if (touches.size === 2 && zoomInput.checked) {
      painting = false; // le second doigt annule le trait en cours
      pinch = span();
      return;
    }
  }
  if (e.button === 1 && zoomInput.checked) {
    panning = true;
    canvas.setPointerCapture(e.pointerId);
    e.preventDefault();
    return;
  }
  const p = toCell(e);
  // Pipette : Alt+clic reprend la matière sous le curseur, sans rien modifier.
  if (e.altKey) { select(engine.get(p.x, p.y) as MaterialId); return; }
  snapshot();
  if (e.button === 2) { gesture({ t: "fill", x: p.x, y: p.y, id: current }); return; }
  // Cliquer un interrupteur (ou un aimant) déjà posé le bascule au lieu d'en reposer un.
  const at = engine.get(p.x, p.y);
  if ((current === SWITCH && at === SWITCH) || (current === MAGNET && at === MAGNET)) {
    gesture({ t: "toggle", x: p.x, y: p.y });
    return;
  }
  canvas.setPointerCapture(e.pointerId);
  // Outil « Copier » : le glissé trace un rectangle, il ne peint rien.
  if (toolInput.value === "copy") {
    selection = p;
    showMarquee(p, p);
    last = p;
    return;
  }
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
  showRing(e);
  if (selection) { showMarquee(selection, at); last = at; return; }
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
    if (selection && last) {
      clip = engine.copy(selection.x, selection.y, last.x, last.y);
      statusEl.textContent = `Morceau de ${clip.width} × ${clip.height} découpé — Ctrl+V pour le reposer.`;
      selection = null;
      marqueeEl.hidden = true;
    }
    painting = false;
    panning = false;
    touches.delete((e as PointerEvent).pointerId);
    if (touches.size < 2) pinch = null;
  });
}
canvas.addEventListener("pointerleave", () => {
  probeEl.textContent = "–";
  ringEl.hidden = true;
});

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

// Redimensionner invalide les piles d'annulation (leurs tableaux n'ont plus la
// bonne longueur) et remet la vue d'aplomb.
onResize.push(() => {
  undoStack.length = 0;
  redoStack.length = 0;
  zoom = 1;
  panX = 0;
  panY = 0;
  applyView();
});

const sizeInput = document.querySelector<HTMLSelectElement>("#size")!;
sizeInput.addEventListener("input", () => {
  const w = Number(sizeInput.value);
  resize(w, (w * 9) / 16);
});

/**
 * Impose une taille au bac **sans le regraîner** : ce dont ont besoin les
 * scènes (écrites pour 320×180), un lien partagé et l'hôte d'un salon.
 * Une largeur qui n'est pas au menu est refusée — le lien vient d'ailleurs.
 */
function fit(w: number): void {
  if (w === WIDTH) return;
  if (![...sizeInput.options].some((o) => o.value === String(w))) return;
  resize(w, (w * 9) / 16, true);
  sizeInput.value = String(w);
}

// Météo : quelques gouttes par tick sur la ligne d'où vient la matière (donc
// en bas si la gravité est inversée). L'ambiante décide de leur nature — c'est
// ce qui donne enfin à voir le curseur de température.
const weatherInput = document.querySelector<HTMLInputElement>("#weather")!;

function weather(): void {
  const id = engine.ambient <= 0 ? SNOW : WATER;
  const y = engine.gravity === 1 ? 0 : HEIGHT - 1;
  for (let n = Math.max(2, (WIDTH / 160) | 0); n > 0; n--) {
    engine.set(Math.floor(Math.random() * WIDTH), y, id);
  }
}

const heatmapInput = document.querySelector<HTMLInputElement>("#heatmap")!;
heatmapInput.addEventListener("change", () => (renderer.heatmap = heatmapInput.checked));

// Réglages retenus d'une visite à l'autre. On rejoue l'événement "input" plutôt
// que de dupliquer les handlers ci-dessus.
// ponytail: un blob JSON sans version — un réglage renommé repart au défaut.
const SETTINGS = "sandbox-rabbit:reglages";

/** JSON du stockage local, toléré : abîmé, on repart du défaut. */
function stored<T>(key: string, fallback: T): T {
  try {
    return JSON.parse(localStorage.getItem(key) ?? "") as T;
  } catch {
    return fallback;
  }
}

function remember(): void {
  localStorage.setItem(SETTINGS, JSON.stringify({
    current, brush: brushInput.value, speed: speedInput.value, wind: windInput.value,
    ambient: ambientInput.value, size: sizeInput.value,
  }));
}
for (const el of [brushInput, speedInput, windInput, ambientInput, sizeInput]) el.addEventListener("input", remember);
paletteEl.addEventListener("click", remember);

// Forme libre : le blob n'est pas versionné, chaque champ est retesté ci-dessous.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const saved = stored<any>(SETTINGS, null);
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

// Surprise : un décor tiré au sort, sans objectif — juste pour regarder.
document.querySelector<HTMLButtonElement>("#surprise")!.addEventListener("click", () => {
  const scene = SCENES[Math.floor(Math.random() * SCENES.length)];
  fit(320);
  snapshot();
  engine.clear();
  scene.build(engine);
  statusEl.textContent = `« ${scene.name} » — servez-vous.`;
});

document.querySelector<HTMLButtonElement>("#clear")!.addEventListener("click", () => { snapshot(); engine.clear(); });

/* -------------------------------------------------------------- mondes/API */

const statusEl = document.querySelector<HTMLParagraphElement>("#status")!;

/**
 * Charge une grille encodée (API ou lien partagé). `width` — celle du monde —
 * met le bac à la bonne taille au passage : sans elle, une grille 480 relue
 * dans un bac 320 se décale d'une ligne à chaque rangée.
 *
 * La donnée vient d'ailleurs : un base64 tronqué fait jeter `atob`, et `adopt`
 * écarte les matières inconnues.
 */
function load(data: string, width?: number): boolean {
  if (width !== undefined) {
    fit(width);
    // `fit` refuse une largeur absente du menu : mieux vaut ne rien charger
    // qu'afficher une bouillie.
    if (width !== WIDTH) {
      statusEl.textContent = "Monde fait pour une autre taille de grille.";
      return false;
    }
  }
  snapshot();
  const n = WIDTH * HEIGHT;
  try {
    engine.adopt(decode(data, n));
    engine.frozen.set(decodeFrozen(data, n));
    // Un monde d'avant les quatre blocs : on repart au repos, comme autrefois.
    const life = decodeLife(data, n);
    const temp = decodeTemp(data, n);
    if (life) engine.life.set(life); else engine.life.fill(0);
    if (temp) engine.temp.set(temp); else engine.temp.fill(engine.ambient);
  } catch {
    undo();
    statusEl.textContent = "Grille illisible.";
    return false;
  }
  return true;
}

/* ------------------------------------------------------------- bac partagé */

// Le salon vit dans room.ts ; il lui manque juste de quoi mettre un invité en
// pause et de quoi suivre la taille de grille de l'hôte.
initRoom({
  role(host) {
    running = host;
    playButton.textContent = running ? "Pause" : "Reprendre";
  },
  size(w) {
    fit(w);
  },
});

/* -------------------------------------------------------------------- défis */

const goalEl = document.querySelector<HTMLParagraphElement>("#goal")!;
const challengesEl = document.querySelector<HTMLDivElement>("#challenges")!;
let challenge: Challenge | null = null;
/** Horloge murale : la pause et le ralenti comptent aussi, c'est un chrono de joueur. */
let startedAt = 0;

// Meilleur temps par défi, en secondes. ponytail: local à la machine, pas de classement.
const RECORDS = "sandbox-rabbit:records";
const records = stored<Record<string, number>>(RECORDS, {});
const best = (name: string): string => (records[name] === undefined ? "" : ` (record : ${records[name]} s)`);

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
    fit(320);
    snapshot();
    engine.clear();
    c.build(engine);
    startChallenge(c);
  });
  challengesEl.append(button);
}

// La galerie sait charger un monde et lancer un défi, mais ni l'un ni l'autre
// ne lui appartient : on les lui passe.
initShare({ load, start: startChallenge });

/* -------------------------------------------------------------------- scène */


// Le bac est repris tel quel d'une visite à l'autre : le lien partagé passe
// devant, puis la dernière scène, et seulement à défaut la cuvette de départ.
// ponytail: la grille seule — température et vies repartent au repos.
const BAC = "sandbox-rabbit:bac";
const kept = localStorage.getItem(BAC);
if (location.hash.length > 1) loadHash(decodeURIComponent(location.hash.slice(1)));
else if (kept) load(kept);
else seed();

/**
 * Un lien partagé : « 320~<grille> ». La largeur précède la grille, sinon un
 * monde 480 relu dans un bac 320 se décale d'une ligne à chaque rangée.
 * Sans elle (liens d'avant), on suppose le bac tel qu'il est.
 */
function loadHash(hash: string): void {
  const cut = hash.indexOf("~");
  if (cut > 0) fit(Number(hash.slice(0, cut)));
  load(hash.slice(cut + 1));
}
undoStack.length = 0; // rien à annuler avant le premier geste

// `visibilitychange` plutôt que `beforeunload` : c'est le seul que les mobiles
// déclenchent vraiment quand l'onglet part en arrière-plan.
addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") localStorage.setItem(BAC, snapshotData());
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
    for (let n = Math.min(Math.floor(pending), 8); n > 0; n--) {
      if (weatherInput.checked) weather();
      engine.step();
    }
    pending %= 1;
  }
  renderer.draw();
  captureFrame(); // enregistrement en cours : la frame part aussi dans la vidéo

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
