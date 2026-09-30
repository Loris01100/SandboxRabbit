/**
 * Le prototype Rust de `thermal()` (rust/src/lib.rs) contre le vrai moteur :
 * `npm run rust`, qui compile d'abord le Rust en WASM. Voir docs/rust.md.
 *
 * Sur trois scènes — le chantier de `npm run directions` et une mer de lave,
 * celle qui descendait à 12 fps en ×4, en 1920×1080 ; une fonderie en
 * 1917×1077 à l'ambiante -0 :
 * 1. la part de la chaleur dans un tick du moteur JavaScript ;
 * 2. `thermal()` en JavaScript, puis ses trois versions Rust, chacune repartie
 *    du même état du bac, un seul fil ;
 * 3. pour chacune, l'écart avec JavaScript sur `CHECKS` ticks successifs : au
 *    bit près sur toutes les cellules (température des deux tampons, matière,
 *    `life`, blocs de veille), ou l'écart de température maximal.
 *
 * La fonderie est là pour les chemins que les deux autres ne prennent
 * presque pas : sur un tick, le chantier ne compte que 2 changements d'état et
 * la mer de lave aucun. Ses bandes de matières posées sur la lave changent
 * d'état à chaque tick ; ses dimensions, pas multiples de 16, font des blocs
 * incomplets à droite et en bas ; son ambiante -0 vérifie le +0 qu'écrit
 * `flat()`.
 *
 * Puis la pression (`breathe()` contre `air()` de lib.rs) sur une salve
 * d'explosions, voir en fin de fichier.
 *
 * Rien ici ne garde de budget ni n'échoue sur un temps : c'est un instrument
 * de décision, comme `npm run directions`. Il échoue seulement si le `.wasm`
 * manque, ou si une version annoncée exacte ne l'est pas.
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { Engine, OPEN } from "../src/client/sim/engine.ts";
import {
  ALCOHOL, CEMENT, FIRE, ICE, LAVA, MATERIALS, MERCURY, NITROGEN, SALTWATER, SAND, SMOKE, SNOW, STONE, WATER, WAX, WOOD,
} from "../src/client/sim/materials.ts";

const RUNS = 30;
/** Ticks successifs comparés au bit près, chacun reparti de l'état du moteur JavaScript. */
const CHECKS = 10;
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
  const { width: W, height: H } = e;
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
  const { width: W, height: H } = e;
  e.rect(0, H / 3, W - 1, H - 1, LAVA);
  e.rect(0, 0, W - 1, 40, STONE);
  for (let x = 100; x < W; x += 200) e.rect(x, 0, x + 60, 40, 0);
}

/**
 * Un lac de lave au fond, et posées dessus des bandes de matières qui fondent,
 * gèlent ou s'évaporent, séparées par de l'air resté à l'ambiante -0.
 */
function foundry(e: Engine): void {
  const { width: W, height: H } = e;
  e.ambient = -0;
  e.clear();
  e.rect(0, H - 200, W - 1, H - 1, LAVA);
  const bands = [WATER, ICE, SAND, WAX, SNOW, NITROGEN, MERCURY, SALTWATER, CEMENT, ALCOHOL];
  for (let k = 0, x = 0; x < W; k++, x += 90) e.rect(x, H - 320, Math.min(W - 1, x + 59), H - 201, bands[k % bands.length]);
}

