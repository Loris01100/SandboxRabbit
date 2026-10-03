/**
 * Le bac vu de la page : le canvas, la taille de la grille, et le fil qui
 * simule.
 *
 * Depuis que la simulation vit dans un Worker (sim/sandbox.ts), ce module est
 * la seule porte entre les deux : les autres envoient des **ordres**
 * (`order()`) et s'abonnent aux **nouvelles** (`listen()`). Personne ici ne
 * touche plus au moteur — le fil principal tient un miroir de la grille et le
 * fait colorier par la carte graphique (screen.ts), ce qui laisse le panneau,
 * le zoom et le pinceau fluides pendant qu'une explosion occupe l'autre fil.
 *
 * `WIDTH`/`HEIGHT` sont **réassignés** par `resize()` et importés comme
 * liaisons vivantes (`import { WIDTH }`) : personne n'a à se rebrancher. Ce qui
 * dépend de la taille s'inscrit dans `onResize`.
 */
import type { Knobs, News, Order } from "./sim/sandbox.ts";
import { HOURS, glide, land, type Grid, type Mirror, type Tint } from "./sim/render.ts";
import type { Recording } from "./replay.ts";
import { createScreen } from "./screen.ts";
import { watchErrors } from "./errors.ts";
import { framePeriod, refreshPeriod } from "./ui.ts";

export const canvas = document.querySelector<HTMLCanvasElement>("#world")!;
/** Ce qui colorie le canvas : WebGL2, sinon 2D (screen.ts). */
export const screen = createScreen(canvas);

export let WIDTH = 320;
export let HEIGHT = 180;

/**
 * Où sont les cellules à l'écran : coin de la première et taille d'une
 * cellule en x et en y, en pixels. Sans la bordure du canvas, que le zoom
 * grossit comme le reste : à ×12 elle faisait presque une cellule, et le
 * cadre du héros, le clic et la sélection tombaient une case trop haut à
 * gauche.
 */
export function cellBox(): { left: number; top: number; sx: number; sy: number } {
  const r = canvas.getBoundingClientRect(), k = r.width / canvas.offsetWidth;
  return {
    left: r.left + canvas.clientLeft * k,
    top: r.top + canvas.clientTop * k,
    sx: (canvas.clientWidth * k) / WIDTH,
    sy: (canvas.clientHeight * k) / HEIGHT,
  };
}

/** Rappelés après un redimensionnement : vue, marquee, etc. */
export const onResize: (() => void)[] = [];

const sim = new Worker(new URL("./sim/worker.ts", import.meta.url), { type: "module" });
watchErrors(sim);
sim.postMessage({ t: "start", w: WIDTH, h: HEIGHT });

/**
 * Envoie un ordre au bac. La vue thermique, elle, ne regarde plus que la
 * page : c'est elle qui colorie. On la relève au passage plutôt que de
 * demander à chaque réglage de l'annoncer deux fois.
 */
export function order(o: Order): void {
  if (o.t === "set" && o.k.heatmap !== undefined && o.k.heatmap !== heatmap) {
    heatmap = o.k.heatmap;
    repaint = true;
  }
  sim.postMessage(o);
}

/** Change des réglages du bac (ordre `set`). */
export const set = (k: Partial<Knobs>): void => order({ t: "set", k });

/**
 * Allume ou éteint l'éclairage global (screen.ts). Réglage de la page seule,
 * comme la vue thermique : le bac n'en sait rien, on recolorie tout.
 */
export function light(on: boolean): void {
  if (on === lit) return;
  lit = on;
  repaint = true;
}

/**
 * La vue pression : l'air coloré par sa pression (`shadeAir` de render.ts).
 * Réglage de la page seule, comme l'éclairage ; elle passe devant la vue
 * thermique si les deux sont cochées.
 */
export function airView(on: boolean): void {
  if (on === airmap) return;
  airmap = on;
  repaint = true;
}

/**
 * L'heure de la journée (`HOURS` de render.ts). Réglage de la page seule,
 * comme l'éclairage : le bac et le salon n'en savent rien, on recolorie tout.
 */
export function hour(t: Tint): void {
  if (t.every((v, k) => v === tint[k])) return;
  tint = t;
  repaint = true;
}

const listeners: ((news: News) => void)[] = [];

/** S'abonne aux nouvelles du bac. */
export function listen(fn: (news: News) => void): void {
  listeners.push(fn);
}

/**
 * La copie de secours de la grille (état vivant compris), refaite par le bac
 * quand il a changé — toutes les 250 ms en 640×360, plus rarement au-delà.
 * Elle sert à ranger le bac dans la mémoire locale quand la page part en
 * arrière-plan, sans attendre le Worker : aucune promesse n'y serait tenue.
 * Sauvegarder et partager demandent une grille fraîche (`askGrid`). Elle
 * porte la largeur du bac qui l'a faite : `WIDTH` suit un redimensionnement
 * tout de suite, la copie un quart de seconde plus tard, et ranger l'une sous
 * l'autre cisaillait le bac à la visite suivante.
 */
