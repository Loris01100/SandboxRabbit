//! Prototype : `thermal()` d'engine.ts porté en Rust, compilé en WASM, pour
//! mesurer ce qu'un noyau Rust ferait gagner au moteur (`npm run rust`,
//! test/rust.ts). Pas branché sur le bac : le moteur reste engine.ts.
//!
//! Comme engine.ts, un bloc à l'ambiante exacte est recopié sans calcul
//! (`flat()`). Pour les autres, trois façons de faire la diffusion, choisies
//! par `mode` :
//! - 0 : la copie ligne à ligne de `diffuseChunk()`, calcul en f64 comme
//!   JavaScript, `pulled()` compris ;
//! - 1 : la même en SIMD, deux cellules à la fois (f64x2) — même résultat au
//!   bit près, l'arithmétique IEEE ne dépend pas du nombre de voies ;
//! - 2 : SIMD en f32, quatre cellules à la fois (f32x4) — plus rapide, mais
//!   arrondi autrement que JavaScript : un bac mixte JS / WASM divergerait.
//!
//! Aucune dépendance, aucun wasm-bindgen, pas même la bibliothèque standard
//! (`no_std`) : JavaScript réserve la mémoire par `reserve()` et passe des
//! pointeurs. Les tables des matières viennent de
//! materials.ts (test/rust.ts les dérive) : une seule source.

#![no_std]

use core::arch::wasm32::*;

const SHIFT: usize = 4;
const CHUNK: usize = 1 << SHIFT;
const CONDUCTION: f64 = 0.16;
const COOLING: f64 = 0.02;
const STILL: f64 = 0.001;

#[panic_handler]
fn panic(_: &core::panic::PanicInfo) -> ! {
    unreachable()
}

/// Réserve `bytes` octets alignés sur 8 au bout de la mémoire, qu'elle fait
/// grandir, et en rend l'adresse (0 si la mémoire est pleine). Jamais rendus :
/// un bac réserve une fois, au démarrage. JavaScript y pose ses vues
/// (`Uint8Array`, `Float32Array`) après **toutes** les réservations : la
/// mémoire qui grandit invalide les vues déjà prises.
#[unsafe(no_mangle)]
pub extern "C" fn reserve(bytes: usize) -> usize {
    let start = memory_size(0) * 65536;
    if memory_grow(0, bytes.div_ceil(65536).max(1)) == usize::MAX {
        return 0;
    }
    start
}

/// Ce que lit la chaleur d'une matière, rangé par id comme dans engine.ts.
struct Tables<'a> {
    heat: &'a [f32],
    boil_at: &'a [f32],
    freeze_at: &'a [f32],
    boil_into: &'a [u8],
    freeze_into: &'a [u8],
    life: &'a [u8],
    /// `calm` d'engine.ts : ni source, ni matière que l'ambiante ferait
    /// changer d'état. Recalculé à chaque appel, l'ambiante pouvant changer.
    calm: [bool; 256],
}

/// La grille, vue depuis Rust : les tableaux qu'engine.ts range dans `Memory`.
struct Grid<'a> {
    w: usize,
    h: usize,
    cols: usize,
    cells: &'a mut [u8],
    life: &'a mut [u8],
    temp: &'a mut [f32],
    next: &'a mut [f32],
    awake: &'a mut [u8],
    stir: &'a mut [u8],
    ambient: f64,
}

