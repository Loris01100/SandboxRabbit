/**
 * Le moteur sur plusieurs fils : `npm run check` (Node exécute le TS tel quel).
 *
 * La propriété dont tout dépend : **le résultat d'un tick ne dépend pas du
 * nombre de fils**. Un hôte à huit cœurs et un invité à deux doivent rester
 * en phase dans un salon, un rejeu doit retomber sur sa grille, et une page
 * sans mémoire partagée simule sur un seul fil. On fait donc tourner la même
 * partie deux fois — seul, puis avec trois fils auxiliaires — et on compare,
 * au bit près.
 */
import assert from "node:assert/strict";
import { Worker } from "node:worker_threads";
import { Engine } from "../src/client/sim/engine.ts";
import { Pool, type Helper } from "../src/client/sim/pool.ts";
import { applyGesture } from "../src/client/gestures.ts";
import { terrain } from "../src/client/terrain.ts";
import { FIRE, LAVA, NITRO, PILOT, SAND, TNT, URANIUM, WATER, WOOD } from "../src/client/sim/materials.ts";

/** `count` fils auxiliaires sous Node, et de quoi les arrêter. */
function helpers(count: number): { list: Helper[]; stop: () => Promise<void> } {
  const workers = Array.from({ length: count }, () => new Worker(new URL("./helper.ts", import.meta.url)));
  const list = workers.map((w): Helper => ({
    post: (message) => w.postMessage(message),
    listen: (fn) => { w.on("message", fn); },
  }));
  return { list, stop: async () => { await Promise.all(workers.map((w) => w.terminate())); } };
}

/** Une partie qui réveille beaucoup de règles : un monde généré, du feu, des explosifs, un héros piloté. */
function partie(e: Engine): void {
  e.clear();
  terrain(e, 4217);
  const s = e.width / 320;
  e.rect(40 * s, 10 * s, 80 * s, 20 * s, SAND);
  e.rect(200 * s, 5 * s, 260 * s, 15 * s, WATER);
  e.rect(120 * s, 30 * s, 140 * s, 40 * s, WOOD);
  e.paint(130 * s, 29 * s, 3, FIRE);
  e.rect(150 * s, 12 * s, 156 * s, 16 * s, TNT);
  e.paint(153 * s, 11 * s, 1, LAVA);
  e.rect(100 * s, 5 * s, 101 * s, 6 * s, NITRO);
  e.rect(290 * s, 20 * s, 294 * s, 24 * s, URANIUM);
}

const signature = (e: Engine) => ({
  cells: e.cells.slice(), life: e.life.slice(), temp: e.temp.slice(), frozen: e.frozen.slice(), seed: e.seed,
});

const W = 640, H = 360, TICKS = 400;
const seul = new Engine(W, H, 99);
const { list, stop } = helpers(3);
const pool = new Pool(list);
const multi = new Engine(W, H, 99);
await pool.bind(multi);
assert.ok(multi.pool, "le pool s'attache au moteur une fois ses fils prêts");

partie(seul);
partie(multi);
let t0 = performance.now(), ms1 = 0, ms4 = 0;
for (let t = 0; t < TICKS; t++) {
  const keys = t < 100 ? PILOT.right : t < 200 ? PILOT.right | PILOT.dig : t < 300 ? PILOT.left | PILOT.up : 0;
  applyGesture(seul, { t: "pilot", keys });
  applyGesture(multi, { t: "pilot", keys });
  t0 = performance.now(); seul.step(); ms1 += performance.now() - t0;
  t0 = performance.now(); multi.step(); ms4 += performance.now() - t0;
}
assert.deepEqual(signature(multi), signature(seul), `${TICKS} ticks sur 4 fils = ${TICKS} ticks sur 1, au bit près`);
console.log(`   640×360, ${TICKS} ticks : 1 fil ${(ms1 / TICKS).toFixed(2)} ms/tick, 4 fils ${(ms4 / TICKS).toFixed(2)} ms/tick`);

const autre = new Engine(320, 180, 7), témoin = new Engine(320, 180, 7);
await pool.bind(autre);
assert.equal(multi.pool, null, "l'ancien moteur est lâché : il retombe sur un seul fil, sans rien perdre");
partie(autre);
partie(témoin);
for (let t = 0; t < 200; t++) { autre.step(); témoin.step(); }
assert.deepEqual(signature(autre), signature(témoin), "rebranché sur un autre moteur (changement de taille), même résultat");

pool.release();
await stop();
console.log("ok — moteur multi-fils conforme");
