/**
 * Dérive : `npm run drift`. Le bench et le banc de charge contre la branche de
 * base (`DRIFT_BASE`, `origin/main` par défaut), **sur la même machine et dans
 * la foulée** : une mesure de `main` gardée d'une exécution à l'autre ne
 * vaudrait rien, un runner partagé varie déjà de plus de 20 % entre deux
 * passages. Ici les deux côtés tournent en alternance, `DRIFT_ROUNDS` fois
 * chacun (3 par défaut), et chaque mesure garde son meilleur temps : la
 * machine qui ralentit un instant ralentit les deux. Sur deux copies du même
 * code, une seule manche donnait déjà jusqu'à 22 % d'écart.
 *
 * Échoue si une mesure a pris plus de `DRIFT_MAX` (30 %) — sauf les « pire
 * tick », qu'un ramasse-miettes fait varier du simple au double, et ce qui
 * reste sous le plancher de bruit (0,5 ms, 50 ns par cellule). bench.ts et
 * stress.ts gardent leurs seuils absolus : eux attrapent un effondrement, ici
 * une dérive.
 *
 * `DRIFT_BASE` peut aussi être un dossier (une autre copie du dépôt) : il est
 * alors mesuré tel quel. Sinon, la base est extraite dans une copie de travail
 * temporaire (`git worktree`),
 * sans `npm ci` : bench.ts et stress.ts n'importent que le moteur, qui n'a pas
 * de dépendance. Une base trop ancienne pour écrire ses mesures (avant
 * `BENCH_JSON`) est sautée, pas comptée comme une dérive.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const BASE = process.env.DRIFT_BASE ?? "origin/main";
const ROUNDS = Number(process.env.DRIFT_ROUNDS ?? 3);
const MAX = Number(process.env.DRIFT_MAX ?? 0.3);
// Un chemin fixe évite qu'un dossier du PATH fournisse un faux Git.
const GIT = process.platform === "win32" ? "C:/Program Files/Git/cmd/git.exe" : "/usr/bin/git";
/** Sous ce temps, l'écart est du bruit de mesure, pas du code. */
const FLOOR: Record<string, number> = { ms: 0.5, "ns/cellule": 50 };

type Measures = Record<string, { value: number; unit: string }>;

const scratch = mkdtempSync(join(tmpdir(), "drift-"));
const folder = existsSync(BASE);
const base = folder ? BASE : join(scratch, "base");
if (!folder) execFileSync(GIT, ["worktree", "add", "--detach", base, BASE], { stdio: "ignore" });

/** Fait tourner `script` dans `cwd` et rend ses mesures, ou null si la version n'en écrit pas. */
function measure(cwd: string, script: "bench" | "stress", round: number, side: string): Measures | null {
  const out = join(scratch, `${side}-${script}-${round}.json`);
  const env = { ...process.env, BENCH_JSON: out, STRESS_JSON: out, BENCH_BUDGET_MS: "1e9", STRESS_SLACK: "1e9" };
  spawnSync(process.execPath, [`test/${script}.ts`], { cwd, env, stdio: "ignore" });
  return existsSync(out) ? (JSON.parse(readFileSync(out, "utf8")) as Measures) : null;
}

/** Le meilleur temps de chaque mesure sur toutes les manches. */
function best(runs: (Measures | null)[]): Measures | null {
  if (runs.some((r) => r === null)) return null;
  const out: Measures = {};
  for (const run of runs as Measures[]) {
    for (const [name, m] of Object.entries(run)) {
      if (!out[name] || m.value < out[name].value) out[name] = m;
    }
  }
  return out;
}

let drifted = 0;
try {
  for (const script of ["bench", "stress"] as const) {
    const before: (Measures | null)[] = [], after: (Measures | null)[] = [];
    for (let round = 0; round < ROUNDS; round++) {
      before.push(measure(base, script, round, "base"));
      after.push(measure(process.cwd(), script, round, "ici"));
    }
    const was = best(before), now = best(after);
    console.log(`\n${script} — ${BASE} contre ici (meilleur de ${ROUNDS})`);
    if (!now) throw new Error(`${script} n'a rien mesuré ici`);
    if (!was) { console.log("  base trop ancienne pour écrire ses mesures : comparaison sautée"); continue; }
    for (const [name, m] of Object.entries(now)) {
      const old = was[name];
      if (!old) continue; // mesure neuve, ou absente du classement de la base (stress n'en montre que huit)
      const ratio = m.value / old.value;
      const counted = !name.includes("pire") && m.value >= (FLOOR[m.unit] ?? 0);
      const bad = counted && ratio > 1 + MAX;
      if (bad) drifted++;
      const sign = ratio >= 1 ? "+" : "−";
      console.log(`${bad ? "✗" : " "} ${name.padEnd(46)}${old.value.toFixed(2).padStart(9)} → ${m.value.toFixed(2).padStart(8)} ${m.unit.padEnd(11)}${sign}${Math.abs((ratio - 1) * 100).toFixed(0).padStart(3)} %${counted ? "" : "  (non compté)"}`);
    }
  }
} finally {
  if (!folder) execFileSync(GIT, ["worktree", "remove", "--force", base], { stdio: "ignore" });
  rmSync(scratch, { recursive: true, force: true });
}

if (drifted > 0) {
  console.error(`\n✗ ${drifted} mesure(s) plus lente(s) de plus de ${MAX * 100} % que ${BASE}`);
  process.exit(1);
}
console.log(`\nok — aucune dérive de plus de ${MAX * 100} % contre ${BASE}`);