/// `thermal()` d'engine.ts, sur un seul fil : les trois passes sur les blocs
/// éveillés. Le résultat est dans `next` ; l'échange des deux tampons revient
/// à l'appelant, comme dans le moteur. `f32s` : `heat`, `boil_at`,
/// `freeze_at` bout à bout (3 × 256) ; `u8s` : `boil_into`, `freeze_into`,
/// `life` (3 × 256).
///
/// # Safety
/// Chaque pointeur désigne un tableau de la bonne taille réservé par `reserve`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn thermal(
    w: usize, h: usize,
    cells: *mut u8, life: *mut u8, temp: *mut f32, next: *mut f32,
    awake: *mut u8, stir: *mut u8, jobs: *mut u32,
    f32s: *const f32, u8s: *const u8, ambient: f64, mode: u32,
) {
    let n = w * h;
    let cols = w.div_ceil(CHUNK);
    let chunks = cols * h.div_ceil(CHUNK);
    let (f, b) = unsafe { (core::slice::from_raw_parts(f32s, 768), core::slice::from_raw_parts(u8s, 768)) };
    let mut t = Tables {
        heat: &f[..256], boil_at: &f[256..512], freeze_at: &f[512..],
        boil_into: &b[..256], freeze_into: &b[256..512], life: &b[512..],
        calm: [false; 256],
    };
    for id in 0..256 {
        let heat = t.heat[id];
        t.calm[id] = heat != heat && !(ambient > t.boil_at[id] as f64) && !(ambient < t.freeze_at[id] as f64);
    }
    let mut g = unsafe {
        Grid {
            w, h, cols,
            cells: core::slice::from_raw_parts_mut(cells, n),
            life: core::slice::from_raw_parts_mut(life, n),
            temp: core::slice::from_raw_parts_mut(temp, n),
            next: core::slice::from_raw_parts_mut(next, n),
            awake: core::slice::from_raw_parts_mut(awake, chunks),
            stir: core::slice::from_raw_parts_mut(stir, chunks),
            ambient,
        }
    };
    let jobs = unsafe { core::slice::from_raw_parts_mut(jobs, chunks) };
    let mut count = 0;
    for c in 0..chunks {
        g.awake[c] |= g.stir[c];
        if g.awake[c] != 0 {
            jobs[count] = c as u32;
            count += 1;
        }
    }
    for &c in &jobs[..count] {
        heat_chunk(&mut g, &t, c as usize);
    }
    for &c in &jobs[..count] {
        let c = c as usize;
        // Dans la même boucle que la diffusion, pas avant : un changement
        // d'état d'un bloc déjà diffusé change la bordure lue par `flat()`.
        if flat(&g, &t, c) {
            let (x0, y0, x1, y1) = bounds(&g, c);
            for y in y0..y1 {
                g.next[y * w + x0..y * w + x1].fill((ambient + 0.0) as f32);
            }
            g.awake[c] = 2;
            continue;
        }
        match mode {
            1 => diffuse_f64x2(&mut g, &t, c),
            2 => diffuse_f32x4(&mut g, &t, c),
            _ => diffuse_scalar(&mut g, &t, c),
        }
    }
    for &c in &jobs[..count] {
        settle_chunk(&mut g, c as usize);
    }
}

/// Les bornes (x0, y0, x1, y1) du bloc de veille `c`.
fn bounds(g: &Grid, c: usize) -> (usize, usize, usize, usize) {
    let x0 = (c % g.cols) << SHIFT;
    let y0 = (c / g.cols) << SHIFT;
    (x0, y0, (x0 + CHUNK).min(g.w), (y0 + CHUNK).min(g.h))
}

/// `flat()` d'engine.ts : le bloc et sa bordure sont-ils tous à l'ambiante
/// exacte et calmes ? La diffusion y rendrait `t` au bit près : on la saute.
/// Sans ce raccourci, le chantier était 1,5 fois plus lent en Rust f64 qu'en
/// JavaScript, qui l'a. `ambient + 0.0` (à l'appel) écrit +0 là où l'ambiante
/// vaut -0, comme le calcul complet.
fn flat(g: &Grid, tb: &Tables, c: usize) -> bool {
    let (x0, y0, x1, y1) = bounds(g, c);
    let (ya, yb) = (y0.saturating_sub(1), (y1 + 1).min(g.h));
    let (xa, xb) = (x0.saturating_sub(1), (x1 + 1).min(g.w));
    for y in ya..yb {
        let row = y * g.w;
        for i in row + xa..row + xb {
            if g.temp[i] as f64 != g.ambient || !tb.calm[g.cells[i] as usize] {
                return false;
            }
        }
    }
    true
}

/// Passe 1 : les sources tirent leur cellule vers leur température (NaN = ne chauffe pas).
fn heat_chunk(g: &mut Grid, t: &Tables, c: usize) {
    let (x0, y0, x1, y1) = bounds(g, c);
    for y in y0..y1 {
        for i in y * g.w + x0..y * g.w + x1 {
            let heat = t.heat[g.cells[i] as usize] as f64;
            if heat == heat {
                let v = g.temp[i] as f64;
                g.temp[i] = (v + (heat - v) * 0.5) as f32;
            }
        }
    }
}

/// Les voisins du bloc qui dorment (`awake == 0`), dans l'ordre haut, bas,
/// gauche, droite : comme dans `diffuseChunk()`. Stable pendant la passe 2 :
/// elle ne pose que des 2, jamais de 0.
#[derive(Clone, Copy)]
struct Asleep {
    up: bool,
    down: bool,
    left: bool,
    right: bool,
}

fn asleep(g: &Grid, c: usize) -> Asleep {
    let (x0, y0, x1, y1) = bounds(g, c);
    Asleep {
        up: y0 > 0 && g.awake[c - g.cols] == 0,
        down: y1 < g.h && g.awake[c + g.cols] == 0,
        left: x0 > 0 && g.awake[c - 1] == 0,
        right: x1 < g.w && g.awake[c + 1] == 0,
    }
}

