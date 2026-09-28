/**
 * Quelle direction pour les grands mondes animés ? `npm run directions`
 * mesure, sur la machine qui le lance, ce que rapporterait chaque piste.
 *
 * 1. Le vrai moteur, sur une scène chargée en 1920×1080 : combien coûtent les
 *    règles, la chaleur et l'envoi à la page (`Tracker`, les bandes de blocs
 *    changés — le coloriage, lui, est fait par la carte graphique de la page).
 *    C'est ce qu'il faut accélérer.
 * 2. Deux noyaux qui résument ce travail (directions-kernels.ts) — le sable
 *    qui tombe, la diffusion de la chaleur — sur un cœur, puis sur 2, 4, 8…
 *    cœurs (damier de blocs, mémoire partagée, tirage par bloc). Le rapport
 *    entre les deux dit ce que le multi-cœur ferait gagner au vrai moteur.
 * 3. La carte graphique ne se mesure que dans un navigateur : test/gpu.html,
 *    mêmes noyaux en WebGPU, ouvert pendant `npm run dev`.
 *
 * Rien ici ne garde de budget ni n'échoue : c'est un instrument de décision,
 * pas un test de non-régression. Voir docs/agents/tests.md.
 */
import { availableParallelism } from "node:os";
import { Worker } from "node:worker_threads";
import { Engine } from "../src/client/sim/engine.ts";
import { Tracker } from "../src/client/sim/render.ts";
import { FIRE, SAND as REAL_SAND, STONE as REAL_STONE, WATER, WOOD } from "../src/client/sim/materials.ts";
import { diffuseRows, phaseBlocks, sandBlock, scene } from "./directions-kernels.ts";

const W = 1920, H = 1080, N = W * H;
const TICKS = 60;
const ms = (t: number): string => `${t.toFixed(2)} ms`;

/* ------------------------------------------------------ 1. le vrai moteur */

/**
 * Le moteur réel sur la scène qui le faisait ramer : une bande d'eau sur toute
 * la largeur, du sable, du bois en feu. `thermal()` est enveloppé pour être
 * chronométré à part — le reste de `step()`, ce sont les règles.
 */
function realEngine(): { rules: number; heat: number; render: number; awake: number } {
  const e = new Engine(W, H, 5);
  const s = W / 320;
  for (let x = 0; x < W; x++) {
    const bowl = Math.round(H - 12 * s - 26 * s * Math.sin((x / W) * Math.PI));
    e.rect(x, bowl, x, H - 1, REAL_STONE);
  }
  e.rect(0, 20 * s, W - 1, 60 * s, WATER, false);
  e.rect(20 * s, 70 * s, 300 * s, 90 * s, REAL_SAND, false);
  e.rect(100 * s, 95 * s, 220 * s, 120 * s, WOOD, false);
  e.paint(160 * s, 94 * s, 4, FIRE);
  const r = new Tracker(e);
  const proto = Engine.prototype as unknown as { thermal: () => void };
  const thermal = proto.thermal;
  let heat = 0;
  proto.thermal = function (this: Engine) {
    const t0 = performance.now();
    thermal.call(this);
    heat += performance.now() - t0;
  };
  for (let t = 0; t < 50; t++) { e.step(); r.take(); }
  heat = 0;
  let total = 0, render = 0, awake = 0;
  for (let t = 0; t < TICKS; t++) {
    const t0 = performance.now();
    e.step();
    const t1 = performance.now();
    r.take();
    render += performance.now() - t1;
    total += t1 - t0;
    for (const a of (e as unknown as { awake: Uint8Array }).awake) if (a) awake++;
  }
  proto.thermal = thermal;
  return { rules: (total - heat) / TICKS, heat: heat / TICKS, render: render / TICKS, awake: awake / TICKS / (e.cols * e.rows) };
}

/* ------------------------------------------------------- 2. les noyaux */

/** Sable et chaleur sur un seul cœur, dans ce fil : la référence. */
function oneCore(): { sand: number; heat: number } {
  const cells = new Uint8Array(N), clock = new Uint8Array(N);
  const a = new Float32Array(N), b = new Float32Array(N);
  scene(cells, a, W, H);
  const phases = [phaseBlocks(W, H, 0, 0), phaseBlocks(W, H, 1, 0), phaseBlocks(W, H, 0, 1), phaseBlocks(W, H, 1, 1)];
  const sandTick = (tick: number) => {
    for (const blocks of phases) for (let k = 0; k < blocks.length; k += 2) sandBlock(cells, clock, W, H, blocks[k], blocks[k + 1], tick);
  };
  for (let t = 0; t < 10; t++) sandTick(t);
  let t0 = performance.now();
  for (let t = 10; t < 10 + TICKS; t++) sandTick(t);
  const sand = (performance.now() - t0) / TICKS;
  for (let t = 0; t < 10; t++) diffuseRows(t & 1 ? b : a, t & 1 ? a : b, W, H, 0, H);
  t0 = performance.now();
  for (let t = 0; t < TICKS; t++) diffuseRows(t & 1 ? b : a, t & 1 ? a : b, W, H, 0, H);
  return { sand, heat: (performance.now() - t0) / TICKS };
}

