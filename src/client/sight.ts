/**
 * Ce que voit le héros, à la première personne.
 *
 * Il vit dans un plan : son œil ne reçoit qu'une **ligne** d'image, comme
 * dans Flatland. Des rayons partent en éventail de sa tête, de haut en bas
 * devant lui, et s'arrêtent sur la première cellule pleine ; chaque rayon
 * donne un pixel, d'autant plus sombre que la cellule est loin. La page
 * étire cette colonne d'un pixel de large sur tout l'encadré.
 *
 * Pur : la grille est passée en argument (le miroir de world.ts, ou celle
 * d'un test), rien ici ne touche au DOM.
 */
import { EMPTY, HERO, HERO_LEGS, STONE } from "./sim/materials.ts";
import { palette } from "./sim/render.ts";

/** Ouverture de l'éventail, en radians : 120°, de biais vers le ciel jusqu'à ses pieds. */
const FOV = (2 * Math.PI) / 3;
/** Portée du regard, en cellules : au-delà, c'est le noir du vide. */
export const RANGE = 120;
/** Pas de marche le long d'un rayon, en cellules : assez fin pour ne pas sauter le coin d'un mur. */
const STEP = 0.25;
const COLORS = palette();

/**
 * Remplit `out` (RGBA, un pixel par rayon, le haut du regard en premier) avec
 * ce que voit un héros dont le cœur est en (x, y), tourné vers `face` (1 à
 * droite, -1 à gauche). Hors de la grille, c'est un mur de pierre, comme pour
 * le moteur. Son propre corps ne lui bouche pas la vue.
 */
export function look(cells: Uint8Array, width: number, height: number, x: number, y: number, face: number, out: Uint8ClampedArray): void {
  const rays = out.length >> 2;
  const ex = x + 0.5, ey = y - 1.5;
  for (let k = 0; k < rays; k++) {
    const a = ((k + 0.5) / rays - 0.5) * FOV;
    const dx = Math.cos(a) * face, dy = Math.sin(a);
    let id = EMPTY, d = 0;
    for (d = STEP; d < RANGE; d += STEP) {
      const cx = Math.floor(ex + dx * d), cy = Math.floor(ey + dy * d);
      if (cx < 0 || cx >= width || cy < 0 || cy >= height) { id = STONE; break; }
      const n = cells[cy * width + cx];
      if (n === EMPTY || (d < 3 && n >= HERO && n <= HERO_LEGS)) continue;
      id = n;
      break;
    }
    const shade = id === EMPTY ? 1 : 1 - (0.8 * d) / RANGE;
    const o = k * 4;
    out[o] = COLORS[id * 4] * shade;
    out[o + 1] = COLORS[id * 4 + 1] * shade;
    out[o + 2] = COLORS[id * 4 + 2] * shade;
    out[o + 3] = 255;
  }
}
