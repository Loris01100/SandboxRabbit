/**
 * Mesure : `npm run bench`. Combien de ticks par seconde tient le moteur, et à
 * quelle taille de grille il décroche sous les 60 fps.
 * Pas d'assert — c'est un instrument, pas un test. Il sert à décider si le
 * moteur mérite un jour d'être réécrit ailleurs (WASM), plutôt qu'à le supposer.
 */
import { Engine } from "../src/client/sim/engine.ts";
import { FIRE, OIL, SAND, STONE, WATER, WOOD } from "../src/client/sim/materials.ts";

const TICKS = 300;

/** Une scène qui remue : du sable qui coule, de l'eau qui s'étale, un feu qui court. */
function scene(width: number, height: number): Engine {
  const e = new Engine(width, height);
  const s = width / 320; // les mêmes proportions quelle que soit la grille
  for (let x = 0; x < width; x++) {
    const bowl = Math.round(height - 12 * s - 26 * s * Math.sin((x / width) * Math.PI));
    for (let y = bowl; y < height; y++) e.set(x, y, STONE);
  }
  const block = (x0: number, y0: number, x1: number, y1: number, id: number): void => {
    for (let x = x0 * s; x < x1 * s; x++) for (let y = y0 * s; y < y1 * s; y++) e.set(x | 0, y | 0, id);
  };
  block(40, 40, 120, 80, SAND);
  block(180, 30, 280, 70, WATER);
  block(140, 120, 200, 140, WOOD);
  block(150, 100, 170, 110, OIL);
  block(150, 90, 160, 95, FIRE);
  return e;
}

console.log(`${TICKS} ticks par mesure\n`);
console.log("grille        cellules   ms/tick   ticks/s   fps à ×1");
for (const [w, h] of [[320, 180], [480, 270], [640, 360]] as const) {
  const e = scene(w, h);
  for (let t = 0; t < 30; t++) e.step(); // chauffe le JIT
  const start = performance.now();
  for (let t = 0; t < TICKS; t++) e.step();
  const ms = (performance.now() - start) / TICKS;
  // À vitesse ×1 la boucle fait un tick par frame : le tick doit tenir dans 16,7 ms.
  const fps = Math.min(60, 1000 / ms);
  console.log(
    `${w}×${h}`.padEnd(14) +
      String(w * h).padEnd(11) +
      ms.toFixed(2).padStart(7) +
      String(Math.round(1000 / ms)).padStart(10) +
      `${Math.round(fps)}`.padStart(11),
  );
}