/// `pulled()` d'engine.ts : la température d'une cellule d'un bloc endormi,
/// tirée vers la `heat` de sa source comme le ferait `heat_chunk()`, arrondie
/// en f32 pareil. Sans elle, la mer de lave diverge de JavaScript de 3,7 °C
/// à chaque frontière entre bloc endormi et bloc éveillé.
#[inline(always)]
fn pulled(g: &Grid, tb: &Tables, j: usize) -> f64 {
    let heat = tb.heat[g.cells[j] as usize] as f64;
    let t = g.temp[j] as f64;
    if heat == heat { (t + (heat - t) * 0.5) as f32 as f64 } else { t }
}

/// Changement d'état sur place, comme `convert()` : réveille le bloc, pose la matière et sa `life`.
fn convert(g: &mut Grid, t: &Tables, i: usize, into: u8) {
    let y = i / g.w;
    g.stir[(y >> SHIFT) * g.cols + ((i - y * g.w) >> SHIFT)] = 1;
    g.cells[i] = into;
    g.life[i] = t.life[into as usize];
}

/// La fin de la diffusion d'une cellule, commune aux trois modes : le bloc a-t-il bougé, et le changement d'état.
#[inline(always)]
fn after(g: &mut Grid, tb: &Tables, i: usize, t: f64, next: f64, still: &mut bool) {
    let id = g.cells[i] as usize;
    let heat = tb.heat[id] as f64;
    let moved = next - if heat == heat { 2.0 * t - heat } else { t };
    if moved > STILL || moved < -STILL {
        *still = false;
    }
    if next > tb.boil_at[id] as f64 {
        convert(g, tb, i, tb.boil_into[id]);
    } else if next < tb.freeze_at[id] as f64 {
        convert(g, tb, i, tb.freeze_into[id]);
    }
}

/// Une cellule en f64, bords compris : ce que fait `diffuseChunk()` pour
/// chaque cellule, `pulled()` compris au bord d'un bloc endormi.
#[inline(always)]
fn diffuse_one(g: &mut Grid, tb: &Tables, b: (usize, usize, usize, usize), s: Asleep, x: usize, y: usize, still: &mut bool) {
    let (w, h) = (g.w, g.h);
    let (x0, y0, x1, y1) = b;
    let i = y * w + x;
    let t = g.temp[i] as f64;
    let read = |g: &Grid, j: usize, edge: bool| if edge { pulled(g, tb, j) } else { g.temp[j] as f64 };
    let sum = (if y > 0 { read(g, i - w, y == y0 && s.up) } else { t })
        + (if y < h - 1 { read(g, i + w, y == y1 - 1 && s.down) } else { t })
        + (if x > 0 { read(g, i - 1, x == x0 && s.left) } else { t })
        + (if x < w - 1 { read(g, i + 1, x == x1 - 1 && s.right) } else { t });
    let next = t + CONDUCTION * (sum - 4.0 * t) + COOLING * (g.ambient - t);
    g.next[i] = next as f32;
    after(g, tb, i, t, next, still);
}

/// Fin commune d'une passe 2 : le bloc refroidi s'endort (`awake = 2`), sinon il réveille (`stir`).
fn close(g: &mut Grid, c: usize, still: bool) {
    if still {
        g.awake[c] = 2;
    } else {
        g.stir[c] = 1;
    }
}

/// Mode 0 : `diffuseChunk()` ligne à ligne.
fn diffuse_scalar(g: &mut Grid, tb: &Tables, c: usize) {
    let b = bounds(g, c);
    let (x0, y0, x1, y1) = b;
    let s = asleep(g, c);
    let mut still = true;
    for y in y0..y1 {
        for x in x0..x1 {
            diffuse_one(g, tb, b, s, x, y, &mut still);
        }
    }
    close(g, c, still);
}

/// Charge deux f32 consécutifs en f64x2 (conversion exacte).
#[inline(always)]
fn load2(s: &[f32], i: usize) -> v128 {
    f64x2_promote_low_f32x4(unsafe { v128_load64_zero(s.as_ptr().add(i) as *const u64) })
}

