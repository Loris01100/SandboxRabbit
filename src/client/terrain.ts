/**
 * Un monde généré à partir d'une graine : relief, lacs, sable et arbres en
 * surface, grottes (en partie noyées), poches de pétrole, veines de métal,
 * grains d'uranium et poches de lave en profondeur. La même graine redonne le
 * même monde, à toute taille de grille : « essaie la graine 4217 » suffit
 * pour partager un décor.
 *
 * Le monde est bâti **au repos** : sable seulement où la pente ne dépasse pas
 * une cellule, eau remplie jusqu'à un niveau plat, pétrole et lave enfermés
 * dans la pierre, uranium en grains isolés. Sinon, en 1920×1080, tout le bac
 * s'effondrait à la première seconde — un tiers de l'écran en mouvement, le
 * pire cas du moteur.
 *
 * Le tirage vient d'un générateur à lui, semé par la graine, pas de
 * `engine.rand()` : bâtir le monde décalerait sinon le tirage du bac, et un
 * invité de salon — qui reçoit la grille toute faite — divergerait.
 *
 * Pur, sans DOM : test/sim.ts le charge sous Node.
 */
import type { Engine } from "./sim/engine.ts";
import { EMPTY, LAVA, METAL, PETROLEUM, PLANT, SAND, STONE, URANIUM, WATER, WOOD, type MaterialId } from "./sim/materials.ts";

/** Graines acceptées : ce qu'un joueur tape et retient. */
export const SEEDS = 999_999;

/**
 * Échelle du décor en mode exploration : arbres, grottes et lacs gardent la
 * taille qu'ils ont en 320×180, ×1,5, quelle que soit la grille. Sans elle, un
 * monde 1280×720 a des arbres quatre fois plus grands, et le héros (sept
 * cellules) y paraît minuscule même zoomé.
 */
export const EXPLORE_SCALE = 1.5;

/** Bruit de valeur en un point entier du réseau, dans [0, 1). Un hachage, pas un état : lisible dans n'importe quel ordre. */
function lattice(seed: number, x: number, y: number): number {
  let h = Math.imul(x, 0x27d4eb2d) ^ Math.imul(y, 0x165667b1) ^ Math.imul(seed, 0x9e3779b1);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return ((h ^ (h >>> 16)) >>> 0) / 0x1_0000_0000;
}

const smooth = (t: number): number => t * t * (3 - 2 * t);

/** Bruit de valeur lissé en (x, y), réseau de pas 1, dans [0, 1). */
function noise(seed: number, x: number, y: number): number {
  const ix = Math.floor(x), iy = Math.floor(y);
  const u = smooth(x - ix), v = smooth(y - iy);
  const a = lattice(seed, ix, iy), b = lattice(seed, ix + 1, iy);
  const c = lattice(seed, ix, iy + 1), d = lattice(seed, ix + 1, iy + 1);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}

/** Trois octaves de `noise`, dans [0, 1) : de grandes formes, puis du détail. */
function fbm(seed: number, x: number, y: number): number {
  return (noise(seed, x, y) * 4 + noise(seed + 1, x * 2, y * 2) * 2 + noise(seed + 2, x * 4, y * 4)) / 7;
}

/** Ce qu'une poche de liquide peut toucher sans se déverser. */
const SEALS = new Set<MaterialId>([STONE, METAL, URANIUM]);

/** Ce qui ne dépend que de la graine, de la hauteur et de l'échelle : partagé par `terrain()` et `land()`. */
interface Plan {
  seed: number;
  h: number;
  /** Échelle des formes. */
  s: number;
  /** Côté d'une maille de bruit, en cellules : les formes gardent leur taille relative au bac (ou fixe, avec une échelle donnée). */
  cell: number;
  /** Niveau de la mer : l'eau remplit les creux du relief jusque-là. */
  sea: number;
  /** Nappe : sous elle, une grotte est noyée. */
  table: number;
}

function plan(seed: number, h: number, s: number): Plan {
  return { seed, h, s, cell: 40 * s, sea: Math.round(h * 0.47), table: Math.round(h * 0.72) };
}

/** Hauteur du sol de la colonne `x` du monde. */
function surface(p: Plan, x: number): number {
  return Math.round(p.h * (0.36 + 0.9 * (fbm(p.seed, x / (p.cell * 4), 0.5) - 0.5)));
}

