/**
 * Fonctions mathématiques **déterministes** : les mêmes bits dans tous les
 * navigateurs, sur tous les processeurs, et dans la crate Rust `libm`.
 *
 * Les `sin()`, `exp()`… de `Math` sont « approchées selon l'implémentation » : un bit
 * d'écart entre Chrome et Firefox suffit à faire diverger un salon, d'où leur
 * interdiction dans engine.ts et terrain.ts (test/sim.ts lit la source). Ici,
 * rien que + − × ÷ et des lectures de bits : des opérations qu'IEEE 754
 * arrondit exactement, partout. Une règle qui a besoin d'un angle, d'une
 * onde ou d'une décroissance passe par ce module.
 *
 * Chaque fonction est la copie ligne à ligne de celle de musl (issue de
 * fdlibm, Sun 1993), telle que la porte la crate Rust `libm` 0.2.16 :
 * mêmes constantes, mêmes opérations, dans le même ordre. `npm run rust` le
 * vérifie au bit près sur des millions d'arguments (test/rust.ts), et
 * test/libm.ts compare à `Math` sous V8 (écart d'au plus un ulp). Un futur
 * moteur Rust appellera donc la crate et retombera sur les mêmes bits.
 *
 * Les copyrights de fdlibm demandent de garder leur mention : « Copyright (C)
 * 1993 by Sun Microsystems, Inc. All rights reserved. Developed at SunPro, a
 * Sun Microsystems, Inc. business. Permission to use, copy, modify, and
 * distribute this software is freely granted, provided that this notice is
 * preserved. »
 *
 * Pas de `pow` : celle de musl fait 300 lignes. `exp(y * log(x))` est
 * déterministe aussi, à environ 1e-13 près de la vraie valeur.
 *
 * Pur, sans DOM : chargé par les tests sous Node.
 */

/*
 * Lire et écrire les bits d'un double. Deux mots de 32 bits, poids fort en
 * [1] : l'ordre petit-boutiste de toutes les plateformes où tourne le jeu.
 */
const F = new Float64Array(1);
const U = new Uint32Array(F.buffer);
if (new Uint8Array(new Uint16Array([1]).buffer)[0] !== 1) throw new Error("libm.ts suppose une plateforme petit-boutiste");

/** Mot de poids fort de `x` (signe, exposant, 20 bits de mantisse). */
function high(x: number): number {
  F[0] = x;
  return U[1];
}

/** Mot de poids faible de `x`. */
function low(x: number): number {
  F[0] = x;
  return U[0];
}

/** Le double dont les mots sont `hi` et `lo`. */
function make(hi: number, lo: number): number {
  U[1] = hi;
  U[0] = lo;
  return F[0];
}

/** 2^k, exact, pour -1022 ≤ k ≤ 1023. */
const two = (k: number): number => make((k + 0x3ff) << 20 >>> 0, 0);

/**
 * `x × 2^n` arrondi une seule fois, comme `scalbn` : le résultat exact,
 * correctement arrondi s'il tombe dans les sous-normaux. Les étapes
 * intermédiaires restent normales, donc exactes.
 */
function scalbn(x: number, n: number): number {
  if (n > 1023) {
    x *= two(1023);
    n -= 1023;
    if (n > 1023) {
      x *= two(1023);
      n -= 1023;
      if (n > 1023) n = 1023;
    }
  } else if (n < -1022) {
    // 2^-1022 × 2^53 d'abord : x reste normal, la multiplication est exacte ;
    // seule la dernière arrondit.
    x *= two(-1022) * two(53);
    n += 1022 - 53;
    if (n < -1022) {
      x *= two(-1022) * two(53);
      n += 1022 - 53;
      if (n < -1022) n = -1022;
    }
  }
  return x * two(n);
}

// ─── sin, cos ─────────────────────────────────────────────────────────────

