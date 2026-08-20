import "./style.css";
import { CATEGORIES, EMPTY, MAGNET, MATERIALS, SAND, SHORTCUTS, SOURCE, SWITCH, WATER, type MaterialId } from "./sim/materials.ts";
import { CHALLENGES, SCENES, type Challenge } from "./challenges.ts";
import { panAfterZoom, pushRecent, read, write } from "./ui.ts";
import { captureFrame, initShare } from "./share.ts";
import { initRoom, relay } from "./room.ts";
import { HEIGHT, WIDTH, askClip, askLoad, canvas, latestGrid, listen, onResize, order, resize, type ClipData } from "./world.ts";
import type { Knobs } from "./sim/sandbox.ts";
import "./theme.ts"; // jour / nuit : se branche tout seul

/**
 * Le bac simule dans un Worker (world.ts) : ce module ne lit plus le moteur, il
 * lui envoie des ordres et affiche ce qui revient. D'ou les quelques miroirs
 * ci-dessous — ce que le panneau doit savoir tout de suite, sans attendre une
 * frame.
 */
const set = (k: Partial<Knobs>): void => order({ t: "set", k });

let current: MaterialId = SAND;
let brush = 5;
let running = true;
/** Matière qu'une source crachera : le moteur la garde aussi, le panneau la relit. */
let emit: MaterialId = WATER;
let gravity: 1 | -1 = 1;
/** Dernière matière et température sous le curseur, telles que le bac les a vues. */
let probed: [MaterialId, number] | null = null;
/** Un rejeu occupe le bac : le pinceau et l'enregistrement se taisent. */
let playing = false;
/** Taille de la dernière partie enregistrée, ou null : le bac garde le film. */
let film: { w: number; h: number } | null = null;
let recording = false;

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
  // La liste est reconstruite : si le focus était dedans, il partait au body à
  // chaque choix fait au clavier. La matière élue passe en tête, c'est donc le
  // premier bouton qui le reprend.
  const focused = recentEl.contains(document.activeElement);
  recent = pushRecent(recent, id, 6);
  recentEl.replaceChildren(...recent.map(swatch));
  if (focused) recentEl.querySelector("button")?.focus();
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
  if (id !== SOURCE && id !== EMPTY) { emit = id; set({ emit: id }); }
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
  // Une modale ouverte (galerie, raccourcis) garde ses touches : sans ça
  // Espace mettait le bac en pause pendant qu'on choisissait un monde.
  if (document.querySelector("dialog[open]")) return;
  if (e.key === " ") { toggleRun(); e.preventDefault(); return; }
  if ((e.ctrlKey || e.metaKey) && (e.key === "y" || (e.key === "Z" && e.shiftKey))) { redo(); e.preventDefault(); return; }
  if (e.key === "z" && (e.ctrlKey || e.metaKey)) { undo(); e.preventDefault(); return; }
  if (e.key === "v" && (e.ctrlKey || e.metaKey) && clip && last) {
    snapshot();
    // Centré sur le curseur : c'est là qu'on regarde en collant.
    gesture({
      t: "clip",
      x: last.x - (clip.w >> 1),
      y: last.y - (clip.h >> 1),
      w: clip.w, h: clip.h,
      cells: clip.cells, life: clip.life,
    });
    e.preventDefault();
    return;
  }
  const n = Number(e.key);
  if (!Number.isNaN(n) && SHORTCUTS[n - 1] !== undefined) select(SHORTCUTS[n - 1]);
  if (e.key === "0") select(EMPTY);
  if (e.key === "g") flipGravity();
  // Taille du pinceau : le réglage le plus repris, et il fallait redéplier son
  // groupe à chaque fois. L'événement rejoué borne la valeur et retient tout.
  if (e.key === "[" || e.key === "]") {
    brushInput.value = String(Number(brushInput.value) + (e.key === "]" ? 1 : -1));
    brushInput.dispatchEvent(new Event("input"));
  }
  if (e.key === "f") toolInput.value = toolInput.value === "paint" ? "freeze" : "paint";
  if (e.key === "h") { heatmapInput.checked = !heatmapInput.checked; set({ heatmap: heatmapInput.checked }); }
  if (e.key === "?" && !shortcutsEl.open) shortcutsEl.showModal();
});

