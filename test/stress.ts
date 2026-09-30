/**
 * Banc de charge : `npm run stress`. Les pires cas du moteur et de l'envoi à
 * la page, chacun sous un plafond, sur un seul fil (le runner de CI n'a que
 * deux cœurs, et le résultat ne dépend pas du nombre de fils).
 *
 * `npm run bench` mesure une scène ordinaire ; ici, ce qui peut faire des
 * millions de calculs d'un coup : un bac plein d'une seule matière (toutes y
 * passent), une explosion en chaîne, une onde de pression, une mer de lave
 * sous la pluie, des aimants dans la limaille, et les bandes d'un bac
 * 1920×1080 entièrement changé. C'est ainsi qu'on a trouvé l'aimant à
 * 1000 ns par cellule (2 s le tick en 1920×1080 plein d'aimants).
 *
 * Que le bac finisse par s'endormir, test/sim.ts le vérifie sans chronomètre.
 * Ici, on chronomètre : les plafonds sont larges (~5 fois la mesure de
 * référence, le runner partagé varie du simple au triple), ils attrapent un
 * effondrement, pas une dérive. `STRESS_SLACK=2 npm run stress` les double.
 *
 * ponytail: des plafonds absolus, calés sur une machine. Comparer à la mesure
 * de `main` demanderait de la stocker quelque part — comme bench.ts.
 */
import { Engine } from "../src/client/sim/engine.ts";
import { Tracker, land, recycle, type Mirror } from "../src/client/sim/render.ts";
import { FILINGS, FIRE, LAVA, MAGNET, MATERIALS, NANITE, STONE, TNT, WATER, type MaterialId } from "../src/client/sim/materials.ts";

const SLACK = Number(process.env.STRESS_SLACK ?? 1);
const results: { name: string; value: number; budget: number; unit: string }[] = [];

function check(name: string, value: number, budget: number, unit: string): void {
  results.push({ name, value, budget: budget * SLACK, unit });
}

/** Le temps moyen et le pire temps d'un tick, en ms, sur `ticks` ticks. */
function run(e: Engine, ticks: number): { mean: number; worst: number } {
  let worst = 0;
  const start = performance.now();
  for (let t = 0; t < ticks; t++) {
    const t0 = performance.now();
    e.step();
    worst = Math.max(worst, performance.now() - t0);
  }
  return { mean: (performance.now() - start) / ticks, worst };
}

/**
 * 1. Chaque matière, seule, remplit un bac 320×180. On mesure les ticks 3 à 33 :
 * après la mise en place, avant que les gaz ne s'éteignent. Un premier passage
 * court chauffe le JIT, sans quoi la première matière paierait la compilation.
 */
const W = 320, H = 180, N = W * H;
const ids = Object.keys(MATERIALS).map(Number).filter((id) => id !== 0) as MaterialId[];
const full = (id: MaterialId): Engine => {
  const e = new Engine(W, H, 1234);
  e.rect(0, 0, W - 1, H - 1, id);
  return e;
};
for (const id of ids) run(full(id), 3);
/**
 * Plafond par cellule et par tick, en ns. Les plus chères font 110 à 160 (feu,
 * acide, retombées, uranium, nanites) ; l'aimant en faisait 1000.
 */
const PER_CELL = 800;
const perCell: [MaterialId, number][] = [];
for (const id of ids) {
  const e = full(id);
  run(e, 3);
  perCell.push([id, (run(e, 30).mean * 1e6) / N]);
}
perCell.sort((a, b) => b[1] - a[1]);
// Toutes sont contrôlées ; le tableau n'affiche que les huit plus chères et celles qui dépassent.
perCell.forEach(([id, ns], rank) => {
  if (rank < 8 || ns > PER_CELL * SLACK) check(`bac plein : ${MATERIALS[id].name}`, ns, PER_CELL, "ns/cellule");
});