/// Mode 1 : deux cellules intérieures à la fois en f64x2, dans l'ordre exact
/// des opérations de JavaScript. Les bords d'un bloc endormi, qui passent par
/// `pulled()`, restent à `diffuse_one()`.
fn diffuse_f64x2(g: &mut Grid, tb: &Tables, c: usize) {
    let b = bounds(g, c);
    let (x0, y0, x1, y1) = b;
    let s = asleep(g, c);
    let (w, h) = (g.w, g.h);
    let (k, cool, four, amb) = (f64x2_splat(CONDUCTION), f64x2_splat(COOLING), f64x2_splat(4.0), f64x2_splat(g.ambient));
    let mut still = true;
    for y in y0..y1 {
        let inner = y > 0 && y < h - 1 && !(y == y0 && s.up) && !(y == y1 - 1 && s.down);
        let mut x = x0;
        while x < x1 {
            if !inner || x == 0 || x + 2 > x1 || x + 1 >= w - 1
                || (x == x0 && s.left) || (x + 2 == x1 && s.right) {
                diffuse_one(g, tb, b, s, x, y, &mut still);
                x += 1;
                continue;
            }
            let i = y * w + x;
            let t = load2(g.temp, i);
            let sum = f64x2_add(f64x2_add(f64x2_add(load2(g.temp, i - w), load2(g.temp, i + w)), load2(g.temp, i - 1)), load2(g.temp, i + 1));
            let next = f64x2_add(
                f64x2_add(t, f64x2_mul(k, f64x2_sub(sum, f64x2_mul(four, t)))),
                f64x2_mul(cool, f64x2_sub(amb, t)),
            );
            unsafe { v128_store64_lane::<0>(f32x4_demote_f64x2_zero(next), g.next.as_mut_ptr().add(i) as *mut u64) };
            after(g, tb, i, f64x2_extract_lane::<0>(t), f64x2_extract_lane::<0>(next), &mut still);
            after(g, tb, i + 1, f64x2_extract_lane::<1>(t), f64x2_extract_lane::<1>(next), &mut still);
            x += 2;
        }
    }
    close(g, c, still);
}

/// Mode 2 : quatre cellules intérieures à la fois, tout en f32. Pas au bit près : mesure de ce que coûte l'exactitude.
fn diffuse_f32x4(g: &mut Grid, tb: &Tables, c: usize) {
    let b = bounds(g, c);
    let (x0, y0, x1, y1) = b;
    let s = asleep(g, c);
    let (w, h) = (g.w, g.h);
    let (k, cool, four, amb) = (f32x4_splat(CONDUCTION as f32), f32x4_splat(COOLING as f32), f32x4_splat(4.0), f32x4_splat(g.ambient as f32));
    let mut still = true;
    for y in y0..y1 {
        let inner = y > 0 && y < h - 1 && !(y == y0 && s.up) && !(y == y1 - 1 && s.down);
        let mut x = x0;
        while x < x1 {
            if !inner || x == 0 || x + 4 > x1 || x + 3 >= w - 1
                || (x == x0 && s.left) || (x + 4 == x1 && s.right) {
                diffuse_one(g, tb, b, s, x, y, &mut still);
                x += 1;
                continue;
            }
            let i = y * w + x;
            let p = g.temp.as_ptr();
            let (t, up, down, left, right) = unsafe {
                (v128_load(p.add(i) as *const v128), v128_load(p.add(i - w) as *const v128), v128_load(p.add(i + w) as *const v128),
                 v128_load(p.add(i - 1) as *const v128), v128_load(p.add(i + 1) as *const v128))
            };
            let sum = f32x4_add(f32x4_add(f32x4_add(up, down), left), right);
            let next = f32x4_add(f32x4_add(t, f32x4_mul(k, f32x4_sub(sum, f32x4_mul(four, t)))), f32x4_mul(cool, f32x4_sub(amb, t)));
            unsafe { v128_store(g.next.as_mut_ptr().add(i) as *mut v128, next) };
            let (tl, nl) = (
                [f32x4_extract_lane::<0>(t), f32x4_extract_lane::<1>(t), f32x4_extract_lane::<2>(t), f32x4_extract_lane::<3>(t)],
                [f32x4_extract_lane::<0>(next), f32x4_extract_lane::<1>(next), f32x4_extract_lane::<2>(next), f32x4_extract_lane::<3>(next)],
            );
            for l in 0..4 {
                after(g, tb, i + l, tl[l] as f64, nl[l] as f64, &mut still);
            }
            x += 4;
        }
    }
    close(g, c, still);
}

/// Passe 3 : un bloc refroidi recopie sa nouvelle température dans l'autre tampon.
fn settle_chunk(g: &mut Grid, c: usize) {
    if g.awake[c] != 2 {
        return;
    }
    let (x0, y0, x1, y1) = bounds(g, c);
    for y in y0..y1 {
        let (a, b) = (y * g.w + x0, y * g.w + x1);
        g.temp[a..b].copy_from_slice(&g.next[a..b]);
    }
}