/* -------------------------------------------------------------- raccourcis */

// Le pense-bête : les touches vivent dans index.html, sauf la ligne des
// matières, qui se remplit depuis `SHORTCUTS` — réordonner la barre ne doit pas
// laisser une aide qui ment.
const shortcutsEl = document.querySelector<HTMLDialogElement>("#shortcuts")!;
// Les neuf premières : la dixième est la gomme, qui a sa propre ligne (touche 0).
document.querySelector<HTMLSpanElement>("#keys-materials")!.textContent = SHORTCUTS
  .slice(0, 9)
  .map((id, n) => `${n + 1} ${MATERIALS[id].name}`)
  .join(" · ");
document.querySelector<HTMLButtonElement>("#help")!.addEventListener("click", () => shortcutsEl.showModal());

/* ------------------------------------------------------------------ souris */

let painting = false;
let last: { x: number; y: number } | null = null;
/** Morceau découpé par l'outil « Copier », reposé par Ctrl+V (déjà encodé par le bac). */
let clip: ClipData | null = null;
let selection: { x: number; y: number } | null = null;

function toCell(e: PointerEvent): { x: number; y: number } {
  const r = canvas.getBoundingClientRect();
  return {
    x: Math.floor(((e.clientX - r.left) / r.width) * WIDTH),
    y: Math.floor(((e.clientY - r.top) / r.height) * HEIGHT),
  };
}

/** Les outils qui se tracent en glissant : le marquee, pas le pinceau. */
const dragging = (): boolean => toolInput.value === "copy" || toolInput.value === "rect";

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

import { type Gesture } from "./gestures.ts";

/**
 * Tout geste qui modifie la grille passe par ici : appliqué chez soi, puis
 * relayé à l'hôte si on est invité d'un salon. Sans ce passage unique, un
 * invité qui remplit, fige ou colle voit son geste effacé par l'instantané
 * suivant.
 */
function gesture(g: Gesture): void {
  // Pendant un rejeu, le bac appartient à l'enregistrement : un geste de plus
  // ferait diverger la suite de ce qu'on est en train de regarder.
  if (playing) return;
  order({ t: "do", g });
  relay(g);
}

/** Les liquides et gaz sont déposés en pointillé, sinon on en crée trop d'un coup. */
function dab(x: number, y: number): void {
  if (toolInput.value !== "paint") {
    // Les outils qui se tracent en glissant s'appliquent au relâchement.
    if (dragging()) return;
    gesture({ t: "frozen", x, y, r: brush, on: toolInput.value === "freeze" });
    return;
  }
  const kind = MATERIALS[current].kind;
  const density = kind === "liquid" || kind === "gas" ? 0.35 : 1;
  // Gomme sélective : on n'efface que la dernière matière choisie avant la gomme.
  const only = current === EMPTY && onlyInput.checked ? emit : undefined;
  gesture({ t: "paint", x, y, r: brush, id: current, d: density, over: !keepInput.checked, only });
}

/** Le rectangle tracé, plus son reflet si la symétrie est cochée. */
function rectTo(a: { x: number; y: number }, b: { x: number; y: number }): void {
  const over = !keepInput.checked;
  gesture({ t: "rect", x: a.x, y: a.y, x2: b.x, y2: b.y, id: current, over });
  if (mirrorInput.checked) {
    gesture({ t: "rect", x: WIDTH - 1 - a.x, y: a.y, x2: WIDTH - 1 - b.x, y2: b.y, id: current, over });
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
  // Pipette : la matière vue par la dernière frame, pas une lecture du moteur
  // (il est sur l'autre fil). C'est la cellule sous le curseur, donc la bonne.
  if (e.altKey) { if (probed) select(probed[0]); return; }
  if (e.button === 2) { snapshot(); gesture({ t: "fill", x: p.x, y: p.y, id: current }); return; }
  canvas.setPointerCapture(e.pointerId);
  // Les deux outils qui se tracent en glissant. « Copier » ne modifie rien, et
  // « Rectangle » ne s'applique qu'au relâchement : le cran d'annulation est
  // pris là-bas, sinon dix sélections videraient l'historique.
  if (dragging()) {
    selection = p;
    showMarquee(p, p);
    last = p;
    return;
  }
  snapshot();
  // Cliquer un interrupteur (ou un aimant) déjà posé le bascule au lieu d'en reposer un.
  // ponytail: `probed` date de la dernière frame. À la souris elle est juste
  // (le curseur y est passé avant le clic) ; au doigt, une première tape peut
  // reposer un interrupteur au lieu de le basculer — geste sans effet, la
  // seconde bascule.
  const at = probed?.[0];
  if ((current === SWITCH && at === SWITCH) || (current === MAGNET && at === MAGNET)) {
    gesture({ t: "toggle", x: p.x, y: p.y });
    return;
  }
  painting = true;
  // Maj : on relie le dernier point posé, même si le pinceau a été relâché entre-temps.
  if (e.shiftKey && last) strokeTo(last, p);
  else paintAt(p.x, p.y);
  last = p;
});

