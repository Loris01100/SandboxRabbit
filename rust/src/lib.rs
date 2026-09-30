//! Prototype : `thermal()` et la pression (`breathe()`, ici `air()`, en fin de
//! fichier) d'engine.ts portés en Rust, compilés en WASM, pour mesurer ce
//! qu'un noyau Rust ferait gagner au moteur (`npm run rust`, test/rust.ts).
//! Pas branché sur le bac : le moteur reste engine.ts.
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

/// Ce que lit la chaleur d'une matière. Tout sur 16 octets, plutôt qu'un
/// tableau par propriété comme engine.ts : `after()` lit `heat`, `boil_at` et
/// `freeze_at` de chaque cellule, qui tombent ainsi sur la même ligne de cache
/// au lieu de trois.
#[derive(Clone, Copy)]
struct Mat {
    heat: f32,
    boil_at: f32,
    freeze_at: f32,
    boil_into: u8,
    freeze_into: u8,
    life: u8,
    /// `calm` d'engine.ts : ni source, ni matière que l'ambiante ferait
    /// changer d'état. Recalculé à chaque appel, l'ambiante pouvant changer.
    calm: bool,
}

/// Les matières rangées par id. Indexé par un `u8`, le tableau de 256 n'a
/// besoin d'aucune vérification de bornes : le compilateur les retire.
type Tables = [Mat; 256];

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
    let mut t: Tables = [Mat { heat: 0.0, boil_at: 0.0, freeze_at: 0.0, boil_into: 0, freeze_into: 0, life: 0, calm: false }; 256];
    for (id, m) in t.iter_mut().enumerate() {
        let (heat, boil_at, freeze_at) = (f[id], f[256 + id], f[512 + id]);
        let calm = heat != heat && !(ambient > boil_at as f64) && !(ambient < freeze_at as f64);
        *m = Mat { heat, boil_at, freeze_at, boil_into: b[id], freeze_into: b[256 + id], life: b[512 + id], calm };
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
        let (a, b) = (y * g.w + xa, y * g.w + xb);
        for (&t, &id) in g.temp[a..b].iter().zip(&g.cells[a..b]) {
            if t as f64 != g.ambient || !tb[id as usize].calm {
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
        let (a, b) = (y * g.w + x0, y * g.w + x1);
        for (v, &id) in g.temp[a..b].iter_mut().zip(&g.cells[a..b]) {
            let heat = t[id as usize].heat as f64;
            if heat == heat {
                let old = *v as f64;
                *v = (old + (heat - old) * 0.5) as f32;
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
    let heat = tb[g.cells[j] as usize].heat as f64;
    let t = g.temp[j] as f64;
    if heat == heat { (t + (heat - t) * 0.5) as f32 as f64 } else { t }
}

/// Changement d'état sur place, comme `convert()` : réveille le bloc, pose la matière et sa `life`.
fn convert(g: &mut Grid, t: &Tables, i: usize, into: u8) {
    let y = i / g.w;
    g.stir[(y >> SHIFT) * g.cols + ((i - y * g.w) >> SHIFT)] = 1;
    g.cells[i] = into;
    g.life[i] = t[into as usize].life;
}

/// La fin de la diffusion d'une cellule, commune aux trois modes : le bloc
/// a-t-il bougé, et le changement d'état. `id` est la matière de la cellule
/// `i`, lue par l'appelant : avec ou sans vérification de bornes selon qu'il
/// sait `i` dans la grille.
#[inline(always)]
fn after(g: &mut Grid, tb: &Tables, i: usize, id: u8, t: f64, next: f64, still: &mut bool) {
    let m = &tb[id as usize];
    let heat = m.heat as f64;
    let moved = next - if heat == heat { 2.0 * t - heat } else { t };
    if moved > STILL || moved < -STILL {
        *still = false;
    }
    if next > m.boil_at as f64 {
        convert(g, tb, i, m.boil_into);
    } else if next < m.freeze_at as f64 {
        convert(g, tb, i, m.freeze_into);
    }
}

/// La matière de la cellule `i`, sans vérification de bornes.
///
/// # Safety
/// `i < w * h`.
#[inline(always)]
unsafe fn cell(g: &Grid, i: usize) -> u8 {
    unsafe { *g.cells.get_unchecked(i) }
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
    after(g, tb, i, g.cells[i], t, next, still);
}

/// Une cellule intérieure : ses quatre voisines existent et aucune n'est dans
/// un bloc endormi. Le même calcul que `diffuse_one()`, sans ses tests de bord
/// ni ses vérifications de bornes. C'est le cas de toutes les cellules d'un
/// bloc loin du bord du bac dont les quatre voisins sont éveillés ; un voisin
/// endormi n'en retire qu'une ligne ou une colonne.
///
/// # Safety
/// `0 < x < w - 1` et `0 < y < h - 1`, pour `i = y * w + x`.
#[inline(always)]
unsafe fn diffuse_inner(g: &mut Grid, tb: &Tables, i: usize, still: &mut bool) {
    let w = g.w;
    let p = g.temp.as_ptr();
    let (t, up, down, left, right) = unsafe {
        (*p.add(i) as f64, *p.add(i - w) as f64, *p.add(i + w) as f64, *p.add(i - 1) as f64, *p.add(i + 1) as f64)
    };
    // Même ordre d'additions que JavaScript : haut, bas, gauche, droite.
    let sum = up + down + left + right;
    let next = t + CONDUCTION * (sum - 4.0 * t) + COOLING * (g.ambient - t);
    unsafe { *g.next.get_unchecked_mut(i) = next as f32 };
    let id = unsafe { cell(g, i) };
    after(g, tb, i, id, t, next, still);
}

/// Fin commune d'une passe 2 : le bloc refroidi s'endort (`awake = 2`), sinon il réveille (`stir`).
fn close(g: &mut Grid, c: usize, still: bool) {
    if still {
        g.awake[c] = 2;
    } else {
        g.stir[c] = 1;
    }
}

/// Mode 0 : `diffuseChunk()` ligne à ligne. Chaque ligne intérieure passe
/// ses cellules du milieu à `diffuse_inner()`, et seulement ses deux bouts à
/// `diffuse_one()` quand ils touchent le bord du bac ou un bloc endormi.
fn diffuse_scalar(g: &mut Grid, tb: &Tables, c: usize) {
    let b = bounds(g, c);
    let (x0, y0, x1, y1) = b;
    let s = asleep(g, c);
    let (w, h) = (g.w, g.h);
    let mut still = true;
    for y in y0..y1 {
        let inner = y > 0 && y < h - 1 && !(y == y0 && s.up) && !(y == y1 - 1 && s.down);
        if !inner {
            for x in x0..x1 {
                diffuse_one(g, tb, b, s, x, y, &mut still);
            }
            continue;
        }
        let xa = if x0 == 0 || s.left { x0 + 1 } else { x0 };
        // `max` : un bloc d'une seule colonne, au bord à gauche comme à
        // droite, ne doit pas voir sa cellule diffusée deux fois.
        let xb = (if x1 == w || s.right { x1 - 1 } else { x1 }).max(xa);
        for x in x0..xa {
            diffuse_one(g, tb, b, s, x, y, &mut still);
        }
        for x in xa..xb {
            // SAFETY : ligne intérieure (0 < y < h - 1), et xa..xb exclut la
            // colonne 0 comme la colonne w - 1.
            unsafe { diffuse_inner(g, tb, y * w + x, &mut still) };
        }
        for x in xb..x1 {
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
            // SAFETY : i + 1 < w * h, ses voisines viennent d'être lues.
            let (a, b) = unsafe { (cell(g, i), cell(g, i + 1)) };
            after(g, tb, i, a, f64x2_extract_lane::<0>(t), f64x2_extract_lane::<0>(next), &mut still);
            after(g, tb, i + 1, b, f64x2_extract_lane::<1>(t), f64x2_extract_lane::<1>(next), &mut still);
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
                // SAFETY : i + 3 < w * h, ses voisines viennent d'être lues.
                let id = unsafe { cell(g, i + l) };
                after(g, tb, i + l, id, tl[l] as f64, nl[l] as f64, &mut still);
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

// ─── Pression de l'air ────────────────────────────────────────────────────
//
// `breathe()` d'engine.ts : `AIR_STEPS` sous-pas de diffusion entre cellules
// d'air (vide ou gaz), amortis, sur les blocs éveillés ; au dernier, un bloc
// sous `CALM_P` partout est remis à zéro dans les deux tampons. Même calcul
// que JavaScript (f64, rangé en f32, même ordre d'additions) : au bit près,
// dans les deux modes.
// - 0 : cellule par cellule, la copie d'`airChunk()` ;
// - 1 : SIMD, deux cellules intérieures à la fois (f64x2). Le choix « air ou
//   mur » de chaque voisine devient un masque (`v128_bitselect`), exact lui
//   aussi : il choisit des bits, il ne calcule rien.

const AIR_STEPS: usize = 3;
const FLOW: f64 = 0.2;
const DAMP: f64 = 0.98;
const CALM_P: f64 = 0.02;

/// Ce que lit un sous-pas : la grille et la table `OPEN` d'engine.ts (1 = air).
struct Air<'a> {
    w: usize,
    h: usize,
    cols: usize,
    cells: &'a [u8],
    open: &'a [u8; 256],
}

impl Air<'_> {
    #[inline(always)]
    fn open(&self, i: usize) -> bool {
        self.open[self.cells[i] as usize] != 0
    }

    fn bounds(&self, c: usize) -> (usize, usize, usize, usize) {
        let x0 = (c % self.cols) << SHIFT;
        let y0 = (c / self.cols) << SHIFT;
        (x0, y0, (x0 + CHUNK).min(self.w), (y0 + CHUNK).min(self.h))
    }
}

/// `breathe()` sur un seul fil, CTL.gust supposé levé : l'appelant ne
/// l'appelle que s'il y a de la pression. Le résultat est dans `next`, l'autre
/// tampon dans `press` (trois sous-pas, donc un nombre impair d'échanges, comme
/// JavaScript). Rend 1 si un bloc garde de la pression (le `CTL.gust` suivant).
///
/// # Safety
/// Chaque pointeur désigne un tableau de la bonne taille réservé par `reserve`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn air(
    w: usize, h: usize,
    cells: *const u8, press: *mut f32, next: *mut f32,
    awake: *const u8, stir: *mut u8, hush: *mut u8, jobs: *mut u32,
    open: *const u8, mode: u32,
) -> u32 {
    let n = w * h;
    let cols = w.div_ceil(CHUNK);
    let chunks = cols * h.div_ceil(CHUNK);
    let (a, p, q, awake, stir, hush, jobs) = unsafe {
        (
            Air { w, h, cols, cells: core::slice::from_raw_parts(cells, n), open: &*(open as *const [u8; 256]) },
            core::slice::from_raw_parts_mut(press, n),
            core::slice::from_raw_parts_mut(next, n),
            core::slice::from_raw_parts(awake, chunks),
            core::slice::from_raw_parts_mut(stir, chunks),
            core::slice::from_raw_parts_mut(hush, chunks),
            core::slice::from_raw_parts_mut(jobs, chunks),
        )
    };
    let mut count = 0;
    for c in 0..chunks {
        if awake[c] != 0 {
            jobs[count] = c as u32;
            count += 1;
        }
    }
    let mut gust = 0;
    for s in 0..AIR_STEPS {
        // Sous-pas pairs : `press` → `next` ; impairs : l'inverse.
        let (src, dst) = if s % 2 == 0 { (&*p, &mut *q) } else { (&*q, &mut *p) };
        let last = s == AIR_STEPS - 1;
        for &c in &jobs[..count] {
            let c = c as usize;
            let loud = if hushed(&a, src, c) {
                fill_chunk(&a, dst, c);
                false
            } else if mode == 1 {
                air_f64x2(&a, src, dst, c)
            } else {
                air_scalar(&a, src, dst, c)
            };
            if !last {
                continue;
            }
            if loud {
                hush[c] = 0;
                stir[c] = 1;
                gust = 1;
            } else {
                hush[c] = 1;
                fill_chunk(&a, dst, c);
            }
        }
    }
    // Le dernier sous-pas a écrit dans `next` : un bloc calmé vide aussi `press`.
    for &c in &jobs[..count] {
        if hush[c as usize] != 0 {
            fill_chunk(&a, p, c as usize);
        }
    }
    gust
}

/// `hushed()` d'engine.ts : le bloc et sa bordure sans pression, le sous-pas y
/// rendrait 0 partout. Sans ce raccourci, JavaScript (qui l'a) gagnait.
fn hushed(a: &Air, src: &[f32], c: usize) -> bool {
    let (x0, y0, x1, y1) = a.bounds(c);
    let (ya, yb) = (y0.saturating_sub(1), (y1 + 1).min(a.h));
    let (xa, xb) = (x0.saturating_sub(1), (x1 + 1).min(a.w));
    (ya..yb).all(|y| src[y * a.w + xa..y * a.w + xb].iter().all(|&p| p == 0.0))
}

/// Remet à zéro la pression du bloc `c`.
fn fill_chunk(a: &Air, buf: &mut [f32], c: usize) {
    let (x0, y0, x1, y1) = a.bounds(c);
    for y in y0..y1 {
        buf[y * a.w + x0..y * a.w + x1].fill(0.0);
    }
}

/// Une cellule, bords compris : `airChunk()` d'engine.ts. Rend `true` si sa pression reste au-dessus de `CALM_P`.
#[inline(always)]
fn air_one(a: &Air, src: &[f32], dst: &mut [f32], x: usize, y: usize) -> bool {
    let (w, h) = (a.w, a.h);
    let i = y * w + x;
    if !a.open(i) {
        dst[i] = 0.0;
        return false;
    }
    let v = src[i] as f64;
    let up = if y > 0 && a.open(i - w) { src[i - w] as f64 } else { v };
    let down = if y < h - 1 && a.open(i + w) { src[i + w] as f64 } else { v };
    let left = if x > 0 && a.open(i - 1) { src[i - 1] as f64 } else { v };
    let right = if x < w - 1 && a.open(i + 1) { src[i + 1] as f64 } else { v };
    let next = (v + FLOW * (up + down + left + right - 4.0 * v)) * DAMP;
    dst[i] = next as f32;
    next >= CALM_P
}

/// Mode 0 : le bloc cellule par cellule.
fn air_scalar(a: &Air, src: &[f32], dst: &mut [f32], c: usize) -> bool {
    let (x0, y0, x1, y1) = a.bounds(c);
    let mut loud = false;
    for y in y0..y1 {
        for x in x0..x1 {
            loud |= air_one(a, src, dst, x, y);
        }
    }
    loud
}

/// Masque SIMD de deux cellules : tous les bits à 1 pour une cellule d'air.
#[inline(always)]
fn mask2(a: &Air, i: usize) -> v128 {
    // SAFETY (appelants) : i + 1 < w * h.
    let (l, r) = unsafe {
        (a.open[*a.cells.get_unchecked(i) as usize], a.open[*a.cells.get_unchecked(i + 1) as usize])
    };
    i64x2(-(l as i64), -(r as i64))
}

/// Mode 1 : deux cellules intérieures à la fois en f64x2. Les bords du bac restent à `air_one()`.
fn air_f64x2(a: &Air, src: &[f32], dst: &mut [f32], c: usize) -> bool {
    let (x0, y0, x1, y1) = a.bounds(c);
    let (w, h) = (a.w, a.h);
    let (flow, damp, four, zero, calm) =
        (f64x2_splat(FLOW), f64x2_splat(DAMP), f64x2_splat(4.0), f64x2_splat(0.0), f64x2_splat(CALM_P));
    let mut loud = false;
    for y in y0..y1 {
        let inner = y > 0 && y < h - 1;
        let mut x = x0;
        while x < x1 {
            if !inner || x == 0 || x + 2 > x1 || x + 1 >= w - 1 {
                loud |= air_one(a, src, dst, x, y);
                x += 1;
                continue;
            }
            let i = y * w + x;
            let v = load2(src, i);
            // Une voisine qui n'est pas de l'air compte pour la cellule elle-même.
            let up = v128_bitselect(load2(src, i - w), v, mask2(a, i - w));
            let down = v128_bitselect(load2(src, i + w), v, mask2(a, i + w));
            let left = v128_bitselect(load2(src, i - 1), v, mask2(a, i - 1));
            let right = v128_bitselect(load2(src, i + 1), v, mask2(a, i + 1));
            let sum = f64x2_add(f64x2_add(f64x2_add(up, down), left), right);
            let next = f64x2_mul(f64x2_add(v, f64x2_mul(flow, f64x2_sub(sum, f64x2_mul(four, v)))), damp);
            let next = v128_bitselect(next, zero, mask2(a, i));
            unsafe { v128_store64_lane::<0>(f32x4_demote_f64x2_zero(next), dst.as_mut_ptr().add(i) as *mut u64) };
            loud |= v128_any_true(f64x2_ge(next, calm));
            x += 2;
        }
    }
    loud
}