const S1 = -1.66666666666666324348e-01;
const S2 = 8.33333333332248946124e-03;
const S3 = -1.98412698298579493134e-04;
const S4 = 2.75573137070700676789e-06;
const S5 = -2.50507602534068634195e-08;
const S6 = 1.58969099521155010221e-10;

/** sin sur [-π/4, π/4] ; `y` la queue de l'argument réduit, `iy` = 0 si elle est nulle. */
function kSin(x: number, y: number, iy: number): number {
  const z = x * x;
  const w = z * z;
  const r = S2 + z * (S3 + z * S4) + z * w * (S5 + z * S6);
  const v = z * x;
  if (iy === 0) return x + v * (S1 + z * r);
  return x - ((z * (0.5 * y - v * r) - y) - v * S1);
}

const C1 = 4.16666666666666019037e-02;
const C2 = -1.38888888888741095749e-03;
const C3 = 2.48015872894767294178e-05;
const C4 = -2.75573143513906633035e-07;
const C5 = 2.08757232129817482790e-09;
const C6 = -1.13596475577881948265e-11;

/** cos sur [-π/4, π/4]. */
function kCos(x: number, y: number): number {
  const z = x * x;
  const w = z * z;
  const r = z * (C1 + z * (C2 + z * C3)) + w * w * (C4 + z * (C5 + z * C6));
  const hz = 0.5 * z;
  const v = 1.0 - hz;
  return v + (((1.0 - v) - hz) + (z * r - x * y));
}

const TO_INT = 1.5 / 2.2204460492503131e-16;
const INV_PIO2 = 6.36619772367581382433e-01;
const PIO2_1 = 1.57079632673412561417e+00;
const PIO2_1T = 6.07710050650619224932e-11;
const PIO2_2 = 6.07710050630396597660e-11;
const PIO2_2T = 2.02226624879595063154e-21;
const PIO2_3 = 2.02226624871116645580e-21;
const PIO2_3T = 8.47842766036889956997e-32;

/** Résultat de la réduction d'argument : x = n·π/2 + (y0 + y1). Réutilisé, rien n'est alloué par appel. */
let n = 0, y0 = 0, y1 = 0;

/** La réduction de `rem_pio2` pour |x| < 2^20·π/2 : jusqu'à trois tours de Cody-Waite. */
function medium(x: number, ix: number): void {
  const fn = x * INV_PIO2 + TO_INT - TO_INT; // arrondi au plus proche de x / (π/2)
  n = Math.trunc(fn);
  let r = x - fn * PIO2_1;
  let w = fn * PIO2_1T;
  y0 = r - w;
  const ex = ix >>> 20;
  if (ex - ((high(y0) >>> 20) & 0x7ff) > 16) {
    let t = r;
    w = fn * PIO2_2;
    r = t - w;
    w = fn * PIO2_2T - ((t - r) - w);
    y0 = r - w;
    if (ex - ((high(y0) >>> 20) & 0x7ff) > 49) {
      t = r;
      w = fn * PIO2_3;
      r = t - w;
      w = fn * PIO2_3T - ((t - r) - w);
      y0 = r - w;
    }
  }
  y1 = (r - y0) - w;
}

/** Pose `k·π/2` retranché de x (k de 1 à 4, signe compris) : les cas proches de l'origine. */
function near(x: number, k: number): void {
  const z = x - k * PIO2_1;
  y0 = z - k * PIO2_1T;
  y1 = (z - y0) - k * PIO2_1T;
  n = k;
}

/**
 * `rem_pio2` : x = n·π/2 + y0 + y1, |y0| ≤ π/4. Rend false si |x| dépasse
 * 2^20·π/2 (≈ 1,6 million), où musl passe à la réduction de Payne-Hanek.
 *
 * ponytail: pas de Payne-Hanek (`rem_pio2_large`, 400 lignes) : au-delà de
 * 1,6 million, sin et cos rendent NaN. Aucun angle d'une règle n'en approche ;
 * à porter le jour où une phase qui tourne sans fin en a besoin.
 */
