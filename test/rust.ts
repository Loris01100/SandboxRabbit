/**
 * Le prototype Rust de `thermal()` (rust/src/lib.rs) contre le vrai moteur :
 * `npm run rust`, qui compile d'abord le Rust en WASM. Voir docs/rust.md.
 *
 * Sur deux scènes en 1920×1080 — le chantier de `npm run directions` et une
 * mer de lave, celle qui descendait à 12 fps en ×4 :
 * 1. la part de la chaleur dans un tick du moteur JavaScript ;
 * 2. `thermal()` en JavaScript, puis ses trois versions Rust, chacune repartie
 *    du même état du bac, un seul fil ;
 * 3. pour chacune, l'écart avec JavaScript : au bit près sur toutes les
 *    cellules (température des deux tampons, matière, `life`, blocs de
 *    veille), ou l'écart de température maximal.
 *
 * Rien ici ne garde de budget ni n'échoue sur un temps : c'est un instrument
 * de décision, comme `npm run directions`. Il échoue seulement si le `.wasm`
 * manque, ou si une version annoncée exacte ne l'est pas.
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { Engine } from "../src/client/sim/engine.ts";
import { FIRE, LAVA, MATERIALS, SAND, STONE, WATER, WOOD } from "../src/client/sim/materials.ts";

const W = 1920, H = 1080, N = W * H;
const RUNS = 30;
const WASM = new URL("../rust/target/wasm32-unknown-unknown/release/thermal.wasm", import.meta.url);

/** Ce que `thermal()` lit et écrit, champs privés du moteur compris. */
interface Inner {
  cells: Uint8Array;
  life: Uint8Array;
  temp: Float32Array;
  tempNext: Float32Array;
  awake: Uint8Array;
  stir: Uint8Array;
  ambient: number;
  thermal(): void;
}

/** L'état du bac que `thermal()` touche, figé pour que chaque version reparte du même. */
interface State { cells: Uint8Array; life: Uint8Array; temp: Float32Array; next: Float32Array; awake: Uint8Array; stir: Uint8Array }

function snapshot(e: Inner): State {
  return {
    cells: e.cells.slice(), life: e.life.slice(), temp: e.temp.slice(), next: e.tempNext.slice(),
    awake: e.awake.slice(), stir: e.stir.slice(),
  };
}

/** Les tables des matières que lit la chaleur, dérivées de materials.ts comme dans engine.ts. */
function tables(): { f32s: Float32Array; u8s: Uint8Array } {
  const f32s = new Float32Array(768), u8s = new Uint8Array(768);
  f32s.fill(NaN, 0, 256).fill(Infinity, 256, 512).fill(-Infinity, 512);
  for (const key of Object.keys(MATERIALS)) {
    const m = MATERIALS[Number(key)];
    if (m.heat !== undefined) f32s[m.id] = m.heat;
    if (m.boil) { f32s[256 + m.id] = m.boil.at; u8s[m.id] = m.boil.into; }
    if (m.freeze) { f32s[512 + m.id] = m.freeze.at; u8s[256 + m.id] = m.freeze.into; }
    u8s[512 + m.id] = m.life ?? 0;
  }
  return { f32s, u8s };
}

/** Le chantier de `npm run directions` : une bande d'eau, du sable, du bois en feu dans une cuvette. */
function worksite(e: Engine): void {
  const s = W / 320;
  for (let x = 0; x < W; x++) {
    const bowl = Math.round(H - 12 * s - 26 * s * Math.sin((x / W) * Math.PI));
    e.rect(x, bowl, x, H - 1, STONE);
  }
  e.rect(0, 20 * s, W - 1, 60 * s, WATER, false);
  e.rect(20 * s, 70 * s, 300 * s, 90 * s, SAND, false);
  e.rect(100 * s, 95 * s, 220 * s, 120 * s, WOOD, false);
  e.paint(160 * s, 94 * s, 4, FIRE);
}

/** Une mer de lave sur les deux tiers du bac, sous un plafond de pierre percé. */
function lavaSea(e: Engine): void {
  e.rect(0, H / 3, W - 1, H - 1, LAVA);
  e.rect(0, 0, W - 1, 40, STONE);
  for (let x = 100; x < W; x += 200) e.rect(x, 0, x + 60, 40, 0);
}