/** 2. Un bac 320×180 plein de TNT, allumé au centre : la chaîne entière, souffle et pression compris. */
{
  const e = full(TNT);
  e.paint(W / 2, H / 2, 3, FIRE);
  const { worst } = run(e, 200);
  check("TNT en chaîne 320×180, pire tick", worst, 250, "ms");
}

/** 3. Une onde en plein air 640×360 : un bloc de TNT au milieu, sol de pierre. */
{
  const e = new Engine(640, 360, 1234);
  e.rect(0, 340, 639, 359, STONE);
  e.rect(300, 150, 340, 190, TNT);
  e.paint(320, 170, 2, FIRE);
  const { worst } = run(e, 150);
  check("souffle en plein air 640×360, pire tick", worst, 100, "ms");
}

/** 4. Une mer de lave 640×360 sous un lac qui tombe : vapeur, chaleur, changements d'état. */
{
  const e = new Engine(640, 360, 1234);
  e.rect(0, 180, 639, 359, LAVA);
  e.rect(100, 20, 540, 80, WATER);
  const { mean, worst } = run(e, 100);
  check("lave sous la pluie 640×360, tick moyen", mean, 50, "ms");
  check("lave sous la pluie 640×360, pire tick", worst, 200, "ms");
}

/**
 * 5. Une rangée d'aimants tous les 4 cellules au-dessus d'un lit de limaille
 * 320×180 : chacun a de quoi attirer, et la limaille a de la place pour
 * monter — dans un bac plein, rien ne bougerait et l'aimant ne coûterait rien.
 */
{
  const e = new Engine(W, H, 1234);
  e.rect(0, H / 2, W - 1, H - 1, FILINGS);
  for (let x = 2; x < W; x += 4) e.set(x, H / 2 - 4, MAGNET);
  const { mean } = run(e, 60);
  check("aimants sur la limaille 320×180, tick moyen", mean, 10, "ms");
}

/** 6. Les bandes d'un bac 1920×1080 entièrement changé : leur préparation (fil du bac) et leur pose (page). */
{
  const w = 1920, h = 1080, n = w * h;
  const e = new Engine(w, h, 1234);
  e.rect(0, 0, w - 1, h - 1, NANITE);
  const tracker = new Tracker(e);
  tracker.take();
  const mirror: Mirror = {
    width: w, height: h, ambient: 20, cells: new Uint8Array(n), life: new Uint8Array(n), frozen: new Uint8Array(n),
    noise: new Int8Array(n), temp: new Float32Array(n), press: new Float32Array(n),
  };
  let take = 0, put = 0;
  for (let k = 0; k < 10; k++) {
    e.wakeAll(); // tout le bac changé, sans payer un tick de nanites
    const t0 = performance.now();
    const patches = tracker.take();
    const t1 = performance.now();
    for (const p of patches) land(mirror, p);
    const t2 = performance.now();
    recycle(patches[0].cells.buffer as ArrayBuffer); // comme la page, qui rend le tampon (world.ts)
    if (k >= 2) { take += t1 - t0; put += t2 - t1; }
  }
  check("bandes 1920×1080 : préparation (fil du bac)", take / 8, 12, "ms");
  check("bandes 1920×1080 : pose (page)", put / 8, 12, "ms");
}

console.log("mesure".padEnd(48) + "valeur".padStart(10) + "plafond".padStart(10));
let failed = 0;
for (const r of results) {
  const bad = r.value > r.budget;
  if (bad) failed++;
  console.log(`${bad ? "✗" : " "} ${r.name}`.padEnd(48) + r.value.toFixed(1).padStart(10) + `${r.budget.toFixed(0)} ${r.unit}`.padStart(16));
}
if (failed > 0) {
  console.error(`\n✗ ${failed} plafond(s) dépassé(s)`);
  process.exit(1);
}
console.log(`\nok — ${perCell.length} matières et 5 scènes lourdes sous leur plafond`);