/** Matière de (x, y) sous la surface `top`, avant scellement des poches : sable sur `soil` cellules, puis pierre, grottes, pétrole, lave, métal. */
function under(p: Plan, x: number, y: number, top: number, soil: number): MaterialId {
  const { seed, h, s, cell, table } = p;
  const depth = y - top;
  if (depth < soil) return SAND;
  if (depth <= 8 * s) return STONE;
  const dig = fbm(seed + 10, x / cell, y / cell);
  const deep = (y - top) / (h - top);
  if (dig > 0.62 - 0.08 * deep) return y >= table ? WATER : EMPTY;
  if (y > h * 0.5 && y < h * 0.78 && fbm(seed + 20, x / (cell / 2), y / (cell / 2)) > 0.74) return PETROLEUM;
  if (y > h * 0.84 && dig < 0.42 && fbm(seed + 30, x / (cell / 2), y / (cell / 2)) > 0.7) return LAVA;
  if (fbm(seed + 40, x / (cell / 4), y / (cell / 4)) > 0.76) return METAL;
  return STONE;
}

/**
 * Bâtit le monde de la graine `seed` sur un bac vidé. Par défaut, les
 * distances sont en fraction de la hauteur (`h`) : un monde 1920×1080 est le
 * même que son 320×180, en plus fin et plus large. `scale` les fixe à la place
 * (`EXPLORE_SCALE`) : les étages (mer, nappe, pétrole, lave) restent en
 * fraction de `h`, seules les formes gardent une taille en cellules.
 *
 * Trois passes. Le relief et le sous-sol, colonne par colonne. Puis les
 * poches de pétrole et de lave sont refermées : une cellule qui touche autre
 * chose que la roche ou sa propre poche redevient pierre — une poche ouverte
 * sur une grotte s'y déversait dès le premier tick. Enfin ce qui se pose au
 * hasard : l'uranium en grains isolés (trois voisins, et il s'emballe
 * jusqu'à sauter), les arbres, les touffes et les lapins sur le sable sec —
 * et le héros, au sec le plus près du centre.
 */
export function terrain(e: Engine, seed: number, scale?: number): void {
  const { width: w, height: h } = e;
  const p = plan(seed, h, scale ?? h / 180);
  const { s, sea } = p;

  const ground = new Int32Array(w);
  for (let x = 0; x < w; x++) ground[x] = surface(p, x);

  for (let x = 0; x < w; x++) {
    const top = ground[x];
    const flat = Math.abs(ground[Math.max(0, x - 1)] - top) <= 1 && Math.abs(ground[Math.min(w - 1, x + 1)] - top) <= 1;
    const soil = flat ? Math.round(3 * s) + 1 : 0;
    for (let y = sea; y < top; y++) e.set(x, y, WATER);
    for (let y = top; y < h; y++) {
      const id = under(p, x, y, top, soil);
      if (id !== EMPTY) e.set(x, y, id);
    }
  }

  const sealed = (x: number, y: number, id: MaterialId): boolean => {
    const n = e.get(x, y);
    return n === id || SEALS.has(n);
  };
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const id = e.get(x, y);
      if (id !== PETROLEUM && id !== LAVA) continue;
      if (!sealed(x - 1, y, id) || !sealed(x + 1, y, id) || !sealed(x, y - 1, id) || !sealed(x, y + 1, id)) e.set(x, y, STONE);
    }
  }

  let rng = seed >>> 0 || 1;
  const rand = (): number => {
    rng ^= rng << 13; rng >>>= 0;
    rng ^= rng >>> 17;
    rng ^= rng << 5; rng >>>= 0;
    return rng / 0x1_0000_0000;
  };

  for (let n = Math.max(1, Math.round((w * h) / 500_000)); n > 0; n--) {
    const cx = Math.floor(rand() * w), cy = Math.floor(h * (0.75 + 0.2 * rand()));
    for (let k = 0; k < 12; k++) {
      const x = cx + 2 * Math.floor(rand() * 6), y = cy + 2 * Math.floor(rand() * 6);
      if (e.get(x, y) === STONE && e.get(x - 1, y) === STONE && e.get(x + 1, y) === STONE && e.get(x, y - 1) === STONE && e.get(x, y + 1) === STONE) {
        e.set(x, y, URANIUM);
      }
    }
  }

  for (let x = Math.round(6 * s); x < w - 6 * s; x++) {
    const top = ground[x];
    if (top >= sea || e.get(x, top) !== SAND) continue;
    const r = rand();
    if (r < 0.012) {
      const trunk = Math.round((6 + rand() * 8) * s);
      for (let y = top - trunk; y < top; y++) e.set(x, y, WOOD);
      const crown = Math.round((2 + rand() * 3) * s);
      for (let dy = -crown; dy <= crown; dy++) {
        for (let dx = -crown; dx <= crown; dx++) {
          if (dx * dx + dy * dy <= crown * crown && e.get(x + dx, top - trunk + dy) === EMPTY) e.set(x + dx, top - trunk + dy, PLANT);
        }
      }
      x += Math.round(4 * s);
    } else if (r < 0.02) {
      e.spawnRabbit(x, top - 2, rand() < 0.5 ? 1 : -1);
      x += 5;
    } else if (r < 0.2) {
      e.set(x, top - 1, PLANT);
    }
  }

  for (let d = 0; d < w / 2; d++) {
    const x = (w >> 1) + (d & 1 ? d : -d);
    if (ground[x] < sea && e.spawnHero(x, ground[x] - 2) >= 0) break;
  }
}

