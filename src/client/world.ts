/**
 * Le bac vu de la page : le canvas, la taille de la grille, et le fil qui
 * simule.
 *
 * Depuis que la simulation vit dans un Worker (sim/sandbox.ts), ce module est
 * la seule porte entre les deux : les autres envoient des **ordres**
 * (`order()`) et s'abonnent aux **nouvelles** (`listen()`). Personne ici ne
 * touche plus au moteur — le fil principal n'a plus qu'à poser les pixels
 * reçus, ce qui laisse le panneau, le zoom et le pinceau fluides pendant qu'une
 * explosion occupe l'autre fil.
 *
 * `WIDTH`/`HEIGHT` sont **réassignés** par `resize()` et importés comme
 * liaisons vivantes (`import { WIDTH }`) : personne n'a à se rebrancher. Ce qui
 * dépend de la taille s'inscrit dans `onResize`.
 */
import type { News, Order } from "./sim/sandbox.ts";

export const canvas = document.querySelector<HTMLCanvasElement>("#world")!;
const ctx = canvas.getContext("2d", { alpha: false })!;

export let WIDTH = 320;
export let HEIGHT = 180;

/** Rappelés après un redimensionnement : vue, marquee, etc. */
export const onResize: (() => void)[] = [];

const sim = new Worker(new URL("./sim/worker.ts", import.meta.url), { type: "module" });
sim.postMessage({ t: "start", w: WIDTH, h: HEIGHT });

export function order(o: Order): void {
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

/** L'image entière du bac, tenue à jour par les bandes reçues (`blit()`). */
let image: ImageData | null = null;
/** Une frame est arrivée depuis le dernier `present()`. */
let fresh = false;
/** Le rectangle changé depuis le dernier `present()`, en pixels, bords droit et bas exclus. */
let left = Infinity, top = Infinity, right = 0, bottom = 0;

/**
 * Recopie les bandes d'une frame dans l'image, **dès leur arrivée** : une
 * frame ne porte que ce qui a changé, en sauter une laisserait un morceau de
 * bac en retard pour de bon — et deux frames arrivent souvent entre deux
 * rafraîchissements, onglet en arrière-plan plus encore. Une taille nouvelle
 * part d'une image neuve : la première frame d'un moteur neuf est entière.
 */
function blit(frame: Extract<News, { t: "frame" }>): void {
  if (!image || image.width !== frame.w || image.height !== frame.h) image = new ImageData(frame.w, frame.h);
  const { data, width } = image;
  for (const p of frame.patches) {
    const row = p.w * 4;
    for (let r = 0; r < p.h; r++) data.set(p.pixels.subarray(r * row, (r + 1) * row), ((p.y + r) * width + p.x) * 4);
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
 * tout ce qui est arrivé entre deux rafraîchissements ne coûte qu'un
 * `putImageData`, limité au rectangle changé. Renvoie `true` quand une frame
 * neuve est arrivée — c'est ce que compte l'affichage des fps.
 *
 * Le canvas suit la taille de la grille (le CSS `pixelated` met à l'échelle).
 * Le redimensionner l'efface : on repose alors l'image entière.
 */
export function present(): boolean {
  if (!fresh || !image) return false;
  fresh = false;
  if (canvas.width !== image.width || canvas.height !== image.height) {
    canvas.width = image.width;
    canvas.height = image.height;
    left = 0; top = 0; right = image.width; bottom = image.height;
  }
  if (right > left) ctx.putImageData(image, 0, 0, left, top, right - left, bottom - top);
  left = Infinity; top = Infinity; right = 0; bottom = 0;
  return true;
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
