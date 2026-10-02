import "./style.css";
import { EMPTY, MAGNET, MATERIALS, SHORTCUTS, SWITCH, type MaterialId } from "./sim/materials.ts";
import { CHALLENGES, SCENES, type Challenge } from "./challenges.ts";
import { EXPLORE_SCALE, SEEDS } from "./terrain.ts";
import { combo, keyOf, read, stored, write, type Action } from "./ui.ts";
import { bound, held, openSettings } from "./keys.ts";
import { MOVES, follow, panBy, scaleTo, scroll, zoom, zoomAt, zoomCentered, zoomInput } from "./view.ts";
import { current, emit, select } from "./palette.ts";
import { airmapInput, brush, brushInput, fit, heatmapInput, keepInput, mirrorInput, onlyInput, restore, sizeInput, soundInput, toolInput } from "./settings.ts";
import { hear, initSound, setHum } from "./audio.ts";
import { FILM_LINK, captureFrame, forgetOrigin, initShare, openFilmLink } from "./share.ts";
import type { Recording } from "./replay.ts";
import { initRoom, placeCursors, pointAt, relay } from "./lobby.ts";
import { WIDTH, askClip, cellBox, askLoad, beat, canvas, latestGrid, listen, order, present, seen, set, type ClipData } from "./world.ts";
import { STEER, closeUp, gaze, hero, heroId, loose, loosen, nameInput, nextView, pilot, tighten, track } from "./hero.ts";
import "./theme.ts"; // jour / nuit : se branche tout seul

/**
 * Le bac simule dans un Worker (world.ts) : ce module ne lit plus le moteur, il
 * lui envoie des ordres et affiche ce qui revient. D'ou les quelques miroirs
 * ci-dessous — ce que le panneau doit savoir tout de suite, sans attendre une
 * frame.
 */
let running = true;
let gravity: 1 | -1 = 1;
/**
 * La matière sous le point `p`, lue dans le miroir de la grille (world.ts) :
 * à jour à la dernière frame partout, pas seulement là où le curseur est passé.
 * La sonde (`probe` de la frame) ne vaut que pour la case survolée juste avant :
 * au doigt, sans survol, la première tape sur un interrupteur en reposait un
 * au lieu de le basculer.
 */
function under(p: { x: number; y: number }): MaterialId | null {
  const grid = seen();
  if (!grid || p.x < 0 || p.y < 0 || p.x >= grid.width || p.y >= grid.height) return null;
  return grid.cells[p.y * grid.width + p.x] as MaterialId;
}
/** Un rejeu occupe le bac : le pinceau et l'enregistrement se taisent. */
let playing = false;
/** Taille de la dernière partie enregistrée, ou null : le bac garde le film. */
let film: { w: number; h: number } | null = null;
let recording = false;
/** Invité d'un salon : c'est l'hôte qui simule, la pause n'est pas à lui. */
let guest = false;
const FOLLOW = "Vous suivez l'hôte : c'est lui qui mène le bac.";