const probeEl = document.querySelector<HTMLSpanElement>("#probe")!;

/**
 * Matière et température sous le curseur : c'est ce qui rend la vue thermique
 * lisible. Le bac les renvoie avec chaque frame — on lui dit juste où regarder.
 */
const probe = (p: { x: number; y: number }): void => order({ t: "cursor", x: p.x, y: p.y });

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
      if (toolInput.value === "rect") {
        snapshot();
        rectTo(selection, last);
        statusEl.textContent = `Rectangle de ${Math.abs(last.x - selection.x) + 1} × ${Math.abs(last.y - selection.y) + 1}.`;
      } else {
        void askClip(selection.x, selection.y, last.x, last.y).then((c) => {
          clip = c;
          statusEl.textContent = `Morceau de ${c.w} × ${c.h} découpé — Ctrl+V pour le reposer.`;
        });
      }
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
  order({ t: "cursor", x: -1, y: -1 }); // plus de curseur, plus de sonde
  probeEl.textContent = "–";
  ringEl.hidden = true;
});

/* ----------------------------------------------------------------- annuler */

// Les crans (une copie des quatre tableaux) vivent dans le bac, avec les
// tableaux qu'ils copient : ils ne traversent jamais le pont — 230 ko le cran.
// Ici il ne reste que les ordres, et le compte revient par la barre de statut.
const snapshot = (): void => order({ t: "edit", do: "snapshot" });
const undo = (): void => order({ t: "edit", do: "undo" });
const redo = (): void => order({ t: "edit", do: "redo" });

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

/** Ticks de simulation par 60e de seconde : 0,25 (ralenti) à 4 (accéléré). */
let speed = 1;
const speedInput = document.querySelector<HTMLInputElement>("#speed")!;
const speedValue = document.querySelector<HTMLOutputElement>("#speed-value")!;
speedInput.addEventListener("input", () => {
  speed = Number(speedInput.value) / 4;
  set({ speed });
  speedValue.value = `×${speed.toLocaleString("fr-FR")}`;
});

const windInput = document.querySelector<HTMLInputElement>("#wind")!;
const windValue = document.querySelector<HTMLOutputElement>("#wind-value")!;
windInput.addEventListener("input", () => {
  set({ wind: Number(windInput.value) / 10 });
  windValue.value = windInput.value;
});

// Climat de la scène : tout retourne à cette température (hiver, four…).
const ambientInput = document.querySelector<HTMLInputElement>("#ambient")!;
const ambientValue = document.querySelector<HTMLOutputElement>("#ambient-value")!;
ambientInput.addEventListener("input", () => {
  set({ ambient: Number(ambientInput.value) });
  ambientValue.value = `${ambientInput.value} °C`;
});

