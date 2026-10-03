/**
 * Mesure : `npm run bench`. Combien de ticks par seconde tient le moteur, et à
 * quelle taille de grille il décroche sous les 60 fps. Il sert à décider si le
 * moteur mérite un jour d'être réécrit ailleurs (WASM), plutôt qu'à le supposer.
 *
 * Il porte aussi un budget, et sort en erreur au-delà : c'est ce qui rend la
 * mesure utile en CI, où personne ne lit le tableau.
 *
 * Le budget est un seuil absolu : il attrape un effondrement (le tick était
 * à 1,6 ms avant les tableaux typés), pas une dérive de 20 % — un runner
 * partagé varie déjà plus que ça d'une exécution à l'autre. La dérive, c'est
 * `npm run drift` (test/drift.ts) qui la voit : il mesure la branche de base
 * sur la même machine, dans la foulée, et compare. `BENCH_JSON=fichier` écrit
 * ici les mesures pour lui.
 */
import { writeFileSync } from "node:fs";
import { Engine } from "../src/client/sim/engine.ts";
import { FIRE, OIL, SAND, STONE, WATER, WOOD } from "../src/client/sim/materials.ts";
import { EXPLORE_SCALE, STRIP, land } from "../src/client/terrain.ts";

const TICKS = 300;
/** Budget du tick en 320×180, en ms. Large : le runner de CI n'est pas cette machine. */
const BUDGET = Number(process.env.BENCH_BUDGET_MS ?? 4);

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
let budget = 0;
const measured: Record<string, { value: number; unit: string }> = {};
for (const [w, h] of [[320, 180], [480, 270], [640, 360], [1280, 720], [1920, 1080]] as const) {
  const e = scene(w, h);
  for (let t = 0; t < 30; t++) e.step(); // chauffe le JIT
  const start = performance.now();
  for (let t = 0; t < TICKS; t++) e.step();
  const ms = (performance.now() - start) / TICKS;
  // À vitesse ×1 la boucle fait un tick par frame : le tick doit tenir dans 16,7 ms.
  const fps = Math.min(60, 1000 / ms);
  if (w === 320) budget = ms;
  measured[`tick ${w}×${h}`] = { value: ms, unit: "ms" };
  console.log(
    `${w}×${h}`.padEnd(14) +
      String(w * h).padEnd(11) +
      ms.toFixed(2).padStart(7) +
      String(Math.round(1000 / ms)).padStart(10) +
      `${Math.round(fps)}`.padStart(11),
  );
}

// Une tranche du monde infini (`land()`, docs/agents/exploration.md) : ce que
// coûtera chaque chunk qui entre dans la fenêtre. Mesurée, pas budgétée : le
// mode la bâtira d'avance, hors du tick (étape 3).
{
  const e = new Engine(1280, 720, 1);
  for (let k = 0; k < 3; k++) land(e, 4217, EXPLORE_SCALE, k * STRIP, 0, STRIP);
  const runs = 10, start = performance.now();
  for (let k = 0; k < runs; k++) land(e, 4217, EXPLORE_SCALE, (k + 3) * STRIP, 0, STRIP);
  const ms = (performance.now() - start) / runs;
  measured[`tranche ${STRIP}×720`] = { value: ms, unit: "ms" };
  console.log(`\ntranche du monde infini (${STRIP}×720) : ${ms.toFixed(1)} ms`);

  // Le décalage lui-même (`shift()`), sans la tranche : ce qu'il coûte au tick où il tombe.
  for (let k = 0; k < 3; k++) { e.shift(STRIP); e.shift(-STRIP); }
  const t0 = performance.now();
  for (let k = 0; k < runs; k++) { e.shift(STRIP); e.shift(-STRIP); }
  const slid = (performance.now() - t0) / (2 * runs);
  measured[`décalage 1280×720`] = { value: slid, unit: "ms" };
  console.log(`décalage de la fenêtre (1280×720, ${STRIP} colonnes) : ${slid.toFixed(1)} ms`);
}

if (process.env.BENCH_JSON) writeFileSync(process.env.BENCH_JSON, JSON.stringify(measured));

if (budget > BUDGET) {
  console.error(`
✗ budget dépassé : ${budget.toFixed(2)} ms/tick en 320×180, budget ${BUDGET} ms`);
  process.exit(1);
}
console.log(`
budget : ${budget.toFixed(2)} ms/tick en 320×180, plafond ${BUDGET} ms`);