// Raccourcis : chaque combinaison devient une action (`bound`, touches
// réassignables dans la fenêtre des raccourcis).
addEventListener("keydown", (e) => {
  // Un champ a le focus (le nombre d'un objectif, un curseur, la galerie) :
  // ses touches lui appartiennent, sinon taper « 500 » change de matière.
  const on = e.target as HTMLElement | null;
  if (on && on !== document.body && on.closest("input, select, textarea")) return;
  // Une modale ouverte (galerie, raccourcis) garde ses touches : sans ça
  // Espace mettait le bac en pause pendant qu'on choisissait un monde.
  if (document.querySelector("dialog[open]")) return;
  const move = moveKey(e);
  if (move) { held.set(keyOf(e.key), move); steer(); e.preventDefault(); return; }
  const action = bound[combo(e)];
  if (!action) return;
  e.preventDefault();
  if (action.startsWith("mat")) { select(SHORTCUTS[Number(action.slice(3)) - 1]); return; }
  switch (action) {
    case "pause": toggleRun(); return;
    case "eraser": select(EMPTY); return;
    case "undo": undo(); return;
    case "redo": redo(); return;
    case "paste":
      if (!clip || !last) return;
      snapshot();
      // Centré sur le curseur : c'est là qu'on regarde en collant.
      gesture({
        t: "clip",
        x: last.x - (clip.w >> 1),
        y: last.y - (clip.h >> 1),
        w: clip.w, h: clip.h,
        cells: clip.cells, life: clip.life,
      });
      return;
    case "zoomIn": case "zoomOut": {
      if (!zoomInput.checked) return;
      zoomCentered(zoom * (action === "zoomIn" ? 1.5 : 1 / 1.5));
      return;
    }
    // Taille du pinceau : le réglage le plus repris, et il fallait redéplier son
    // groupe à chaque fois. L'événement rejoué borne la valeur et retient tout.
    case "brushDown": case "brushUp":
      brushInput.value = String(Number(brushInput.value) + (action === "brushUp" ? 1 : -1));
      brushInput.dispatchEvent(new Event("input"));
      return;
    case "gravity": flipGravity(); return;
    case "freeze": toolInput.value = toolInput.value === "paint" ? "freeze" : "paint"; return;
    // L'événement rejoué décoche l'autre vue, comme un clic.
    case "heat": heatmapInput.checked = !heatmapInput.checked; heatmapInput.dispatchEvent(new Event("change")); return;
    case "air": airmapInput.checked = !airmapInput.checked; airmapInput.dispatchEvent(new Event("change")); return;
    case "mute":
      soundInput.checked = !soundInput.checked;
      soundInput.dispatchEvent(new Event("change"));
      statusEl.textContent = soundInput.checked ? "Son rétabli." : "Son coupé.";
      return;
    case "help": openSettings("settings-keys"); return;
    case "view": nextView(); return;
    case "nextHero": gesture({ t: "hero" }); return;
    case "retry": lastChallenge?.click(); return;
    case "step": case "terrain": case "surprise": case "full": case "clear": case "save":
      document.querySelector<HTMLButtonElement>(`#${action}`)!.click();
      return;
    case "gallery": document.querySelector<HTMLButtonElement>("#gallery-open")!.click(); return;
  }
});

/* ------------------------------------------------------------------ souris */

let painting = false;
let last: { x: number; y: number } | null = null;
/** Morceau découpé par l'outil « Copier », reposé par Ctrl+V (déjà encodé par le bac). */
let clip: ClipData | null = null;
let selection: { x: number; y: number } | null = null;

function toCell(e: PointerEvent): { x: number; y: number } {
  const b = cellBox();
  return { x: Math.floor((e.clientX - b.left) / b.sx), y: Math.floor((e.clientY - b.top) / b.sy) };
}

/** Les outils qui se tracent en glissant : le marquee, pas le pinceau. */
const dragging = (): boolean => toolInput.value === "copy" || toolInput.value === "rect";

/** Le pinceau pose une créature de taille fixe (le lapin), pas un disque. */
const placesCreature = (): boolean => toolInput.value === "paint" && MATERIALS[current].creature === true;

/** Un coup de pinceau, plus son reflet si la symétrie est cochée. */
function paintAt(x: number, y: number): void {
  dab(x, y);
  if (mirrorInput.checked) dab(WIDTH - 1 - x, y);
}

/* ------------------------------------------------------- repères à l'écran */

const ringEl = document.querySelector<HTMLDivElement>("#ring")!;
const marqueeEl = document.querySelector<HTMLDivElement>("#marquee")!;

/** Côté d'une cellule à l'écran, zoom compris. */
const cellSize = (): number => cellBox().sx;

/** Cercle de la taille réelle du pinceau, sous le curseur. */
function showRing(e: PointerEvent): void {
  if (e.pointerType === "touch") return; // sous le doigt, personne ne le verrait
  // Une créature a sa taille, le rayon du pinceau n'y fait rien : le cercle le dit.
  const d = (placesCreature() ? 4 : brush * 2 + 1) * cellSize();
  ringEl.hidden = false;
  ringEl.style.width = `${d}px`;
  ringEl.style.height = `${d}px`;
  ringEl.style.left = `${e.clientX}px`;
  ringEl.style.top = `${e.clientY}px`;
}

/** Rectangle de sélection, en cellules, converti en pixels d'écran. */
function showMarquee(a: { x: number; y: number }, b: { x: number; y: number }): void {
  const c = cellBox();
  marqueeEl.hidden = false;
  marqueeEl.style.left = `${c.left + Math.min(a.x, b.x) * c.sx}px`;
  marqueeEl.style.top = `${c.top + Math.min(a.y, b.y) * c.sy}px`;
  marqueeEl.style.width = `${(Math.abs(a.x - b.x) + 1) * c.sx}px`;
  marqueeEl.style.height = `${(Math.abs(a.y - b.y) + 1) * c.sy}px`;
}