/**
 * Largeur d'un chunk du mode exploration, en colonnes (docs/agents/exploration.md).
 * Multiple de 16 et de 32 : un décalage de la fenêtre garde l'alignement des
 * blocs de veille et du damier.
 */
export const STRIP = 256;

/** Grain du rendu (`noise`) d'une cellule du monde : un hachage, pour qu'un chunk revisité garde le même grain. */
const grain = (x: number, y: number): number => ((lattice(0x67a1, x, y) * 255) | 0) - 128;

/**
 * Bâtit les colonnes `[from, to)` du bac, qui sont les colonnes `x0 + from …`
 * d'un monde infini en largeur, à l'échelle `scale` (`EXPLORE_SCALE`). Étape 1
 * du mode exploration : la fenêtre glissante la rappellera sur chaque chunk
 * qui entre.
 *
 * Chaque cellule ne dépend que de sa position dans le monde : bâtir en une
 * fois ou par tranches, dans n'importe quel ordre, donne la même grille au bit
 * près, et deux fenêtres décalées coïncident sur leurs colonnes communes.
 * D'où les écarts avec `terrain()`, qui garde son monde de toujours :
 *
 * - le scellement des poches lit les voisines **avant** scellement, pas
 *   celles qu'il vient de refermer ;
 * - l'uranium est tiré par chunk (graine, numéro), centres et grains sur des
 *   coordonnées paires : deux grains ne se touchent jamais ;
 * - arbres, touffes et lapins : un tirage par colonne. Un arbre ne saute plus
 *   les colonnes qui le suivent, il cède la place à tout candidat des
 *   `4 * scale` colonnes à sa gauche. Le bois l'emporte sur le feuillage, quel
 *   que soit l'ordre des arbres ;
 * - un lapin ne naît que si son corps tient dans son chunk et dans la
 *   tranche : bâtir par tranches alignées sur `STRIP` redonne exactement les
 *   mêmes lapins ;
 * - pas de héros : c'est au mode de le poser, une fois ;
 * - le grain du rendu vient de la position, pas de `engine.rand()`.
 *
 * Remplace tout ce qu'elle bâtit (vide compris), température ramenée à
 * l'ambiante. Ne consomme aucun tirage du bac.
 */