function remPio2(x: number): boolean {
  const hx = high(x);
  const sign = hx >>> 31;
  const ix = hx & 0x7fffffff;
  // `k * PIO2_1` et `k * PIO2_1T` : `2.0 * PIO2_1` dans musl, le même produit.
  if (ix <= 0x400f6a7a) { // |x| ≲ 5π/4
    if ((ix & 0xfffff) === 0x921fb) { medium(x, ix); return true; } // ≈ π/2 ou π : cancellation
    if (ix <= 0x4002d97c) { // |x| ≲ 3π/4
      if (sign === 0) near(x, 1);
      else { const z = x + PIO2_1; y0 = z + PIO2_1T; y1 = (z - y0) + PIO2_1T; n = -1; }
      return true;
    }
    if (sign === 0) near(x, 2);
    else { const z = x + 2 * PIO2_1; y0 = z + 2 * PIO2_1T; y1 = (z - y0) + 2 * PIO2_1T; n = -2; }
    return true;
  }
  if (ix <= 0x401c463b) { // |x| ≲ 9π/4
    if (ix <= 0x4015fdbc) { // |x| ≲ 7π/4
      if (ix === 0x4012d97c) { medium(x, ix); return true; } // ≈ 3π/2
      if (sign === 0) near(x, 3);
      else { const z = x + 3 * PIO2_1; y0 = z + 3 * PIO2_1T; y1 = (z - y0) + 3 * PIO2_1T; n = -3; }
      return true;
    }
    if (ix === 0x401921fb) { medium(x, ix); return true; } // ≈ 2π
    if (sign === 0) near(x, 4);
    else { const z = x + 4 * PIO2_1; y0 = z + 4 * PIO2_1T; y1 = (z - y0) + 4 * PIO2_1T; n = -4; }
    return true;
  }
  if (ix < 0x413921fb) { medium(x, ix); return true; }
  return false;
}

/** Sinus, au bit près de musl. NaN pour l'infini, NaN, et |x| > 2^20·π/2. */
export function sin(x: number): number {
  const ix = high(x) & 0x7fffffff;
  if (ix <= 0x3fe921fb) { // |x| ≲ π/4
    if (ix < 0x3e500000) return x; // |x| < 2^-26
    return kSin(x, 0, 0);
  }
  if (ix >= 0x7ff00000 || !remPio2(x)) return Number.NaN;
  switch (n & 3) {
    case 0: return kSin(y0, y1, 1);
    case 1: return kCos(y0, y1);
    case 2: return -kSin(y0, y1, 1);
    default: return -kCos(y0, y1);
  }
}

/** Cosinus, au bit près de musl. NaN pour l'infini, NaN, et |x| > 2^20·π/2. */
export function cos(x: number): number {
  const ix = high(x) & 0x7fffffff;
  if (ix <= 0x3fe921fb) {
    if (ix < 0x3e46a09e) return 1; // |x| < 2^-27·√2
    return kCos(x, 0);
  }
  if (ix >= 0x7ff00000 || !remPio2(x)) return Number.NaN;
  switch (n & 3) {
    case 0: return kCos(y0, y1);
    case 1: return -kSin(y0, y1, 1);
    case 2: return -kCos(y0, y1);
    default: return kSin(y0, y1, 1);
  }
}

// ─── atan, atan2 ──────────────────────────────────────────────────────────

const ATANHI = [4.63647609000806093515e-01, 7.85398163397448278999e-01, 9.82793723247329054082e-01, 1.57079632679489655800e+00];
const ATANLO = [2.26987774529616870924e-17, 3.06161699786838301793e-17, 1.39033110312309984516e-17, 6.12323399573676603587e-17];
const AT0 = 3.33333333333329318027e-01, AT1 = -1.99999999998764832476e-01, AT2 = 1.42857142725034663711e-01;
const AT3 = -1.11111104054623557880e-01, AT4 = 9.09088713343650656196e-02, AT5 = -7.69187620504482999495e-02;
const AT6 = 6.66107313738753120669e-02, AT7 = -5.83357013379057348645e-02, AT8 = 4.97687799461593236017e-02;
const AT9 = -3.65315727442169155270e-02, AT10 = 1.62858201153657823623e-02;