/** Les mêmes noyaux sur `count` cœurs : une barrière `Atomics` par phase du damier (sable) ou par tick (chaleur). */
async function manyCores(count: number): Promise<{ sand: number; heat: number }> {
  const cells = new SharedArrayBuffer(N), clock = new SharedArrayBuffer(N);
  const tempA = new SharedArrayBuffer(N * 4), tempB = new SharedArrayBuffer(N * 4);
  const control = new SharedArrayBuffer(8 * 4);
  scene(new Uint8Array(cells), new Float32Array(tempA), W, H);
  const ctl = new Int32Array(control);
  const workers = await Promise.all(Array.from({ length: count }, (_, index) => new Promise<Worker>((ready) => {
    const worker = new Worker(new URL("./directions-worker.ts", import.meta.url), {
      workerData: { cells, clock, tempA, tempB, control, w: W, h: H, index, count },
    });
    worker.once("message", () => ready(worker));
  })));
  /** Lance une tâche sur tous les cœurs et attend qu'ils l'aient finie. */
  const run = (kind: number, arg: number, phase: number) => {
    ctl[1] = 0; ctl[2] = kind; ctl[3] = arg; ctl[4] = phase;
    Atomics.add(ctl, 0, 1);
    Atomics.notify(ctl, 0);
    for (let done = Atomics.load(ctl, 1); done < count; done = Atomics.load(ctl, 1)) Atomics.wait(ctl, 1, done);
  };
  const sandTick = (tick: number) => { for (let p = 0; p < 4; p++) run(1, tick, p); };
  for (let t = 0; t < 10; t++) sandTick(t);
  let t0 = performance.now();
  for (let t = 10; t < 10 + TICKS; t++) sandTick(t);
  const sand = (performance.now() - t0) / TICKS;
  for (let t = 0; t < 10; t++) run(2, t & 1, 0);
  t0 = performance.now();
  for (let t = 0; t < TICKS; t++) run(2, t & 1, 0);
  const heat = (performance.now() - t0) / TICKS;
  Atomics.store(ctl, 0, -1);
  Atomics.notify(ctl, 0);
  await Promise.all(workers.map((w) => w.terminate()));
  return { sand, heat };
}

/* ---------------------------------------------------------- le rapport */

const cores = availableParallelism();
console.log(`Machine : ${cores} cœurs logiques. Grille ${W}×${H}, ${TICKS} ticks par mesure.\n`);

const real = realEngine();
console.log("1. Le vrai moteur, scène chargée (eau, sable, feu)");
console.log(`   règles ${ms(real.rules)} · chaleur ${ms(real.heat)} · envoi ${ms(real.render)} · blocs éveillés ${(real.awake * 100).toFixed(0)} %`);
const frame = real.rules + real.heat + real.render;
console.log(`   total ${ms(frame)} par tick → ${Math.min(60, 1000 / frame).toFixed(0)} ticks/s affichés (60 visés)\n`);

console.log("2. Les noyaux, grille entière active");
const one = oneCore();
console.log(`   ${"cœurs".padEnd(6)} ${"sable".padStart(10)} ${"chaleur".padStart(10)}   gain sable · chaleur`);
console.log(`   ${"1".padEnd(6)} ${ms(one.sand).padStart(10)} ${ms(one.heat).padStart(10)}`);
const counts = [2, 4, 8, 16].filter((n) => n <= cores);
if (!counts.includes(cores) && cores > 1) counts.push(cores);
let best = { n: 1, sand: 1, heat: 1 };
for (const n of counts) {
  const m = await manyCores(n);
  const sand = one.sand / m.sand, heat = one.heat / m.heat;
  if (sand + heat > best.sand + best.heat) best = { n, sand, heat };
  console.log(`   ${String(n).padEnd(6)} ${ms(m.sand).padStart(10)} ${ms(m.heat).padStart(10)}   ×${sand.toFixed(1)} · ×${heat.toFixed(1)}`);
}

console.log("\n3. Projection sur le vrai moteur");
const projected = real.rules / best.sand + real.heat / best.heat + real.render;
console.log(`   un cœur        : ${ms(frame)} par tick`);
console.log(`   ${best.n} cœurs${" ".repeat(Math.max(0, 8 - String(best.n).length))}: ${ms(projected)} par tick (règles ÷${best.sand.toFixed(1)}, chaleur ÷${best.heat.toFixed(1)}, envoi inchangé)`);
console.log(`   ns par cellule, noyau sable sur un cœur : ${((one.sand * 1e6) / N).toFixed(1)} — le vrai moteur en coûte ${((real.rules * 1e6) / (N * Math.max(real.awake, 1e-6))).toFixed(1)} par cellule éveillée`);
console.log("\n4. Carte graphique : `npm run dev`, puis ouvrir http://localhost:5173/test/gpu.html");
