/**
 * Un cœur de `npm run directions`. Il partage la grille avec les autres
 * (`SharedArrayBuffer`) et attend son tour sur une barrière `Atomics` : pas de
 * `postMessage` par phase, dont le coût fausserait la mesure.
 *
 * `control` : [0] numéro de tâche, [1] tâches finies, [2] type (1 sable, 2
 * chaleur), [3] tick ou sens des tampons, [4] phase du damier (0..3).
 */
import { parentPort, workerData } from "node:worker_threads";
import { diffuseRows, phaseBlocks, sandBlock } from "./directions-kernels.ts";

const { cells, clock, tempA, tempB, control, w, h, index, count } = workerData as {
  cells: SharedArrayBuffer; clock: SharedArrayBuffer; tempA: SharedArrayBuffer; tempB: SharedArrayBuffer;
  control: SharedArrayBuffer; w: number; h: number; index: number; count: number;
};
const grid = new Uint8Array(cells), ticks = new Uint8Array(clock);
const a = new Float32Array(tempA), b = new Float32Array(tempB);
const ctl = new Int32Array(control);
const phases = [phaseBlocks(w, h, 0, 0), phaseBlocks(w, h, 1, 0), phaseBlocks(w, h, 0, 1), phaseBlocks(w, h, 1, 1)];

let seen = 0;
parentPort!.postMessage("prêt");
for (;;) {
  Atomics.wait(ctl, 0, seen);
  seen = Atomics.load(ctl, 0);
  if (seen < 0) break;
  if (ctl[2] === 1) {
    const blocks = phases[ctl[4]];
    for (let k = index * 2; k < blocks.length; k += count * 2) sandBlock(grid, ticks, w, h, blocks[k], blocks[k + 1], ctl[3]);
  } else {
    const band = Math.ceil(h / count);
    const y0 = index * band, y1 = Math.min(h, y0 + band);
    if (ctl[3] === 0) diffuseRows(a, b, w, h, y0, y1);
    else diffuseRows(b, a, w, h, y0, y1);
  }
  if (Atomics.add(ctl, 1, 1) === count - 1) Atomics.notify(ctl, 1);
}