/** Le module Rust instancié, ses tampons réservés dans sa mémoire et les vues JavaScript posées dessus. */
async function rust() {
  if (!existsSync(WASM)) {
    console.error("rust/target/…/thermal.wasm absent : lancer `npm run rust` (qui compile), voir docs/rust.md.");
    process.exit(1);
  }
  const { instance } = await WebAssembly.instantiate(readFileSync(WASM));
  const x = instance.exports as {
    memory: WebAssembly.Memory;
    reserve(bytes: number): number;
    thermal(...args: number[]): void;
  };
  const chunks = Math.ceil(W / 16) * Math.ceil(H / 16);
  const at = {
    cells: x.reserve(N), life: x.reserve(N), temp: x.reserve(N * 4), next: x.reserve(N * 4),
    awake: x.reserve(chunks), stir: x.reserve(chunks), jobs: x.reserve(chunks * 4),
    f32s: x.reserve(768 * 4), u8s: x.reserve(768),
  };
  const b = x.memory.buffer;
  const view = {
    cells: new Uint8Array(b, at.cells, N), life: new Uint8Array(b, at.life, N),
    temp: new Float32Array(b, at.temp, N), next: new Float32Array(b, at.next, N),
    awake: new Uint8Array(b, at.awake, chunks), stir: new Uint8Array(b, at.stir, chunks),
  };
  const t = tables();
  new Float32Array(b, at.f32s, 768).set(t.f32s);
  new Uint8Array(b, at.u8s, 768).set(t.u8s);
  return {
    load(s: State): void {
      view.cells.set(s.cells); view.life.set(s.life); view.temp.set(s.temp); view.next.set(s.next);
      view.awake.set(s.awake); view.stir.set(s.stir);
    },
    run(ambient: number, mode: number): void {
      x.thermal(W, H, at.cells, at.life, at.temp, at.next, at.awake, at.stir, at.jobs, at.f32s, at.u8s, ambient, mode);
    },
    view,
  };
}

/** Nombre de cellules qui diffèrent entre deux tableaux (au bit près pour les flottants) et plus grand écart. */
function gap(a: Uint8Array | Float32Array, b: Uint8Array | Float32Array): { count: number; max: number } {
  let count = 0, max = 0;
  for (let i = 0; i < a.length; i++) {
    if (Object.is(a[i], b[i])) continue;
    count++;
    max = Math.max(max, Math.abs(a[i] - b[i]));
  }
  return { count, max };
}

const ms = (t: number): string => `${t.toFixed(2)} ms`;
const wasm = await rust();
const MODES = [
  { mode: 0, name: "Rust, f64 (copie)", exact: true },
  { mode: 1, name: "Rust SIMD f64×2", exact: true },
  { mode: 2, name: "Rust SIMD f32×4", exact: false },
];

for (const [name, build] of [["chantier", worksite], ["mer de lave", lavaSea]] as const) {
  const engine = new Engine(W, H, 5);
  build(engine);
  for (let t = 0; t < 50; t++) engine.step();
  const e = engine as unknown as Inner;

  let tick = 0;
  for (let t = 0; t < 20; t++) {
    const t0 = performance.now();
    engine.step();
    tick += performance.now() - t0;
  }
  tick /= 20;

  const start = snapshot(e);
  const refs = { temp: e.temp, next: e.tempNext };
  /** Remet le moteur dans l'état `start`, tampons de température compris. */
  const restore = () => {
    e.cells.set(start.cells); e.life.set(start.life);
    e.temp = refs.temp; e.tempNext = refs.next;
    e.temp.set(start.temp); e.tempNext.set(start.next);
    e.awake.set(start.awake); e.stir.set(start.stir);
  };

  let js = 0;
  for (let r = 0; r < RUNS; r++) {
    restore();
    const t0 = performance.now();
    e.thermal();
    js += performance.now() - t0;
  }
  js /= RUNS;
  restore();
  e.thermal();
  const expected = snapshot(e);

  const awake = start.awake.reduce((n, a, c) => n + (a | start.stir[c] ? 1 : 0), 0) / start.awake.length;
  console.log(`\n${name} — 1920×1080, ${(awake * 100).toFixed(0)} % des blocs éveillés`);
  console.log(`  tick complet (JS)        ${ms(tick)}`);
  console.log(`  thermal() JavaScript     ${ms(js)}   (${((js / tick) * 100).toFixed(0)} % du tick)`);

  for (const { mode, name: label, exact } of MODES) {
    let time = 0;
    for (let r = 0; r < RUNS; r++) {
      wasm.load(start);
      const t0 = performance.now();
      wasm.run(e.ambient, mode);
      time += performance.now() - t0;
    }
    time /= RUNS;
    wasm.load(start);
    wasm.run(e.ambient, mode);
    const v = wasm.view;
    const temp = gap(expected.temp, v.next), next = gap(expected.next, v.temp);
    const others = gap(expected.cells, v.cells).count + gap(expected.life, v.life).count
      + gap(expected.awake, v.awake).count + gap(expected.stir, v.stir).count;
    const same = temp.count + next.count + others === 0;
    const verdict = same ? "identique au bit près"
      : `${temp.count + next.count} températures différentes (écart max ${temp.max.toExponential(1)} °C), ${others} autres cases`;
    console.log(`  ${label.padEnd(24)} ${ms(time)}   ×${(js / time).toFixed(2)}   ${verdict}`);
    if (exact) assert.ok(same, `${label} doit rendre exactement ce que rend JavaScript`);
  }
}