let latest: { width: number; data: string } | null = null;
export const latestGrid = (): { width: number; data: string } | null => latest;

/** Les questions dont on attend une réponse : un numéro, une promesse. */
let asked = 0;
const waiting = new Map<number, (value: unknown) => void>();

/** Pose une grille dans le bac. Répond false si elle était illisible. */
export function askLoad(data: string, quiet = false): Promise<boolean> {
  const ask = ++asked;
  return new Promise((resolve) => {
    waiting.set(ask, resolve as (value: unknown) => void);
    order({ t: "load", data, ask, quiet });
  });
}

/**
 * La grille entière, encodée à l'instant par le bac : ce que sauvegarder ou
 * partager doit porter. `latestGrid()` n'est qu'une copie de secours, refaite
 * de loin en loin — jusqu'à deux secondes de retard en 1920×1080.
 */
export function askGrid(): Promise<string> {
  const ask = ++asked;
  return new Promise((resolve) => {
    waiting.set(ask, resolve as (value: unknown) => void);
    order({ t: "grid", ask });
  });
}

/** Le dernier rejeu enregistré ou importé, pour l'exporter ; null s'il n'y en a pas. */
export function askFilm(): Promise<Recording | null> {
  const ask = ++asked;
  return new Promise((resolve) => {
    waiting.set(ask, resolve as (value: unknown) => void);
    order({ t: "film", ask });
  });
}

/** Le morceau de grille sous le rectangle, encodé comme le veut le geste « clip ». */
export interface ClipData { w: number; h: number; cells: string; life: string }

export function askClip(x: number, y: number, x2: number, y2: number): Promise<ClipData> {
  const ask = ++asked;
  return new Promise((resolve) => {
    waiting.set(ask, resolve as (value: unknown) => void);
    order({ t: "clip", ask, x, y, x2, y2 });
  });
}

/**
 * Le miroir de la grille, tenu à jour par les bandes reçues (`blit()`) :
 * matière, `life`, figé, grain, température au degré et pression par palier
 * — ce que l'écran colorie. Remplacé en entier quand la taille change.
 */
let mirror: Mirror | null = null;
/** Une frame est arrivée depuis le dernier `present()`. */
let fresh = false;
/** Tout recolorier au prochain `present()` : vue thermique basculée, ambiante changée. */
let repaint = false;
let heatmap = false;
let airmap = false;
let lit = true;
let tint: Tint = HOURS["apres-midi"];
/** Le rectangle changé depuis le dernier `present()`, en cellules, bords droit et bas exclus. */
let left = Infinity, top = Infinity, right = 0, bottom = 0;

/**
 * Recopie les bandes d'une frame dans le miroir, **dès leur arrivée** : une
 * frame ne porte que ce qui a changé, en sauter une laisserait un morceau de
 * bac en retard pour de bon — et deux frames arrivent souvent entre deux
 * rafraîchissements, onglet en arrière-plan plus encore. Une taille nouvelle
 * part d'un miroir neuf : la première frame d'un moteur neuf est entière,
 * grain compris.
 */
function blit(frame: Extract<News, { t: "frame" }>): void {
  const { w, h } = frame;
  if (!mirror || mirror.width !== w || mirror.height !== h) {
    const n = w * h;
    mirror = {
      width: w, height: h, ambient: frame.ambient,
      cells: new Uint8Array(n), life: new Uint8Array(n), frozen: new Uint8Array(n),
      noise: new Int8Array(n), temp: new Float32Array(n), press: new Float32Array(n),
    };
  }
  const m = mirror;
  if (m.ambient !== frame.ambient) { m.ambient = frame.ambient; repaint = true; }
  if (frame.origin !== origin) {
    // La fenêtre d'exploration a glissé : le miroir glisse d'autant, comme la
    // grille du bac (`Engine.shift()`), avant que les bandes de la frame — la
    // bande neuve et ce qu'ont changé les ticks — s'y posent. Le bac n'envoie
    // plus que celles-là : 11 Mo par chunk traversé, c'étaient deux ou trois
    // images sautées.
    if (frame.origin !== null && origin !== null) {
      const dx = frame.origin - origin;
      slid += dx;
      glide(m, dx);
      repaint = true;
    }
    origin = frame.origin;
  }
  for (const p of frame.patches) {
    land(m, p);
    left = Math.min(left, p.x);
    top = Math.min(top, p.y);
    right = Math.max(right, p.x + p.w);
    bottom = Math.max(bottom, p.y + p.h);
  }
  fresh = true;
}

/** En exploration, la colonne du monde qui est la colonne 0 du bac ; null hors du mode. */
export let origin: number | null = null;
/** Colonnes dont la fenêtre d'exploration a glissé depuis le dernier `present()`. */
let slid = 0;