/** Arc tangente, au bit près de musl. */
export function atan(x: number): number {
  let ix = high(x);
  const sign = ix >>> 31;
  ix &= 0x7fffffff;
  if (ix >= 0x44100000) { // |x| ≥ 2^66
    if (Number.isNaN(x)) return x;
    const z = ATANHI[3] + make(0x03800000, 0); // + 2^-120 : le « inexact » de musl, sans effet sur l'arrondi
    return sign ? -z : z;
  }
  let id: number;
  if (ix < 0x3fdc0000) { // |x| < 0,4375
    if (ix < 0x3e400000) return x; // |x| < 2^-27
    id = -1;
  } else {
    x = Math.abs(x);
    if (ix < 0x3ff30000) { // |x| < 1,1875
      if (ix < 0x3fe60000) { x = (2 * x - 1) / (2 + x); id = 0; } // 7/16 ≤ |x| < 11/16
      else { x = (x - 1) / (x + 1); id = 1; } // 11/16 ≤ |x| < 19/16
    } else if (ix < 0x40038000) { x = (x - 1.5) / (1 + 1.5 * x); id = 2; } // |x| < 2,4375
    else { x = -1 / x; id = 3; }
  }
  const z = x * x;
  const w = z * z;
  const s1 = z * (AT0 + w * (AT2 + w * (AT4 + w * (AT6 + w * (AT8 + w * AT10)))));
  const s2 = w * (AT1 + w * (AT3 + w * (AT5 + w * (AT7 + w * AT9))));
  if (id < 0) return x - x * (s1 + s2);
  const r = ATANHI[id] - (x * (s1 + s2) - ATANLO[id] - x);
  return sign ? -r : r;
}

const PI = 3.1415926535897931160E+00;
const PI_LO = 1.2246467991473531772E-16;

/** Angle du point (x, y), dans [-π, π], au bit près de musl. Attention à l'ordre : `atan2(y, x)`. */
export function atan2(y: number, x: number): number {
  if (Number.isNaN(x) || Number.isNaN(y)) return x + y;
  let ix = high(x);
  const lx = low(x);
  let iy = high(y);
  const ly = low(y);
  if ((((ix - 0x3ff00000) >>> 0) | lx) === 0) return atan(y); // x = 1
  const m = ((iy >>> 31) & 1) | ((ix >>> 30) & 2); // 2·signe(x) + signe(y)
  ix &= 0x7fffffff;
  iy &= 0x7fffffff;
  if ((iy | ly) === 0) { // y = 0
    switch (m) {
      case 0: case 1: return y;
      case 2: return PI;
      default: return -PI;
    }
  }
  if ((ix | lx) === 0) return m & 1 ? -PI / 2 : PI / 2; // x = 0
  if (ix === 0x7ff00000) { // x infini
    if (iy === 0x7ff00000) {
      switch (m) {
        case 0: return PI / 4;
        case 1: return -PI / 4;
        case 2: return 3 * PI / 4;
        default: return -3 * PI / 4;
      }
    }
    switch (m) {
      case 0: return 0;
      case 1: return -0;
      case 2: return PI;
      default: return -PI;
    }
  }
  // |y/x| > 2^64. `>>> 0` : l'addition déborde en 32 bits sans signe, comme `wrapping_add` en Rust.
  if (((ix + (64 << 20)) >>> 0) < iy || iy === 0x7ff00000) return m & 1 ? -PI / 2 : PI / 2;
  const z = m & 2 && ((iy + (64 << 20)) >>> 0) < ix ? 0 : atan(Math.abs(y / x));
  switch (m) {
    case 0: return z;
    case 1: return -z;
    case 2: return PI - (z - PI_LO);
    default: return (z - PI_LO) - PI;
  }
}