export function land(e: Engine, seed: number, scale: number, x0: number, from: number, to: number): void {
  const { width: w, height: h } = e;
  from = Math.max(0, from);
  to = Math.min(w, to);
  if (from >= to) return;
  const p = plan(seed, h, scale);
  const { s, sea } = p;
  /** Colonnes du monde à bâtir : [a, b). */
  const a = x0 + from, b = x0 + to;
  /** Plus grand rayon de couronne, plus une : un arbre de si loin peut déborder ici. */
  const reach = Math.round(5 * s) + 1;
  /** Un arbre cède la place à un candidat des `gap` colonnes à sa gauche. */
  const gap = Math.round(4 * s);

  // Le relief, d'assez loin pour lire la pente des colonnes du bord et les arbres qui débordent.
  const g0 = a - reach - gap - 3, g1 = b + reach + 3;
  const ground = new Int32Array(g1 - g0);
  for (let x = g0; x < g1; x++) ground[x - g0] = surface(p, x);
  const top = (x: number): number => ground[x - g0];
  const flat = (x: number): boolean => Math.abs(top(x - 1) - top(x)) <= 1 && Math.abs(top(x + 1) - top(x)) <= 1;

  // Le sous-sol avant scellement, deux colonnes de plus de chaque côté : le
  // scellement lit une voisine, et l'uranium du bord lit le scellé de la suivante.
  const r0 = a - 2, r1 = b + 2;
  const raw = new Uint8Array((r1 - r0) * h);
  for (let x = r0; x < r1; x++) {
    const t = top(x), soil = flat(x) ? Math.round(3 * s) + 1 : 0;
    for (let y = 0; y < h; y++) raw[(x - r0) * h + y] = y < t ? (y >= sea ? WATER : EMPTY) : under(p, x, y, t, soil);
  }
  const before = (x: number, y: number): MaterialId => (y < 0 || y >= h ? STONE : raw[(x - r0) * h + y] as MaterialId);

  const s0 = a - 1, s1 = b + 1;
  const sealed = new Uint8Array((s1 - s0) * h);
  const holds = (n: MaterialId, id: MaterialId): boolean => n === id || SEALS.has(n);
  for (let x = s0; x < s1; x++) {
    for (let y = 0; y < h; y++) {
      let id = before(x, y);
      if ((id === PETROLEUM || id === LAVA)
        && !(holds(before(x - 1, y), id) && holds(before(x + 1, y), id) && holds(before(x, y - 1), id) && holds(before(x, y + 1), id))) id = STONE;
      sealed[(x - s0) * h + y] = id;
    }
  }
  const at = (x: number, y: number): MaterialId => (y < 0 || y >= h ? STONE : sealed[(x - s0) * h + y] as MaterialId);

  const out = sealed.slice((a - s0) * h, (b - s0) * h);
  const put = (x: number, y: number, id: MaterialId): void => {
    if (x >= a && x < b && y >= 0 && y < h) out[(x - a) * h + y] = id;
  };
  const got = (x: number, y: number): number => (x >= a && x < b && y >= 0 && y < h ? out[(x - a) * h + y] : -1);

  // L'uranium : des grappes tirées par chunk, qui débordent d'au plus dix colonnes sur le suivant.
  const clusters = Math.max(1, Math.round((STRIP * h) / 500_000));
  for (let c = Math.floor((a - 11) / STRIP); c <= Math.floor((b - 1) / STRIP); c++) {
    let rng = ((lattice(seed + 60, c, 0) * 0x1_0000_0000) >>> 0) || 1;
    const rand = (): number => {
      rng ^= rng << 13; rng >>>= 0;
      rng ^= rng >>> 17;
      rng ^= rng << 5; rng >>>= 0;
      return rng / 0x1_0000_0000;
    };
    for (let n = 0; n < clusters; n++) {
      const cx = c * STRIP + 2 * Math.floor(rand() * (STRIP / 2)), cy = 2 * Math.floor((h * (0.75 + 0.2 * rand())) / 2);
      for (let k = 0; k < 12; k++) {
        // Les deux tirages avant le test : la suite ne dépend pas de la tranche bâtie.
        const x = cx + 2 * Math.floor(rand() * 6), y = cy + 2 * Math.floor(rand() * 6);
        if (x < a || x >= b) continue;
        if (at(x, y) === STONE && at(x - 1, y) === STONE && at(x + 1, y) === STONE && at(x, y - 1) === STONE && at(x, y + 1) === STONE) put(x, y, URANIUM);
      }
    }
  }

  // La surface : un tirage par colonne.
  const roll = (x: number): number => lattice(seed + 50, x, 0);
  const trunk = (x: number): number => Math.round((6 + lattice(seed + 51, x, 0) * 8) * s);
  const sandy = (x: number): boolean => top(x) < sea && flat(x);
  const sapling = (x: number): boolean => sandy(x) && roll(x) < 0.012;
  const tree = (x: number): boolean => {
    if (!sapling(x)) return false;
    for (let k = 1; k <= gap; k++) if (sapling(x - k)) return false;
    return true;
  };
  for (let x = a - reach; x < b + reach; x++) {
    if (!tree(x)) continue;
    const head = top(x) - trunk(x);
    const crown = Math.round((2 + lattice(seed + 52, x, 0) * 3) * s);
    for (let dy = -crown; dy <= crown; dy++) {
      for (let dx = -crown; dx <= crown; dx++) {
        if (dx * dx + dy * dy <= crown * crown && got(x + dx, head + dy) === EMPTY) put(x + dx, head + dy, PLANT);
      }
    }
  }
  for (let x = a; x < b; x++) {
    const r = roll(x);
    if (sandy(x) && r >= 0.02 && r < 0.2 && got(x, top(x) - 1) === EMPTY) put(x, top(x) - 1, PLANT);
  }
  // Les troncs en dernier : le bois l'emporte sur toute couronne voisine.
  for (let x = a; x < b; x++) {
    if (!tree(x)) continue;
    for (let y = top(x) - trunk(x); y < top(x); y++) put(x, y, WOOD);
  }

  const { noise } = e;
  const temp = e.temp, ambient = e.ambient;
  for (let x = from; x < to; x++) {
    for (let y = 0; y < h; y++) {
      const i = y * w + x;
      temp[i] = ambient;
      e.set(x, y, out[(x - from) * h + y] as MaterialId);
      noise[i] = grain(x0 + x, y);
    }
  }

  // Les lapins en dernier, sur la grille bâtie : leur corps (colonnes x - 2 … x + 2) tient dans leur chunk et dans la tranche.
  const bunny = (x: number): boolean => sandy(x) && roll(x) >= 0.012 && roll(x) < 0.02;
  for (let x = a + 2; x < b - 2; x++) {
    const m = x - Math.floor(x / STRIP) * STRIP;
    if (m < 3 || m > STRIP - 4 || !bunny(x)) continue;
    let alone = true;
    for (let k = 1; k <= 5; k++) if (bunny(x - k)) alone = false;
    if (alone) e.spawnRabbit(x - x0, top(x) - 2, lattice(seed + 53, x, 0) < 0.5 ? 1 : -1);
  }
}
