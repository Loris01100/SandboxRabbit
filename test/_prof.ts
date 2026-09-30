import { Worker } from "node:worker_threads";
import { Engine } from "../src/client/sim/engine.ts";
import { Pool, type Helper } from "../src/client/sim/pool.ts";
import { AIR_LEVELS, Tracker } from "../src/client/sim/render.ts";
import { NANITE } from "../src/client/sim/materials.ts";

const W = 1920, H = 1080;
const time = (label: string, n: number, fn: () => void) => {
  for (let i = 0; i < 3; i++) fn();
  const t = performance.now();
  for (let i = 0; i < n; i++) fn();
  console.log(label.padEnd(34), ((performance.now() - t) / n).toFixed(2), "ms");
};
async function engine(threads: number): Promise<{ e: Engine; stop: () => Promise<void> }> {
  const e = new Engine(W, H, 7);
  const workers = Array.from({ length: threads }, () => new Worker(new URL("./helper.ts", import.meta.url)));
  if (threads) {
    const pool = new Pool(workers.map((w): Helper => ({ post: (m) => w.postMessage(m), listen: (fn) => { w.on("message", fn); } })));
    await pool.bind(e);
  }
  e.rect(0, 0, W, H, NANITE);
  return { e, stop: async () => { await Promise.all(workers.map((w) => w.terminate())); } };
}
for (const threads of [0, 6]) {
  const { e, stop } = await engine(threads);
  time(`tick nanites, ${threads + 1} fil(s)`, 20, () => e.step());
  await stop();
}
const { e } = await engine(0);
const tracker = new Tracker(e);
tracker.take();
let patches = tracker.take();
time("Tracker.take (bac plein changé)", 10, () => { e.step(); patches = tracker.take(); });
time("  dont tick seul", 10, () => e.step());
console.log("bandes :", patches.length, "octets :", patches.reduce((s, p) => s + p.cells.length * 6, 0));
// La copie dans le miroir, comme blit() de world.ts.
const n = W * H;
const m = { cells: new Uint8Array(n), life: new Uint8Array(n), frozen: new Uint8Array(n), temp: new Int16Array(n), press: new Float32Array(n) };
time("blit (page)", 10, () => {
  for (const p of patches) for (let r = 0; r < p.h; r++) {
    const from = r * p.w, to = (p.y + r) * W + p.x;
    m.cells.set(p.cells.subarray(from, from + p.w), to);
    m.life.set(p.life.subarray(from, from + p.w), to);
    m.frozen.set(p.frozen.subarray(from, from + p.w), to);
    m.temp.set(p.temp.subarray(from, from + p.w), to);
    for (let k = 0; k < p.w; k++) m.press[to + k] = p.press[from + k] / AIR_LEVELS;
  }
});
process.exit(0);
