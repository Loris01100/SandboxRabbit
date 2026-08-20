/**
 * Le bac lui-même : canvas, moteur, rendu, et la taille de la grille.
 *
 * Ces valeurs sont réassignées par `resize()` — les autres modules les
 * importent comme des liaisons vivantes (`import { engine }`), donc ils voient
 * la nouvelle instance sans rien à rebrancher. Tout ce qui dépend de la taille
 * s'inscrit dans `onResize`, ce qui évite à ce module de connaître le panneau.
 */
import { Engine } from "./sim/engine.ts";
import { Renderer } from "./sim/render.ts";
import { SAND, STONE, WATER } from "./sim/materials.ts";

export const canvas = document.querySelector<HTMLCanvasElement>("#world")!;

// La taille de la grille est un réglage : `Engine` et `Renderer` sont recréés
// à chaque changement (le rendu écrit dans un ImageData de la taille exacte).
export let WIDTH = 320;
export let HEIGHT = 180;
export let engine = new Engine(WIDTH, HEIGHT);
export let renderer = new Renderer(canvas, engine);

/** Rappelés après un redimensionnement : piles d'annulation, vue, etc. */
export const onResize: (() => void)[] = [];

/**
 * Change la taille de la grille. Tout est refait en reportant les réglages du
 * monde ; `keep` évite de regraîner quand la grille reçue d'un hôte impose sa
 * taille.
 */
export function resize(width: number, height: number, keep = false): void {
  const { wind, ambient, gravity, emit } = engine;
  const heatmap = renderer.heatmap;
  WIDTH = width;
  HEIGHT = height;
  engine = new Engine(width, height);
  Object.assign(engine, { wind, ambient, gravity, emit });
  renderer = new Renderer(canvas, engine);
  renderer.heatmap = heatmap;
  for (const listener of onResize) listener();
  if (!keep) seed();
}

/** Une petite cuvette de pierre avec du sable et de l'eau, pour ne pas démarrer devant du vide. */
export function seed(): void {
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