/** Le module Rust instancié, ses tampons réservés dans sa mémoire et les vues JavaScript posées dessus. */
async function rust(W: number, H: number) {
  const N = W * H;
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
const MODES = [
  { mode: 0, name: "Rust, f64 (copie)", exact: true },
  { mode: 1, name: "Rust SIMD f64×2", exact: true },
  { mode: 2, name: "Rust SIMD f32×4", exact: false },
];

const SCENES = [["chantier", 1920, 1080, worksite], ["mer de lave", 1920, 1080, lavaSea], ["fonderie", 1917, 1077, foundry]] as const;
let conversions = 0;
for (const [name, W, H, build] of SCENES) {
  const wasm = await rust(W, H);
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

  let start = snapshot(e);
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

  const awake = start.awake.reduce((n, a, c) => n + (a | start.stir[c] ? 1 : 0), 0) / start.awake.length;
  console.log(`
${name} — ${W}×${H}, ${(awake * 100).toFixed(0)} % des blocs éveillés`);
  console.log(`  tick complet (JS)        ${ms(tick)}`);
  console.log(`  thermal() JavaScript     ${ms(js)}   (${((js / tick) * 100).toFixed(0)} % du tick)`);

  const time = MODES.map(({ mode }) => {
    let sum = 0;
    for (let r = 0; r < RUNS; r++) {
      wasm.load(start);
      const t0 = performance.now();
      wasm.run(e.ambient, mode);
      sum += performance.now() - t0;
    }
    return sum / RUNS;
  });

  /** Pour chaque version, l'écart cumulé sur les `CHECKS` ticks. */
  const diff = MODES.map(() => ({ temps: 0, max: 0, others: 0 }));
  let changed = 0;
  for (let k = 0; k < CHECKS; k++) {
    if (k > 0) {
      engine.step();
      start = snapshot(e);
      refs.temp = e.temp; refs.next = e.tempNext;
    }
    restore();
    e.thermal();
    const expected = snapshot(e);
    for (let i = 0; i < start.cells.length; i++) if (start.cells[i] !== expected.cells[i]) changed++;
    MODES.forEach(({ mode }, m) => {
      wasm.load(start);
      wasm.run(e.ambient, mode);
      const v = wasm.view;
      const temp = gap(expected.temp, v.next), next = gap(expected.next, v.temp);
      diff[m].temps += temp.count + next.count;
      diff[m].max = Math.max(diff[m].max, temp.max, next.max);
      diff[m].others += gap(expected.cells, v.cells).count + gap(expected.life, v.life).count
        + gap(expected.awake, v.awake).count + gap(expected.stir, v.stir).count;
    });
    restore();
  }
  conversions += changed;
  console.log(`  ${CHECKS} ticks comparés, ${changed} changements d'état`);

  MODES.forEach(({ name: label, exact }, m) => {
    const d = diff[m];
    const same = d.temps + d.others === 0;
    const verdict = same ? "identique au bit près"
      : `${d.temps} températures différentes (écart max ${d.max.toExponential(1)} °C), ${d.others} autres cases`;
    console.log(`  ${label.padEnd(24)} ${ms(time[m])}   ×${(js / time[m]).toFixed(2)}   ${verdict}`);
    if (exact) assert.ok(same, `${label} doit rendre exactement ce que rend JavaScript (${name})`);
  });
}

// Sans changement d'état, `convert()` côté Rust ne serait vérifié par rien.
assert.ok(conversions > 100, `trop peu de changements d'état comparés (${conversions}) : la fonderie ne joue plus son rôle`);

/*
 * La pression de l'air (`breathe()` d'engine.ts, `air()` de lib.rs), sur une
 * salve d'explosions au-dessus du chantier : la passe ne tourne que là où un
 * souffle a laissé de la pression, c'est donc sa pire charge. Deux tailles,
 * dont une pas multiple de 16 (blocs incomplets à droite et en bas).
 */

/** Ce que `breathe()` lit et écrit. */
interface Windy {
  press: Float32Array;
  pressNext: Float32Array;
  hush: Uint8Array;
  awake: Uint8Array;
  stir: Uint8Array;
  control: Int32Array;
  breathe(): void;
}

/** Le chantier tassé 50 ticks, une nappe de fumée au-dessus, et une salve de charges qui sautent au même tick. */
function volley(e: Engine): void {
  worksite(e);
  for (let t = 0; t < 50; t++) e.step();
  const { width: W } = e;
  e.rect(0, 0, W - 1, 30, SMOKE, false);
  for (let x = 60; x < W; x += 120) e.explode(x, 60, 7);
}

const AIR_MODES = [
  { mode: 0, name: "Rust, f64 (copie)" },
  { mode: 1, name: "Rust SIMD f64×2" },
];
const GUST = 8; // CTL.gust d'engine.ts

for (const [name, W, H] of [["salve", 1920, 1080], ["salve", 1917, 1077]] as const) {
  const N = W * H, chunks = Math.ceil(W / 16) * Math.ceil(H / 16);
  const { instance } = await WebAssembly.instantiate(readFileSync(WASM));
  const x = instance.exports as {
    memory: WebAssembly.Memory;
    reserve(bytes: number): number;
    air(...args: number[]): number;
  };
  const at = {
    cells: x.reserve(N), press: x.reserve(N * 4), next: x.reserve(N * 4), awake: x.reserve(chunks),
    stir: x.reserve(chunks), hush: x.reserve(chunks), jobs: x.reserve(chunks * 4), open: x.reserve(256),
  };
  const b = x.memory.buffer;
  const v = {
    cells: new Uint8Array(b, at.cells, N), press: new Float32Array(b, at.press, N), next: new Float32Array(b, at.next, N),
    awake: new Uint8Array(b, at.awake, chunks), stir: new Uint8Array(b, at.stir, chunks), hush: new Uint8Array(b, at.hush, chunks),
  };
  new Uint8Array(b, at.open, 256).set(OPEN);

  const engine = new Engine(W, H, 5);
  volley(engine);
  engine.step();
  const e = engine as unknown as Windy & Inner;
  const take = () => ({
    cells: e.cells.slice(), press: e.press.slice(), next: e.pressNext.slice(), hush: e.hush.slice(),
    awake: e.awake.slice(), stir: e.stir.slice(),
  });
  let start = take();
  const refs = { press: e.press, next: e.pressNext };
  const restore = () => {
    e.press = refs.press; e.pressNext = refs.next;
    e.press.set(start.press); e.pressNext.set(start.next);
    e.hush.set(start.hush); e.stir.set(start.stir); e.awake.set(start.awake);
    Atomics.store(e.control, GUST, 1);
  };
  const load = () => {
    v.cells.set(start.cells); v.press.set(start.press); v.next.set(start.next);
    v.awake.set(start.awake); v.stir.set(start.stir); v.hush.set(start.hush);
  };
  const run = (mode: number) => x.air(W, H, at.cells, at.press, at.next, at.awake, at.stir, at.hush, at.jobs, at.open, mode);

  let js = 0;
  for (let r = 0; r < RUNS; r++) {
    restore();
    const t0 = performance.now();
    e.breathe();
    js += performance.now() - t0;
  }
  js /= RUNS;
  const time = AIR_MODES.map(({ mode }) => {
    let sum = 0;
    for (let r = 0; r < RUNS; r++) {
      load();
      const t0 = performance.now();
      run(mode);
      sum += performance.now() - t0;
    }
    return sum / RUNS;
  });
  let tick = 0;
  restore();
  for (let t = 0; t < 5; t++) {
    const t0 = performance.now();
    engine.step();
    tick += performance.now() - t0;
  }
  tick /= 5;

  const awake = start.awake.reduce((n, a) => n + (a ? 1 : 0), 0) / chunks;
  console.log(`
${name} (pression) — ${W}×${H}, ${(awake * 100).toFixed(0)} % des blocs éveillés`);
  console.log(`  tick complet (JS)        ${ms(tick)}`);
  console.log(`  breathe() JavaScript     ${ms(js)}   (${((js / tick) * 100).toFixed(0)} % du tick)`);

  const diff = AIR_MODES.map(() => 0);
  let windy = 0;
  for (let k = 0; k < CHECKS; k++) {
    if (k > 0) {
      engine.step();
      start = take();
      refs.press = e.press; refs.next = e.pressNext;
    }
    restore();
    e.breathe();
    const gust = Atomics.load(e.control, GUST);
    const expected = { press: e.press.slice(), next: e.pressNext.slice(), stir: e.stir.slice(), hush: e.hush.slice() };
    for (const p of expected.press) if (p > 0) windy++;
    AIR_MODES.forEach(({ mode }, m) => {
      load();
      const g = run(mode);
      diff[m] += gap(expected.press, v.next).count + gap(expected.next, v.press).count
        + gap(expected.stir, v.stir).count + gap(expected.hush, v.hush).count + (g === gust ? 0 : 1);
    });
    restore();
  }
  assert.ok(windy > 10_000, `la salve doit laisser de la pression à comparer (${windy} cellules)`);
  console.log(`  ${CHECKS} ticks comparés, ${windy} cellules sous pression`);
  AIR_MODES.forEach(({ name: label }, m) => {
    const same = diff[m] === 0;
    console.log(`  ${label.padEnd(24)} ${ms(time[m])}   ×${(js / time[m]).toFixed(2)}   ${same ? "identique au bit près" : `${diff[m]} cases différentes`}`);
    assert.ok(same, `${label} doit rendre exactement la pression de JavaScript (${name} ${W}×${H})`);
  });
}