/* ------------------------------------------------------------- vue (zoom) */

let panning = false;
/** Pixels parcourus depuis l'appui du milieu : sous `CLICK`, c'est un clic, pas un glisser. */
let panned = 0;
const CLICK = 4;

/**
 * Action de caméra — ou de héros — de l'événement, ou null. Une lettre compte
 * quelle que soit la casse (Maj tenu pour tracer une ligne) ; avec Ctrl, c'est
 * une autre combinaison (`combo`). Les flèches ne comptent que hors des
 * boutons : dans la palette, elles passent d'une matière à l'autre. Creuser
 * et poser n'existent qu'avec un héros.
 */
function moveKey(e: KeyboardEvent): Action | null {
  const action = bound[combo(e)];
  if (!action || !(action in MOVES || (hero && action in STEER))) return null;
  if (e.key.startsWith("Arrow") && (e.target as HTMLElement | null)?.closest?.("button")) return null;
  return action;
}

addEventListener("keyup", (e) => {
  held.delete(keyOf(e.key));
  steer();
});
addEventListener("blur", () => { held.clear(); steer(); });

/* ------------------------------------------------------------------ héros */

/** Envoie les commandes du héros si les touches tenues les ont changées (`pilot()` de hero.ts). */
function steer(): void {
  const keys = pilot();
  if (keys !== null) gesture({ t: "pilot", keys });
}

// Pincement : la molette n'existe pas sur mobile, tout le reste y marche déjà.
// Deux doigts posés = on ne peint plus, on manipule la vue (zoom + déplacement).
const touches = new Map<number, { x: number; y: number }>();
let pinch: { gap: number; x: number; y: number } | null = null;