// Redimensionner invalide les piles d'annulation (leurs tableaux n'ont plus la
// bonne longueur) et remet la vue d'aplomb.
// Redimensionner remet la vue d'aplomb. Les crans d'annulation et
// l'enregistrement en cours, eux, sont vidés par le bac lui-même.
onResize.push(() => {
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

// Météo : la pluie elle-même vit dans gestures.ts, avec le tirage du moteur.
const weatherInput = document.querySelector<HTMLInputElement>("#weather")!;
weatherInput.addEventListener("change", () => set({ weather: weatherInput.checked }));

const heatmapInput = document.querySelector<HTMLInputElement>("#heatmap")!;
heatmapInput.addEventListener("change", () => set({ heatmap: heatmapInput.checked }));

// Réglages retenus d'une visite à l'autre. On rejoue l'événement "input" plutôt
// que de dupliquer les handlers ci-dessus.
// ponytail: un blob JSON sans version — un réglage renommé repart au défaut.
const SETTINGS = "sandbox-rabbit:reglages";

/** JSON du stockage local, toléré : abîmé, on repart du défaut. */
function stored<T>(key: string, fallback: T): T {
  try {
    return JSON.parse(read(key) ?? "") as T;
  } catch {
    return fallback;
  }
}

/**
 * Les réglages retenus, désignés par leur `id` — les clés du blob sont donc
 * celles d'avant (`brush`, `speed`…), les anciennes visites se relisent.
 * Une case à cocher garde son `checked`, tout le reste sa `value`.
 */
const SAVED = [
  brushInput, speedInput, windInput, ambientInput, sizeInput,
  toolInput, keepInput, onlyInput, mirrorInput, zoomInput, weatherInput, heatmapInput,
];
const isCheck = (el: Element): el is HTMLInputElement =>
  el instanceof HTMLInputElement && el.type === "checkbox";

function remember(): void {
  const state: Record<string, string | number | boolean> = { current };
  for (const el of SAVED) state[el.id] = isCheck(el) ? el.checked : el.value;
  write(SETTINGS, JSON.stringify(state));
}
// Les deux événements : une case coche sur « change », un curseur glisse sur « input ».
for (const el of SAVED) for (const type of ["input", "change"]) el.addEventListener(type, remember);
paletteEl.addEventListener("click", remember);

// Forme libre : le blob n'est pas versionné, chaque champ est retesté ci-dessous.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const saved = stored<any>(SETTINGS, null);
if (saved) {
  if (MATERIALS[saved.current as MaterialId]) select(saved.current as MaterialId);
  for (const el of SAVED) {
    const value = saved[el.id];
    if (value === undefined) continue; // réglage absent d'une version précédente
    // L'événement est rejoué plutôt que les handlers dupliqués : c'est lui qui
    // pousse la valeur dans le moteur (vent, ambiante) ou dans le rendu.
    if (isCheck(el)) {
      el.checked = Boolean(value);
      el.dispatchEvent(new Event("change"));
    } else {
      el.value = String(value);
      el.dispatchEvent(new Event("input"));
    }
  }
}

const gravityButton = document.querySelector<HTMLButtonElement>("#gravity")!;
function flipGravity(): void {
  gravity = gravity === 1 ? -1 : 1;
  set({ gravity });
  gravityButton.textContent = gravity === 1 ? "Vers le bas ↓" : "Vers le haut ↑";
}
gravityButton.addEventListener("click", flipGravity);

const playButton = document.querySelector<HTMLButtonElement>("#play")!;
function toggleRun(): void {
  running = !running;
  set({ running });
  playButton.textContent = running ? "Pause" : "Reprendre";
}
playButton.addEventListener("click", toggleRun);

document.querySelector<HTMLButtonElement>("#step")!.addEventListener("click", () => {
  running = false;
  playButton.textContent = "Reprendre";
  set({ running });
  order({ t: "edit", do: "step" });
});

// Plein écran natif : le CSS `pixelated` fait la mise à l'échelle, le rendu ne
// change pas d'un pixel et `getBoundingClientRect()` suit le pinceau. C'est la
// scène qu'on agrandit, pas le canvas seul : le cercle du pinceau et le
// rectangle de sélection sont ses enfants, hors de l'élément plein écran le
// navigateur ne les peint pas.
document.querySelector<HTMLButtonElement>("#full")!.addEventListener("click", () => {
  if (document.fullscreenElement) void document.exitFullscreen();
  else void canvas.parentElement!.requestFullscreen();
});

// Surprise : un décor tiré au sort, sans objectif — juste pour regarder.
document.querySelector<HTMLButtonElement>("#surprise")!.addEventListener("click", () => {
  const scene = SCENES[Math.floor(Math.random() * SCENES.length)];
  fit(320);
  order({ t: "scene", name: scene.name });
  statusEl.textContent = `« ${scene.name} » — servez-vous.`;
});

document.querySelector<HTMLButtonElement>("#clear")!.addEventListener("click", () => order({ t: "edit", do: "clear" }));

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
function load(data: string, width?: number, quiet = false): Promise<boolean> {
  if (width !== undefined) {
    fit(width);
    // `fit` refuse une largeur absente du menu : mieux vaut ne rien charger
    // qu'afficher une bouillie.
    if (width !== WIDTH) {
      statusEl.textContent = "Monde fait pour une autre taille de grille.";
      return Promise.resolve(false);
    }
  }
  // Le décodage et le cran d'annulation sont l'affaire du bac ; il répond si la
  // grille était lisible, et dit lui-même qu'elle ne l'était pas.
  return askLoad(data, quiet);
}

/* ------------------------------------------------------------- bac partagé */

// Le salon vit dans room.ts ; il lui manque juste de quoi mettre un invité en
// pause et de quoi suivre la taille de grille de l'hôte.
initRoom({
  // Le geste d'un invité passe par le même point que les nôtres : sans ça il
  // manquerait de l'enregistrement de l'hôte.
  apply: gesture,
  role(host) {
    running = host;
    playButton.textContent = running ? "Pause" : "Reprendre";
  },
  size(w) {
    fit(w);
  },
  grid(data) {
    void load(data, undefined, true);
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
    // Le bac connaît la scène par son nom : c'est lui qui la bâtit et qui
    // surveille la victoire, la page ne garde que le chrono et le libellé.
    order({ t: "scene", name: c.name });
    startChallenge(c);
  });
  challengesEl.append(button);
}

// La galerie sait charger un monde et lancer un défi, mais ni l'un ni l'autre
// ne lui appartient : on les lui passe.
initShare({
  load,
  start(c, goal) {
    // Monde-défi de la galerie : la grille est déjà posée, seul l'objectif
    // reste à armer côté bac.
    if (goal !== undefined) order({ t: "goal", goal });
    startChallenge(c);
  },
});

/* -------------------------------------------------------------------- scène */


// Le bac est repris tel quel d'une visite à l'autre : le lien partagé passe
// devant, puis la dernière scène, et seulement à défaut la cuvette de départ.
// L'état vivant voyage avec (`snapshotData`) : un incendie laissé en plan
// repart chaud.
const BAC = "sandbox-rabbit:bac";
const kept = read(BAC);
// `quiet` : rien à annuler avant le premier geste. À défaut des deux, le bac a
// déjà graîné sa cuvette tout seul.
if (location.hash.length > 1) loadHash(location.hash.slice(1));
else if (kept) void load(kept, undefined, true);

/**
 * Un lien partagé : « 320~<grille> ». La largeur précède la grille, sinon un
 * monde 480 relu dans un bac 320 se décale d'une ligne à chaque rangée.
 * Sans elle (liens d'avant), on suppose le bac tel qu'il est.
 */
function loadHash(raw: string): void {
  let hash: string;
  try {
    hash = decodeURIComponent(raw);
  } catch {
    return; // « %zz » dans l'adresse : ce n'est pas un lien de partage
  }
  const cut = hash.indexOf("~");
  if (cut > 0) void load(hash.slice(cut + 1), Number(hash.slice(0, cut)), true);
  else void load(hash, undefined, true);
}

// `visibilitychange` plutôt que `beforeunload` : c'est le seul que les mobiles
// déclenchent vraiment quand l'onglet part en arrière-plan.
addEventListener("visibilitychange", () => {
  // La grille du bac, telle qu'il l'a envoyée il y a moins d'un quart de
  // seconde : rien à demander, personne ne répondrait — la page s'en va.
  if (document.visibilityState === "hidden") write(BAC, latestGrid());
});

/* -------------------------------------------------------------------- rejeu */

/**
 * Enregistrer une partie, la regarder à nouveau. Rien n'est filmé : on garde la
 * grille de départ, l'état du tirage au sort et les gestes horodatés en ticks
 * (replay.ts). Une partie de dix minutes tient en quelques kilo-octets, et le
 * rejeu retombe sur la même grille au pixel près.
 *
 * ponytail: en mémoire seulement — rien ne s'exporte ni ne s'importe. Ajouter
 * un fichier ou un lien le jour où on veut échanger des parties ; ce sera un
 * JSON venu d'ailleurs, donc à valider comme une grille de la galerie.
 */

const recButton = document.querySelector<HTMLButtonElement>("#rec")!;
const playbackButton = document.querySelector<HTMLButtonElement>("#replay")!;

playbackButton.addEventListener("click", () => {
  if (playing) { order({ t: "play", on: false }); return; }
  if (!film) return;
  // Les scènes ont leur taille : un rejeu 480 dans un bac 320 se décalerait.
  if (film.w !== WIDTH) fit(film.w);
  // Un rejeu en pause ne se verrait pas avancer.
  running = true;
  set({ running });
  playButton.textContent = "Pause";
  order({ t: "play", on: true });
});

recButton.addEventListener("click", () => {
  if (playing) return; // on n'enregistre pas un rejeu
  recording = !recording;
  order({ t: "rec", on: recording });
  recButton.textContent = recording ? "\u25a0 Arrêter" : "Enregistrer";
  if (recording) statusEl.textContent = "Enregistrement…";
});

/* ------------------------------------------------------------ boucle rendu */

const fpsEl = document.querySelector<HTMLSpanElement>("#fps")!;
const filledEl = document.querySelector<HTMLSpanElement>("#filled")!;
let frames = 0;
let lastReport = performance.now();

/**
 * Ce qui reste de la boucle de rendu : la simulation et le dessin sont partis
 * dans le Worker, les pixels arrivent tout peints (world.ts). Ici on ne fait
 * plus que ce qui regarde l'écran et la souris — d'où le gain, c'est ce fil-là
 * qui tenait le panneau, le zoom et le pinceau.
 */
function frame(now: number): void {
  // Clic maintenu sans bouger : on continue de déposer sous le curseur.
  if (painting && last) paintAt(last.x, last.y);
  captureFrame(); // vidéo en cours : la frame y part aussi

  frames++;
  if (now - lastReport >= 500) {
    fpsEl.textContent = String(Math.round((frames * 1000) / (now - lastReport)));
    frames = 0;
    lastReport = now;
  }
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

/** Défi réussi : le bac l'a vu, la page tient le chrono et les records. */
function win(): void {
  if (!challenge) return;
  const secs = Math.round((performance.now() - startedAt) / 1000);
  const record = records[challenge.name] === undefined || secs < records[challenge.name];
  if (record) {
    records[challenge.name] = secs;
    write(RECORDS, JSON.stringify(records));
  }
  goalEl.textContent = `${challenge.name} — réussi en ${secs} s${record ? " — nouveau record !" : best(challenge.name)}`;
  challenge = null;
}

// Les nouvelles du bac. Tout ce que la page affichait en lisant le moteur —
// la sonde, le compte de cellules, la barre de statut — arrive maintenant par
// là ; la grille encodée, elle, est gardée par world.ts et lue par le salon.
listen((news) => {
  switch (news.t) {
    case "frame":
      probed = news.probe;
      probeEl.textContent = news.probe
        ? `${MATERIALS[news.probe[0]].name} · ${Math.round(news.probe[1])} °C`
        : "–";
      return;
    case "stats":
      filledEl.textContent = news.filled.toLocaleString("fr-FR");
      return;
    case "say":
      statusEl.textContent = news.text;
      return;
    case "won":
      return win();
    case "rec": {
      film = { w: news.w, h: news.h };
      playbackButton.disabled = false;
      const ko = Math.max(1, Math.round(news.size / 1024));
      statusEl.textContent = `Enregistré : ${news.ticks} ticks, ${news.beats} événements, ~${ko} ko.`;
      return;
    }
    case "play":
      playing = news.on;
      playbackButton.textContent = news.on ? "\u25a0 Arrêter" : "Rejouer";
      statusEl.textContent = news.on ? "Rejeu en cours." : "Fin du rejeu.";
      return;
    default:
      return; // « grid » et « reply » sont l'affaire de world.ts
  }
});