/**
 * Colonnes dont la fenêtre a glissé dans ce qu'a posé le dernier `present()`,
 * remises à zéro. La caméra se décale d'autant **dans la même image** que le
 * dessin (`slideBy()` de view.ts) : décalée à l'arrivée de la frame, elle
 * montrait une image l'ancien bac au mauvais endroit ; pas décalée du tout,
 * elle rattrapait le héros en dix images, la vue filant d'un chunk.
 */
export function shifted(): number {
  const d = slid;
  slid = 0;
  return d;
}

/** Le miroir de la grille, en lecture : ce que voit le héros (sight.ts) s'y calcule. Null avant la première frame. */
export const seen = (): Readonly<Grid> | null => mirror;

/**
 * Pose ce qui a changé depuis l'appel précédent. Appelé par la boucle
 * `requestAnimationFrame` de la page : on dessine au rythme de l'écran, et
 * tout ce qui est arrivé entre deux rafraîchissements ne coûte qu'un envoi à
 * l'écran, limité au rectangle changé. Renvoie `true` quand une frame neuve
 * est arrivée — c'est ce que compte l'affichage des fps.
 *
 * Le canvas suit la taille de la grille (le CSS `pixelated` met à l'échelle).
 * Le redimensionner l'efface : on repose alors tout.
 */
export function present(): boolean {
  if ((!fresh && !repaint) || !mirror) return false;
  const arrived = fresh;
  if (canvas.width !== mirror.width || canvas.height !== mirror.height) {
    canvas.width = mirror.width;
    canvas.height = mirror.height;
    repaint = true;
  }
  if (repaint) { left = 0; top = 0; right = mirror.width; bottom = mirror.height; }
  screen.paint(mirror, left, top, right, bottom, airmap ? "air" : heatmap ? "heat" : "matter", lit, tint);
  fresh = false;
  repaint = false;
  left = Infinity; top = Infinity; right = 0; bottom = 0;
  return arrived;
}

/** Les derniers écarts entre deux rafraîchissements, la période de l'écran, la limite choisie et la période déjà dite au Worker. */
const gaps: number[] = [];
let lastBeat = 0;
let refresh = 1000 / 60;
let cap = 0;
let told = 1000 / 60;

/** Dit au Worker la période visée (`pace`), si elle a bougé de plus de 5 % : le bruit des mesures ne doit pas faire un message par seconde. */
function pace(): void {
  const period = framePeriod(refresh, cap);
  if (Math.abs(period - told) / told < 0.05) return;
  told = period;
  sim.postMessage({ t: "pace", ms: period });
}

/**
 * À appeler à chaque `requestAnimationFrame` : mesure la fréquence de l'écran
 * et la dit au Worker, qui cadence ses frames dessus. Remesurée en continu —
 * une fenêtre passée sur un autre écran change de fréquence.
 */
export function beat(now: number): void {
  if (lastBeat > 0) gaps.push(now - lastBeat);
  lastBeat = now;
  if (gaps.length < 60) return;
  refresh = refreshPeriod(gaps);
  gaps.length = 0;
  pace();
}

/**
 * Limite les images par seconde du Worker (0 : celles de l'écran). Réglage
 * de la page seule (Paramètres › Graphismes) : le bac simule à la même
 * vitesse, le salon n'en sait rien.
 */
export function limitFps(hz: number): void {
  cap = hz;
  pace();
}

/**
 * La finesse de l'éclairage : largeur de sa grille en texels (screen.ts).
 * Réglage de la page seule, comme l'éclairage lui-même ; on recolorie tout.
 */
export function lightDetail(width: number): void {
  screen.detail(width);
  repaint = true;
}

sim.addEventListener("message", (e: MessageEvent<News>) => {
  const news = e.data;
  if (news.t === "frame") blit(news);
  if (news.t === "grid") latest = { width: news.w, data: news.full };
  if (news.t === "reply") {
    waiting.get(news.ask)?.(news.value);
    waiting.delete(news.ask);
  }
  for (const fn of listeners) fn(news);
  // Les bandes sont posées dans le miroir : leur tampon repart au Worker, qui
  // le réutilise plutôt que d'en allouer un neuf (`recycle()` de render.ts).
  // Après les abonnés, qui reçoivent encore la frame intacte.
  if (news.t === "frame" && news.patches.length > 0) {
    const buffer = news.patches[0].cells.buffer as ArrayBuffer;
    sim.postMessage({ t: "spare", buffer }, [buffer]);
  }
});

/**
 * Change la taille de la grille. `keep` évite de regraîner quand la grille
 * reçue d'un hôte impose sa taille.
 *
 * `WIDTH`/`HEIGHT` changent tout de suite — c'est avec eux que la page traduit
 * un clic en cellule — et le bac suit d'une frame ou deux.
 */
export function resize(width: number, height: number, keep = false): void {
  WIDTH = width;
  HEIGHT = height;
  order({ t: "size", w: width, h: height, keep });
  for (const listener of onResize) listener();
}
