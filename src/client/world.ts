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
import type { News, Order } from "./sim/sandbox.ts";
import type { Grid } from "./sim/render.ts";
import { createScreen } from "./screen.ts";

export const canvas = document.querySelector<HTMLCanvasElement>("#world")!;
/** Ce qui colorie le canvas : WebGL2, sinon 2D (screen.ts). */
export const screen = createScreen(canvas);

export let WIDTH = 320;
export let HEIGHT = 180;

/** Rappelés après un redimensionnement : vue, marquee, etc. */
export const onResize: (() => void)[] = [];

const sim = new Worker(new URL("./sim/worker.ts", import.meta.url), { type: "module" });
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

const listeners: ((news: News) => void)[] = [];

/** S'abonne aux nouvelles du bac. */
export function listen(fn: (news: News) => void): void {
  listeners.push(fn);
}

/**
 * La dernière grille encodée reçue du bac (état vivant compris), rafraîchie
 * quatre fois par seconde. Sauvegarder, partager ou ranger le bac dans la
 * mémoire locale n'a donc pas à attendre le Worker — ce qui compte quand la
 * page part en arrière-plan et qu'aucune promesse ne sera tenue.
 */
let latest = "";
export const latestGrid = (): string => latest;

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
 * matière, `life`, figé, grain et température au degré — ce que l'écran
 * colorie. Remplacé en entier quand la taille change.
 */
let mirror: Grid & { temp: Int16Array } | null = null;
/** Une frame est arrivée depuis le dernier `present()`. */
let fresh = false;
/** Tout recolorier au prochain `present()` : vue thermique basculée, ambiante changée. */
let repaint = false;
let heatmap = false;
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
      noise: new Int8Array(n), temp: new Int16Array(n),
    };
  }
  if (mirror.ambient !== frame.ambient) { mirror.ambient = frame.ambient; repaint = true; }
  for (const p of frame.patches) {
    for (let r = 0; r < p.h; r++) {
      const from = r * p.w, to = (p.y + r) * w + p.x;
      mirror.cells.set(p.cells.subarray(from, from + p.w), to);
      mirror.life.set(p.life.subarray(from, from + p.w), to);
      mirror.frozen.set(p.frozen.subarray(from, from + p.w), to);
      mirror.temp.set(p.temp.subarray(from, from + p.w), to);
      if (p.noise) mirror.noise.set(p.noise.subarray(from, from + p.w), to);
    }
    left = Math.min(left, p.x);
    top = Math.min(top, p.y);
    right = Math.max(right, p.x + p.w);
    bottom = Math.max(bottom, p.y + p.h);
  }
  fresh = true;
}

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
  screen.paint(mirror, left, top, right, bottom, heatmap);
  fresh = false;
  repaint = false;
  left = Infinity; top = Infinity; right = 0; bottom = 0;
  return arrived;
}

sim.addEventListener("message", (e: MessageEvent<News>) => {
  const news = e.data;
  if (news.t === "frame") blit(news);
  if (news.t === "grid") latest = news.full;
  if (news.t === "reply") {
    waiting.get(news.ask)?.(news.value);
    waiting.delete(news.ask);
  }
  for (const fn of listeners) fn(news);
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
