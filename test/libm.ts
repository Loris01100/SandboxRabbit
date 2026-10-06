/**
 * Les fonctions mathématiques déterministes (src/client/sim/libm.ts) :
 * `npm run check` (Node exécute le TS tel quel).
 *
 * Deux vérifications, qui ne se recouvrent pas :
 * - ici, **justesse** : à au plus un ulp de `Math` sous V8 (lui-même à moins
 *   d'un ulp de la vraie valeur), cas particuliers compris ;
 * - `npm run rust` (test/rust.ts), **déterminisme** : les mêmes bits que la
 *   crate Rust `libm`, sur des millions d'arguments. Il demande Rust et ne
 *   tourne pas en CI ; ce fichier-ci, si.
 */
import assert from "node:assert/strict";
import { atan, atan2, cos, exp, log, sin } from "../src/client/sim/libm.ts";

const F = new Float64Array(1);
const I = new BigInt64Array(F.buffer);

/** Le double dont les bits sont `bits`. */
function bitsOf(bits: bigint): number {
  I[0] = bits;
  return F[0];
}

/** Rang de `x` dans l'ordre des doubles : deux voisins diffèrent de 1. */
function rank(x: number): bigint {
  F[0] = x;
  const b = I[0];
  return b < 0n ? -(b & 0x7fffffffffffffffn) : b;
}

/** Écart en ulp entre deux résultats ; 0 si tous deux NaN. */
function ulps(a: number, b: number): bigint {
  if (Number.isNaN(a) && Number.isNaN(b)) return 0n;
  if (Number.isNaN(a) || Number.isNaN(b)) return 1n << 60n;
  const d = rank(a) - rank(b);
  return d < 0n ? -d : d;
}

/** Tirage fixe (xorshift32) : le même jeu d'arguments à chaque lancement. */
let seed = 12345;
function rand(): number {
  seed ^= seed << 13; seed >>>= 0;
  seed ^= seed >>> 17;
  seed ^= seed << 5; seed >>>= 0;
  return seed / 0x1_0000_0000;
}

/** Arguments : tirés sur [-range, range], plus une grille régulière et des voisins des cas délicats. */
function args(range: number, extra: number[] = []): number[] {
  const out = [...extra];
  for (let k = 0; k < 200_000; k++) out.push((rand() * 2 - 1) * range);
  for (let k = -1000; k <= 1000; k++) out.push((k / 1000) * range);
  return out;
}

/** Autour de chaque multiple de π/4 : là où la réduction d'argument perd le plus. */
const quarters: number[] = [];
for (let k = -40; k <= 40; k++) {
  const x = k * (Math.PI / 4);
  for (let d = -3; d <= 3; d++) quarters.push(x + d * Number.EPSILON * Math.max(1, Math.abs(x)));
}

const cases: [string, (x: number) => number, (x: number) => number, number[]][] = [
  ["sin", sin, Math.sin, args(100, quarters)],
  ["sin (grand)", sin, Math.sin, args(1_600_000)],
  ["cos", cos, Math.cos, args(100, quarters)],
  ["cos (grand)", cos, Math.cos, args(1_600_000)],
  ["atan", atan, Math.atan, [...args(3), ...args(1e6)]],
  ["exp", exp, Math.exp, [...args(1), ...args(745), -745.1, 709.7]],
  ["log", log, Math.log, [...args(2).map(Math.abs), ...args(1e300).map(Math.abs), 5e-324, 2.2e-308, 1]],
];
for (const [name, ours, v8, xs] of cases) {
  let worst = 0n, at = 0;
  for (const x of xs) {
    const d = ulps(ours(x), v8(x));
    if (d > worst) { worst = d; at = x; }
  }
  assert.ok(worst <= 1n, `${name} à ${worst} ulp de Math en ${at}`);
}
{
  let worst = 0n;
  for (let k = 0; k < 200_000; k++) {
    const y = (rand() * 2 - 1) * 10 ** (rand() * 6 - 3), x = (rand() * 2 - 1) * 10 ** (rand() * 6 - 3);
    const d = ulps(atan2(y, x), Math.atan2(y, x));
    if (d > worst) worst = d;
  }
  assert.ok(worst <= 1n, `atan2 à ${worst} ulp de Math`);
}

// Un cas de référence des tests de la crate `libm` : sin juste sous π, où la réduction est la plus délicate.
assert.equal(sin(bitsOf(0x400921fb000fd5ddn)), bitsOf(0x3ea50d15ced1a4a2n), "sin près de π : les bits de libm");

// Cas particuliers, comme musl.
assert.ok(Object.is(sin(-0), -0), "sin(-0) = -0");
assert.equal(cos(0), 1);
assert.equal(exp(0), 1);
assert.equal(log(1), 0);
assert.equal(log(0), -Infinity);
assert.ok(Number.isNaN(log(-1)), "log(-1) = NaN");
assert.equal(exp(710), Infinity);
assert.equal(exp(-746), 0);
assert.equal(exp(-Infinity), 0);
assert.equal(atan(Infinity), Math.PI / 2);
assert.equal(atan2(0, -1), Math.PI);
assert.ok(Object.is(atan2(-0, 1), -0), "atan2(-0, 1) = -0");
assert.equal(atan2(1, 0), Math.PI / 2);
assert.equal(atan2(-Infinity, -Infinity), -3 * Math.PI / 4);
assert.ok(Number.isNaN(sin(Infinity)) && Number.isNaN(cos(Number.NaN)), "sin(∞), cos(NaN) = NaN");
// La limite assumée (`ponytail:` de remPio2) : au-delà de 2^20·π/2, NaN plutôt qu'une réduction fausse.
assert.ok(Number.isNaN(sin(1_700_000)) && Number.isNaN(cos(-1e300)), "au-delà de 1,6 million : NaN");

console.log("ok — fonctions mathématiques déterministes conformes");