// ─── exp, log ─────────────────────────────────────────────────────────────

const LN2HI = 6.93147180369123816490e-01;
const LN2LO = 1.90821492927058770002e-10;
const INVLN2 = 1.44269504088896338700e+00;
const P1 = 1.66666666666666019037e-01;
const P2 = -2.77777777770155933842e-03;
const P3 = 6.61375632143793436117e-05;
const P4 = -1.65339022054652515390e-06;
const P5 = 4.13813679705723846039e-08;

/** Exponentielle, au bit près de musl. */
export function exp(x: number): number {
  let hx = high(x);
  const sign = hx >>> 31;
  hx &= 0x7fffffff;
  if (hx >= 0x4086232b) { // |x| ≥ 708,39…
    if (Number.isNaN(x)) return x;
    if (x > 709.782712893383973096) return x * two(1023); // débordement : +∞
    if (x < -745.13321910194110842) return 0;
  }
  let hi: number, lo: number, k: number;
  if (hx > 0x3fd62e42) { // |x| > ln2 / 2
    if (hx >= 0x3ff0a2b2) k = Math.trunc(INVLN2 * x + (sign ? -0.5 : 0.5)); // |x| ≥ 1,5·ln2
    else k = 1 - sign - sign;
    hi = x - k * LN2HI; // exact
    lo = k * LN2LO;
    x = hi - lo;
  } else if (hx > 0x3e300000) { // |x| > 2^-28
    k = 0;
    hi = x;
    lo = 0;
  } else {
    return 1 + x;
  }
  const xx = x * x;
  const c = x - xx * (P1 + xx * (P2 + xx * (P3 + xx * (P4 + xx * P5))));
  const y = 1 + (x * c / (2 - c) - lo + hi);
  return k === 0 ? y : scalbn(y, k);
}

const LG1 = 6.666666666666735130e-01;
const LG2 = 3.999999999940941908e-01;
const LG3 = 2.857142874366239149e-01;
const LG4 = 2.222219843214978396e-01;
const LG5 = 1.818357216161805012e-01;
const LG6 = 1.531383769920937332e-01;
const LG7 = 1.479819860511658591e-01;

/** Logarithme népérien, au bit près de musl. */
export function log(x: number): number {
  let hx = high(x);
  let lx = low(x);
  let k = 0;
  if (hx < 0x00100000 || hx >>> 31) { // sous-normal, zéro ou négatif
    if (((hx & 0x7fffffff) | lx) === 0) return -1 / (x * x); // log(±0) = -∞
    if (hx >>> 31) return (x - x) / 0; // log(négatif) = NaN
    k -= 54;
    x *= make(0x43500000, 0); // × 2^54
    hx = high(x);
    lx = low(x);
  } else if (hx >= 0x7ff00000) {
    return x;
  } else if (hx === 0x3ff00000 && lx === 0) {
    return 0;
  }
  // Ramène x dans [√2/2, √2].
  hx = (hx + (0x3ff00000 - 0x3fe6a09e)) >>> 0;
  k += (hx >>> 20) - 0x3ff;
  hx = (hx & 0x000fffff) + 0x3fe6a09e;
  x = make(hx, lx);
  const f = x - 1.0;
  const hfsq = 0.5 * f * f;
  const s = f / (2.0 + f);
  const z = s * s;
  const w = z * z;
  const t1 = w * (LG2 + w * (LG4 + w * LG6));
  const t2 = z * (LG1 + w * (LG3 + w * (LG5 + w * LG7)));
  const r = t2 + t1;
  const dk = k;
  return s * (hfsq + r) + dk * LN2LO - hfsq + f + dk * LN2HI;
}
