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

sim.addEventListener("message", (e: MessageEvent<News>) => {
  const news = e.data;
  if (news.t === "frame") {
    // Le canvas suit la taille de la grille : c'est le CSS (`pixelated`) qui
    // met à l'échelle, un seul `putImageData` par frame comme avant.
    if (canvas.width !== news.w) { canvas.width = news.w; canvas.height = news.h; }
    // Le tableau vient d'un clone structuré : TypeScript lui donne un
    // `ArrayBufferLike`, `ImageData` veut un `ArrayBuffer` — c'en est un.
    ctx.putImageData(new ImageData(news.pixels as Uint8ClampedArray<ArrayBuffer>, news.w, news.h), 0, 0);
  }
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