/** Écart et milieu des deux doigts posés. */
function span(): { gap: number; x: number; y: number } {
  const [a, b] = [...touches.values()];
  return { gap: Math.hypot(a.x - b.x, a.y - b.y), x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

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

// Renommer le héros suivi est un geste : le rejeu le rejoue, le salon le
// relaie, le monde sauvegardé le garde. Entrée valide et rend les touches.
nameInput.addEventListener("change", () => {
  if (heroId) gesture({ t: "name", id: heroId, name: nameInput.value });
});
document.querySelector<HTMLButtonElement>("#hero-next")!.addEventListener("click", () => gesture({ t: "hero" }));
nameInput.addEventListener("keydown", (e) => { if (e.key === "Enter") nameInput.blur(); });

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
    panned = 0;
    canvas.setPointerCapture(e.pointerId);
    e.preventDefault();
    return;
  }
  const p = toCell(e);
  // Pipette : Alt+clic reprend la matière sous le curseur, sans rien modifier.
  // Pipette : la matière vue par la dernière frame, pas une lecture du moteur
  // (il est sur l'autre fil). C'est la cellule sous le curseur, donc la bonne.
  if (e.altKey) { const id = under(p); if (id !== null) select(id); return; }
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
  const at = under(p);
  if ((current === SWITCH && at === SWITCH) || (current === MAGNET && at === MAGNET)) {
    gesture({ t: "toggle", x: p.x, y: p.y });
    return;
  }
  // Un clic, un lapin : ni trait au Maj, ni dépôt continu tant qu'on tient le
  // bouton — sinon un clic un peu long en empile une portée entière.
  if (placesCreature()) { paintAt(p.x, p.y); last = p; return; }
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
const probe = (p: { x: number; y: number }): void => {
  order({ t: "cursor", x: p.x, y: p.y });
  pointAt(p.x, p.y); // les autres joueurs d'un salon voient où l'on est
};

canvas.addEventListener("pointermove", (e) => {
  if (e.pointerType === "touch" && touches.has(e.pointerId)) {
    touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (touches.size === 2 && pinch) {
      const now = span();
      // Le milieu des doigts déplace la vue, leur écartement la zoome autour de
      // ce même milieu : un seul geste pour les deux.
      loosen(); // au doigt aussi, déplacer la vue la décroche du héros
      panBy(now.x - pinch.x, now.y - pinch.y);
      zoomAt(now.x, now.y, zoom * (now.gap / pinch.gap));
      pinch = now;
      return;
    }
  }
  if (panning) {
    panned += Math.abs(e.movementX) + Math.abs(e.movementY);
    if (panned >= CLICK && loosen()) {
      statusEl.textContent = "Caméra décrochée du héros — clic du milieu sans bouger pour la raccrocher.";
    }
    panBy(e.movementX, e.movementY);
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
    // Clic du milieu sans glisser : raccroche la caméra au héros.
    if (panning && type === "pointerup" && panned < CLICK && tighten()) {
      statusEl.textContent = "Caméra raccrochée au héros.";
    }
    panning = false;
    touches.delete((e as PointerEvent).pointerId);
    if (touches.size < 2) pinch = null;
  });
}
canvas.addEventListener("pointerleave", () => {
  order({ t: "cursor", x: -1, y: -1 }); // plus de curseur, plus de sonde
  pointAt(-1, -1);
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

const gravityButton = document.querySelector<HTMLButtonElement>("#gravity")!;
function flipGravity(): void {
  gravity = gravity === 1 ? -1 : 1;
  set({ gravity });
  gravityButton.textContent = gravity === 1 ? "Vers le bas ↓" : "Vers le haut ↑";
}
gravityButton.addEventListener("click", flipGravity);

const playButton = document.querySelector<HTMLButtonElement>("#play")!;
function toggleRun(): void {
  if (guest) { statusEl.textContent = FOLLOW; return; }
  running = !running;
  set({ running });
  playButton.textContent = running ? "Pause" : "Reprendre";
}
playButton.addEventListener("click", toggleRun);

document.querySelector<HTMLButtonElement>("#step")!.addEventListener("click", () => {
  if (guest) { statusEl.textContent = FOLLOW; return; }
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

/**
 * Nouveau monde : la graine tapée, sinon une au hasard, que la barre de statut
 * donne pour le retrouver. Le champ reste tel quel : vide, chaque clic tire
 * un autre monde ; rempli, il redonne le même. Le monde prend la taille du
 * bac — c'est en 1920×1080 qu'il y a le plus à explorer.
 */
const seedInput = document.querySelector<HTMLInputElement>("#seed")!;
function pickSeed(): number {
  const typed = Math.floor(Number(seedInput.value));
  return typed >= 1 && typed <= SEEDS ? typed : 1 + Math.floor(Math.random() * SEEDS);
}
document.querySelector<HTMLButtonElement>("#terrain")!.addEventListener("click", () => {
  const seed = pickSeed();
  order({ t: "terrain", seed });
  abandon();
  statusEl.textContent = `Monde n° ${seed} — la même graine redonne le même monde. Molette ou + pour zoomer, ZQSD pour se déplacer.`;
});

/** Pixels d'écran par cellule en mode exploration : le héros (sept cellules) y fait une quarantaine de pixels, comme celui de Terraria. */
const EXPLORE_PX = 6;

/**
 * Explorer : prototype du mode exploration, pour juger l'échelle avant de
 * bâtir les chunks. Un monde 1280×720 dont le décor garde une taille fixe
 * (`EXPLORE_SCALE`), vu de près sur le héros (`EXPLORE_PX`).
 * ponytail: le monde reste fini (1280×720, bords murés) et tout le bac est
 * colorié même hors champ ; à revoir avec la fenêtre glissante.
 */
document.querySelector<HTMLButtonElement>("#explore")!.addEventListener("click", () => {
  const seed = pickSeed();
  fit(1280);
  order({ t: "terrain", seed, scale: EXPLORE_SCALE });
  abandon();
  closeUp(EXPLORE_PX);
  // Le héros d'avant a pu laisser place au nouveau sans frame vide : `meet()`
  // ne serait pas rappelé, on pose donc l'échelle tout de suite.
  if (zoomInput.checked) scaleTo(EXPLORE_PX);
  statusEl.textContent = `Exploration, monde n° ${seed}. Molette pour ajuster le zoom.`;
});

// Surprise : un décor tiré au sort, sans objectif — juste pour regarder.
document.querySelector<HTMLButtonElement>("#surprise")!.addEventListener("click", () => {
  const scene = SCENES[Math.floor(Math.random() * SCENES.length)];
  fit(320);
  order({ t: "scene", name: scene.name });
  abandon();
  statusEl.textContent = `« ${scene.name} » — servez-vous.`;
});

document.querySelector<HTMLButtonElement>("#clear")!.addEventListener("click", () => {
  order({ t: "edit", do: "clear" });
  abandon();
});

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
  return askLoad(data, quiet).then((ok) => {
    // Avant que la galerie n'arme l'objectif d'un monde-défi : elle attend
    // cette même promesse.
    if (ok) abandon();
    return ok;
  });
}

/* ------------------------------------------------------------- bac partagé */

// Le salon vit dans room.ts ; il lui manque juste de quoi mettre un invité en
// pause et de quoi suivre la taille de grille de l'hôte.
initRoom({
  // Le geste d'un invité passe par le même point que les nôtres : sans ça il
  // manquerait de l'enregistrement de l'hôte.
  apply: gesture,
  role(host) {
    guest = !host;
    running = host;
    set({ running });
    playButton.textContent = running ? "Pause" : "Reprendre";
  },
  size(w) {
    fit(w);
  },
});

/* -------------------------------------------------------------------- défis */

/** Défi en cours. */
let challenge: Challenge | null = null;
const goalEl = document.querySelector<HTMLParagraphElement>("#goal")!;
const challengesEl = document.querySelector<HTMLDivElement>("#challenges")!;
/** Horloge murale : la pause et le ralenti comptent aussi, c'est un chrono de joueur. */
let startedAt = 0;
/** Le bouton du dernier défi lancé : la touche « recommencer » le reclique. */
let lastChallenge: HTMLButtonElement | null = null;

// Meilleur temps par défi, en secondes d'horloge murale, propre à ce
// navigateur. Le classement public (board.ts) compte en ticks : c'est ce que
// le rejeu joint prouve.
const RECORDS = "sandbox-rabbit:records";
const records = stored<Record<string, number>>(RECORDS, {});
const best = (name: string): string => (records[name] === undefined ? "" : ` (record : ${records[name]} s)`);

/** Lance le chrono et affiche le but. Commun aux défis livrés et aux mondes-défis. */
function startChallenge(c: Challenge): void {
  challenge = c;
  startedAt = performance.now();
  goalEl.textContent = `${c.name} — ${c.goal}${best(c.name)}`;
  // Un classement pour les défis livrés seulement : un monde-défi n'est pas bâti en code.
  if (CHALLENGES.includes(c)) void import("./board.ts").then((b) => b.show(c.name, watch));
}

/**
 * Le bac a été vidé, redimensionné ou remplacé : le défi en cours n'a plus
 * d'objet. Le bac l'a déjà désarmé ; sans ce pendant, la page affichait encore
 * son but et faisait tourner son chrono.
 */
function abandon(): void {
  closeUp(0); // le gros plan de l'exploration ne vaut que pour son monde
  forgetOrigin(); // ce n'est plus le monde de la galerie : resauvegardé, il ne sera pas son remix
  if (!challenge) return;
  goalEl.textContent = `${challenge.name} — abandonné.`;
  challenge = null;
}

for (const c of CHALLENGES) {
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = c.name;
  button.addEventListener("click", () => {
    lastChallenge = button;
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
  watch: (rec) => watch(rec),
});

/* -------------------------------------------------------------------- scène */

sizeInput.addEventListener("input", abandon);
initSound();
restore();


// Le bac est repris tel quel d'une visite à l'autre : le lien partagé passe
// devant, puis la dernière scène, et seulement à défaut la cuvette de départ.
// L'état vivant voyage avec (`snapshotData`) : un incendie laissé en plan
// repart chaud.
const BAC = "sandbox-rabbit:bac";
const kept = read(BAC);
// `quiet` : rien à annuler avant le premier geste. À défaut des deux, le bac a
// déjà graîné sa cuvette tout seul.
// Un lien de rejeu pose sa propre grille : le bac gardé ne servirait à rien.
if (location.hash.startsWith(`#${FILM_LINK}`)) void openFilmLink(location.hash.slice(FILM_LINK.length + 1));
else if (location.hash.length > 1) loadHash(location.hash.slice(1));
else if (kept) loadWorld(kept);

function loadHash(raw: string): void {
  let hash: string;
  try {
    hash = decodeURIComponent(raw);
  } catch {
    return; // « %zz » dans l'adresse : ce n'est pas un lien de partage
  }
  loadWorld(hash);
}

/**
 * « 320~<grille> » : un lien partagé, ou le bac rangé en mémoire locale. La
 * largeur précède la grille, sinon un monde 480 relu dans un bac 320 se décale
 * d'une ligne à chaque rangée. Sans elle (liens et bacs d'avant), on suppose le
 * bac tel qu'il est.
 */
function loadWorld(world: string): void {
  const cut = world.indexOf("~");
  if (cut > 0) void load(world.slice(cut + 1), Number(world.slice(0, cut)), true);
  else void load(world, undefined, true);
}

// `visibilitychange` plutôt que `beforeunload` : c'est le seul que les mobiles
// déclenchent vraiment quand l'onglet part en arrière-plan.
addEventListener("visibilitychange", () => {
  if (document.visibilityState !== "hidden") return;
  // La copie de secours du bac (quelques secondes de retard au pire, en grande
  // grille) : rien à demander, personne ne répondrait — la page s'en va.
  const grid = latestGrid();
  // Sa largeur avec, comme dans un lien : sans elle, un défi (320) rangé
  // depuis un bac réglé en 480 revenait cisaillé à la visite suivante. Celle
  // de la grille elle-même, pas `WIDTH` : juste après un redimensionnement,
  // la copie est encore celle de l'ancien bac.
  if (grid) write(BAC, `${grid.width}~${grid.data}`);
});

/* -------------------------------------------------------------------- rejeu */

/**
 * Enregistrer une partie, la regarder à nouveau. Rien n'est filmé : on garde la
 * grille de départ, l'état du tirage au sort et les gestes horodatés en ticks
 * (replay.ts). Une partie de dix minutes tient en quelques kilo-octets, et le
 * rejeu retombe sur la même grille au pixel près.
 *
 * Il s'exporte en lien ou en fichier, et s'importe de même (share.ts) : venu
 * d'ailleurs, il passe d'abord par `vet()` de replay.ts.
 */

const recButton = document.querySelector<HTMLButtonElement>("#rec")!;
const playbackButton = document.querySelector<HTMLButtonElement>("#replay")!;

/** Lance le rejeu que garde le bac. */
function playFilm(): void {
  if (!film) return;
  // Les scènes ont leur taille : un rejeu 480 dans un bac 320 se décalerait.
  if (film.w !== WIDTH) fit(film.w);
  // Un rejeu en pause ne se verrait pas avancer.
  running = true;
  set({ running });
  playButton.textContent = "Pause";
  order({ t: "play", on: true });
}

playbackButton.addEventListener("click", () => {
  if (playing) { order({ t: "play", on: false }); return; }
  playFilm();
});

/**
 * Un rejeu importé (lien, fichier) : il remplace le film du bac et se joue
 * aussitôt — on l'a ouvert pour le regarder.
 */
function watch(rec: Recording): void {
  if (guest) { statusEl.textContent = FOLLOW; return; }
  film = { w: rec.w, h: rec.h };
  playbackButton.disabled = false;
  order({ t: "reel", rec });
  playFilm();
}

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
  // On ne compte que les images neuves venues du bac : cette boucle-ci tourne
  // à 60 Hz quoi qu'il arrive (elle ne fait presque rien), la compter
  // affichait 60 fps même quand le Worker n'en livrait que 30.
  // Avec un héros, les touches le pilotent : même décrochée, la vue ne glisse
  // qu'à la souris.
  if (hero) { if (!loose) follow(hero); }
  else if (held.size > 0) scroll();
  if (present()) frames++;
  beat(now);
  gaze();
  placeCursors();
  captureFrame(); // vidéo en cours : la frame y part aussi

  if (now - lastReport >= 500) {
    fpsEl.textContent = String(Math.round((frames * 1000) / (now - lastReport)));
    frames = 0;
    lastReport = now;
  }
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

/** Défi réussi : le bac l'a vu, la page tient le chrono et les records. */
function win(film: Recording | null): void {
  if (!challenge) return;
  const c = challenge;
  if (CHALLENGES.includes(c)) void import("./board.ts").then((b) => b.won(c.name, film, watch));
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
    case "frame": {
      probeEl.textContent = news.probe
        ? `${MATERIALS[news.probe[0]].name} · ${Math.round(news.probe[1])} °C`
        : "–";
      if (track(news.hero)) steer();
      hear(news.heard, news.w);
      return;
    }
    case "stats":
      filledEl.textContent = news.filled.toLocaleString("fr-FR");
      setHum(news.hum);
      return;
    case "say":
      statusEl.textContent = news.text;
      return;
    case "won":
      return win(news.film);
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
