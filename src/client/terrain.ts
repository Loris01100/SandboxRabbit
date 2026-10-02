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
  const s = scale ?? h / 180;
  /** Côté d'une maille de bruit, en cellules : les formes gardent leur taille relative au bac (ou fixe, avec `scale`). */
  const cell = 40 * s;
  const sea = Math.round(h * 0.47);
  const table = Math.round(h * 0.72);

  const ground = new Int32Array(w);
  for (let x = 0; x < w; x++) {
    ground[x] = Math.round(h * (0.36 + 0.9 * (fbm(seed, x / (cell * 4), 0.5) - 0.5)));
  }

  for (let x = 0; x < w; x++) {
    const top = ground[x];
    const flat = Math.abs(ground[Math.max(0, x - 1)] - top) <= 1 && Math.abs(ground[Math.min(w - 1, x + 1)] - top) <= 1;
    const soil = flat ? Math.round(3 * s) + 1 : 0;
    for (let y = sea; y < top; y++) e.set(x, y, WATER);
    for (let y = top; y < h; y++) {
      const depth = y - top;
      let id: MaterialId = depth < soil ? SAND : STONE;
      if (id === STONE && depth > 8 * s) {
        const dig = fbm(seed + 10, x / cell, y / cell);
        const deep = (y - top) / (h - top);
        if (dig > 0.62 - 0.08 * deep) id = y >= table ? WATER : EMPTY;
        else if (y > h * 0.5 && y < h * 0.78 && fbm(seed + 20, x / (cell / 2), y / (cell / 2)) > 0.74) id = PETROLEUM;
        else if (y > h * 0.84 && dig < 0.42 && fbm(seed + 30, x / (cell / 2), y / (cell / 2)) > 0.7) id = LAVA;
        else if (fbm(seed + 40, x / (cell / 4), y / (cell / 4)) > 0.76) id = METAL;
      }
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
