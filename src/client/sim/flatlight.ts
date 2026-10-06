/**
 * L'éclairage global du secours 2D, à part du reste du rendu : seule une page
 * sans WebGL2 s'en sert, et screen.ts ne le charge (`import()`) que là — ses
 * 3 Ko n'ont rien à faire dans la page de tous les autres, qui a un budget.
 * Pur, sans DOM : test/sim.ts le fait tourner sous Node.
 */
import { RED_HOT, lighting, type Grid } from "./render.ts";

/** Largeur de la grille de lumière du secours 2D, en texels au plus : un texel couvre `scale × scale` cellules. */
export const FLAT_LIGHT = 160;
/** Rayons lancés par texel dans le secours 2D, répartis sur le tour. */
const RAYS = 16;

/** Ce que la page envoie au fil de l'éclairage (flatlight-worker.ts) : le niveau 0, collecté. */
export interface Gathered { emit: Float32Array; alpha: Float32Array; width: number; height: number; scale: number }

/** Un niveau de la pyramide de lumière : émission prémultipliée (r, g, b) et opacité, moyennées. */
interface Level { width: number; height: number; emit: Float32Array; alpha: Float32Array }

/**
 * L'éclairage global du secours 2D (sans WebGL2). Il **ressemble** au shader
 * sans en être une copie : mêmes entrées — émission et opacité de
 * `lighting()`, plus le rougeoiement de la chaleur, moyennés par texel comme
 * `SCENE` —, même lumière reçue (la moyenne de ce qui arrive de toutes les
 * directions), même fin que `FLUENCE`. Ce qui change, c'est le chemin : pas
 * de cascades, mais `RAYS` rayons par texel dont le pas grandit avec la
 * distance (1 jusqu'à 8 texels, puis 2, 4, 8…) et qui lisent la pyramide au
 * niveau de leur pas, comme une cascade lointaine lit ses mipmaps : un mur
 * fin arrête encore un rayon qui marche à grands pas. Sur une grille de
 * `FLAT_LIGHT` texels de large quelle que soit la taille du bac, les texels
 * opaques sautés : ~4,5 ms par éclairage, de 320×180 à 1920×1080, d'où
 * l'espacement de `relight()` (screen.ts).
 *
 * Dans la page, le calcul tourne dans un fil à lui (flatlight-worker.ts) : la
 * page collecte (`collect()`, ~1 ms), le fil lance les rayons (`solve()`)
 * sans que rien ne l'attende — d'où une grille de 160 texels, où une ombre
 * fine se voit. Les deux chemins se ressemblent sans coïncider : `npm run
 * browser` ne compare pas l'éclairage.
 */
export class FlatLight {
  /** Cellules par côté de texel. */
  scale = 1;
  /** Taille de la grille de lumière, en texels. */
  width = 0;
  height = 0;
  /** La lumière reçue, trois flottants (r, g, b, de 0 à ~1) par texel : ce que le mélange ajoute. */
  light: Float32Array = new Float32Array(0);
  private levels: Level[] = [];
  private readonly table = lighting();
  /**
   * Quatre jeux de directions, chacun tourné d'un quart de pas d'angle
   * (cosinus puis sinus), alternés en damier 2 × 2 de texels : l'interpolation
   * bilinéaire du mélange en mêle alors 64 pour le prix de 16. Avec un seul
   * jeu, les « trous » entre rayons s'alignaient d'un texel à l'autre, et loin
   * d'une petite flamme la lumière se dessinait en étoile.
   */
  private readonly dirs = Array.from({ length: 4 }, (_, k) => Array.from({ length: RAYS }, (_, d) => {
    const a = ((d + (k + 0.5) / 4) * 2 * Math.PI) / RAYS;
    return [Math.cos(a), Math.sin(a)] as const;
  }));

  /** Recalcule toute la lumière de `grid`, ici même : les tests, et une page sans fil d'éclairage. */
  compute(grid: Grid): void {
    this.collect(grid);
    this.solve();
  }

  /**
   * La part de la page : collecter la grille de lumière (`SCENE`), et la
   * rendre à envoyer au fil de l'éclairage — des copies, que `postMessage`
   * peut transférer sans toucher aux tampons d'ici.
   */
  collect(grid: Grid): Gathered {
    const scale = Math.max(1, Math.ceil(grid.width / FLAT_LIGHT));
    const lw = Math.ceil(grid.width / scale), lh = Math.ceil(grid.height / scale);
    if (lw !== this.width || lh !== this.height || scale !== this.scale) this.allocate(lw, lh);
    this.scale = scale;
    this.gather(grid);
    const { emit, alpha } = this.levels[0];
    return { emit: emit.slice(), alpha: alpha.slice(), width: lw, height: lh, scale };
  }

  /** Le fil de l'éclairage reçoit une collecte (`collect()`) : il la pose au niveau 0. */
  load(g: Gathered): void {
    if (g.width !== this.width || g.height !== this.height || g.scale !== this.scale) this.allocate(g.width, g.height);
    this.scale = g.scale;
    this.levels[0].emit.set(g.emit);
    this.levels[0].alpha.set(g.alpha);
  }

  /** La part du fil de l'éclairage : pyramide, rayons, lissage, fin de `FLUENCE`. */
  solve(): void {
    for (let k = 1; k < this.levels.length; k++) this.reduce(this.levels[k - 1], this.levels[k]);
    this.march();
    this.smooth();
    this.finish();
  }

  /** La page reçoit la lumière calculée par le fil de l'éclairage ; ignorée si le bac a changé de taille entre-temps. */
  adopt(light: Float32Array, width: number, height: number, scale: number): void {
    if (width !== this.width || height !== this.height || scale !== this.scale) return;
    this.light = light;
  }

  private allocate(lw: number, lh: number): void {
    this.width = lw; this.height = lh;
    this.light = new Float32Array(lw * lh * 3);
    this.levels = [];
    for (let w = lw, h = lh; ; w = Math.ceil(w / 2), h = Math.ceil(h / 2)) {
      this.levels.push({ width: w, height: h, emit: new Float32Array(w * h * 3), alpha: new Float32Array(w * h) });
      if (w === 1 && h === 1) break;
    }
  }

  /**
   * `SCENE` : par texel, la moyenne de l'émission prémultipliée par l'opacité,
   * et de l'opacité. Au-delà de 4 × 4 cellules par texel, on n'en lit qu'une
   * sur `step` dans chaque sens — seize par texel : en 1920×1080, lire les
   * deux millions de cellules coûtait plus que tout le reste de l'éclairage.
   */
  private gather(grid: Grid): void {
    const { cells, temp, width: w, height: h } = grid;
    const { table, scale } = this;
    const { emit, alpha, width: lw } = this.levels[0];
    emit.fill(0);
    alpha.fill(0);
    const count = new Uint16Array(alpha.length);
    const step = Math.max(1, Math.trunc(scale / 4));
    for (let y = 0; y < h; y += step) {
      const row = Math.trunc(y / scale) * lw;
      for (let x = 0; x < w; x += step) {
        const i = y * w + x, id = cells[i], t = row + Math.trunc(x / scale);
        count[t]++;
        if (id === 0) continue;
        const a = table[id * 4 + 3] / 255;
        let r = table[id * 4] / 255, g = table[id * 4 + 1] / 255, b = table[id * 4 + 2] / 255;
        const hot = temp[i];
        if (hot > RED_HOT) {
          const k = Math.min(1, (hot - RED_HOT) / 700);
          r = Math.max(r, k); g = Math.max(g, 0.45 * k); b = Math.max(b, 0.1 * k);
        }
        alpha[t] += a;
        emit[t * 3] += r * a; emit[t * 3 + 1] += g * a; emit[t * 3 + 2] += b * a;
      }
    }
    for (let t = 0; t < alpha.length; t++) {
      const c = count[t] || 1;
      alpha[t] /= c;
      emit[t * 3] /= c; emit[t * 3 + 1] /= c; emit[t * 3 + 2] /= c;
    }
  }

  /** Un niveau de la pyramide : la moyenne de 2 × 2 texels du niveau d'en dessous (les bords, de ce qui existe). */
  private reduce(from: Level, to: Level): void {
    for (let y = 0; y < to.height; y++) {
      for (let x = 0; x < to.width; x++) {
        let a = 0, r = 0, g = 0, b = 0, n = 0;
        for (let dy = 0; dy < 2; dy++) {
          for (let dx = 0; dx < 2; dx++) {
            const sx = 2 * x + dx, sy = 2 * y + dy;
            if (sx >= from.width || sy >= from.height) continue;
            const s = sy * from.width + sx;
            a += from.alpha[s]; r += from.emit[s * 3]; g += from.emit[s * 3 + 1]; b += from.emit[s * 3 + 2]; n++;
          }
        }
        const t = y * to.width + x;
        to.alpha[t] = a / n; to.emit[t * 3] = r / n; to.emit[t * 3 + 1] = g / n; to.emit[t * 3 + 2] = b / n;
      }
    }
  }

  /**
   * Les rayons de chaque texel, comme un rayon de `CASCADE` : à chaque pas, ce
   * qu'il traverse laisse passer `(1 − opacité)^pas`, et la part arrêtée
   * renvoie sa couleur (émission ÷ opacité) vers le texel, atténuée par ce que
   * le rayon a déjà traversé. Il s'arrête au bord ou quand presque rien ne
   * passe plus.
   */
  private march(): void {
    const { width: lw, height: lh, light, levels, dirs } = this;
    const opaque = levels[0].alpha;
    // Le calendrier des pas ne dépend pas de la direction : calculé une fois.
    // Pas de 1 jusqu'à 8 texels, puis le quart de la distance, en puissance de deux.
    const top = levels.length - 1, far = Math.hypot(lw, lh);
    const mid: number[] = [], lods: number[] = [];
    for (let d = 0.5; d < far;) {
      const lod = d < 8 ? 0 : Math.min(top, Math.floor(Math.log2(d / 4)));
      mid.push(d + (1 << lod) * 0.5);
      lods.push(lod);
      d += 1 << lod;
    }
    for (let y = 0; y < lh; y++) {
      for (let x = 0; x < lw; x++) {
        const t3 = (y * lw + x) * 3;
        // Opaque : `finish()` remplace sa lumière (celle du voisin, ou rien s'il brille).
        if (opaque[y * lw + x] >= 0.5) { light[t3] = light[t3 + 1] = light[t3 + 2] = 0; continue; }
        let sr = 0, sg = 0, sb = 0;
        const set = dirs[(x & 1) | ((y & 1) << 1)];
        for (let d = 0; d < RAYS; d++) {
          const dx = set[d][0], dy = set[d][1];
          let through = 1;
          for (let k = 0; k < mid.length; k++) {
            const px = x + 0.5 + dx * mid[k], py = y + 0.5 + dy * mid[k];
            if (px < 0 || py < 0 || px >= lw || py >= lh) break;
            const lod = lods[k], level = levels[lod], w = level.width, h = level.height;
            // Lu en bilinéaire, comme le GPU lit ses mipmaps : au plus proche,
            // chaque texel grossier se voyait en pavé dans la lumière.
            const u = px / (1 << lod) - 0.5, v = py / (1 << lod) - 0.5;
            let x0 = Math.floor(u), y0 = Math.floor(v);
            const fx = u - x0, fy = v - y0;
            let x1 = x0 + 1, y1 = y0 + 1;
            if (x0 < 0) x0 = 0; if (x1 >= w) x1 = w - 1; if (x0 >= w) x0 = w - 1;
            if (y0 < 0) y0 = 0; if (y1 >= h) y1 = h - 1; if (y0 >= h) y0 = h - 1;
            const p = y0 * w + x0, q = y0 * w + x1, r = y1 * w + x0, z = y1 * w + x1;
            const wp = (1 - fx) * (1 - fy), wq = fx * (1 - fy), wr = (1 - fx) * fy, wz = fx * fy;
            const al = level.alpha, a = al[p] * wp + al[q] * wq + al[r] * wr + al[z] * wz;
            if (a <= 0) continue;
            let pass = 1 - a;
            for (let j = 0; j < lod; j++) pass *= pass; // (1 − a)^pas, pas = 2^lod
            const keep = (through * (1 - pass)) / a, e = level.emit;
            sr += (e[p * 3] * wp + e[q * 3] * wq + e[r * 3] * wr + e[z * 3] * wz) * keep;
            sg += (e[p * 3 + 1] * wp + e[q * 3 + 1] * wq + e[r * 3 + 1] * wr + e[z * 3 + 1] * wz) * keep;
            sb += (e[p * 3 + 2] * wp + e[q * 3 + 2] * wq + e[r * 3 + 2] * wr + e[z * 3 + 2] * wz) * keep;
            through *= pass;
            if (through < 0.01) break;
          }
        }
        light[t3] = sr / RAYS; light[t3 + 1] = sg / RAYS; light[t3 + 2] = sb / RAYS;
      }
    }
  }

  /**
   * Un flou 3 × 3 (1-2-1) sur la lumière, entre texels non opaques seulement :
   * les jeux de rayons alternés (`dirs`) laissent un grain d'un texel à
   * l'autre, que l'interpolation seule ne gommait pas. Un opaque n'y entre ni
   * n'en sort — la lumière ne passe pas un mur par le flou.
   */
  private smooth(): void {
    const { width: lw, height: lh, light } = this;
    const alpha = this.levels[0].alpha;
    const src = light.slice();
    for (let y = 0; y < lh; y++) {
      for (let x = 0; x < lw; x++) {
        const t = y * lw + x;
        if (alpha[t] >= 0.5) continue;
        let r = 0, g = 0, b = 0, n = 0;
        for (let dy = -1; dy <= 1; dy++) {
          const yy = y + dy;
          if (yy < 0 || yy >= lh) continue;
          for (let dx = -1; dx <= 1; dx++) {
            const xx = x + dx;
            if (xx < 0 || xx >= lw) continue;
            const u = yy * lw + xx;
            if (alpha[u] >= 0.5) continue;
            const wgt = (dx === 0 ? 2 : 1) * (dy === 0 ? 2 : 1);
            r += src[u * 3] * wgt; g += src[u * 3 + 1] * wgt; b += src[u * 3 + 2] * wgt; n += wgt;
          }
        }
        light[t * 3] = r / n; light[t * 3 + 1] = g / n; light[t * 3 + 2] = b / n;
      }
    }
  }

  /**
   * La fin de `FLUENCE` : un texel opaque, dont les rayons partent de
   * l'intérieur du mur, prend la lumière de son voisin non opaque le plus
   * éclairé — sinon la pierre au bord de la lave restait noire ; un texel
   * opaque **qui brille** ne reçoit rien, sa lumière est la sienne (le bord
   * d'une mer de lave virait au jaune saturé).
   */
  private finish(): void {
    const { width: lw, height: lh, light } = this;
    const { alpha, emit } = this.levels[0];
    const out = light.slice();
    for (let y = 0; y < lh; y++) {
      for (let x = 0; x < lw; x++) {
        const t = y * lw + x;
        if (alpha[t] < 0.5) continue;
        let r = 0, g = 0, b = 0;
        if (emit[t * 3] + emit[t * 3 + 1] + emit[t * 3 + 2] === 0) {
          let best = -1;
          for (let k = 0; k < 4; k++) {
            const nx = x + (k === 0 ? 1 : k === 1 ? -1 : 0), ny = y + (k === 2 ? 1 : k === 3 ? -1 : 0);
            if (nx < 0 || ny < 0 || nx >= lw || ny >= lh) continue;
            const u = ny * lw + nx;
            if (alpha[u] >= 0.5) continue;
            const sum = light[u * 3] + light[u * 3 + 1] + light[u * 3 + 2];
            if (sum > best) { best = sum; r = light[u * 3]; g = light[u * 3 + 1]; b = light[u * 3 + 2]; }
          }
        }
        out[t * 3] = r; out[t * 3 + 1] = g; out[t * 3 + 2] = b;
      }
    }
    light.set(out);
  }

  /** Pour chaque colonne de cellules : texels de gauche et de droite, et poids du droit (bilinéaire). */
  private columns = { width: -1, left: new Int32Array(0), right: new Int32Array(0), frac: new Float32Array(0) };
  /** La lumière d'une rangée, déjà interpolée en vertical : trois flottants par texel. */
  private band = new Float32Array(0);

  /**
   * Prépare la rangée de cellules `y` d'un bac de `width` de large : la
   * lumière interpolée entre les deux rangées de texels qui l'encadrent. Le
   * mélange n'a plus qu'à interpoler en horizontal (`left`, `right`, `frac`)
   * — en bilinéaire complet par cellule, l'éclairage triplait le coloriage
   * d'un 1920×1080.
   */
  row(y: number, width: number): { band: Float32Array; left: Int32Array; right: Int32Array; frac: Float32Array } {
    const { scale, width: lw, height: lh, light } = this;
    const c = this.columns;
    if (c.width !== width) {
      c.width = width;
      c.left = new Int32Array(width); c.right = new Int32Array(width); c.frac = new Float32Array(width);
      for (let x = 0; x < width; x++) {
        const u = (x + 0.5) / scale - 0.5, x0 = Math.floor(u);
        c.left[x] = Math.min(lw - 1, Math.max(0, x0)) * 3;
        c.right[x] = Math.min(lw - 1, Math.max(0, x0 + 1)) * 3;
        c.frac[x] = u - x0;
      }
    }
    if (this.band.length !== lw * 3) this.band = new Float32Array(lw * 3);
    const v = (y + 0.5) / scale - 0.5, y0 = Math.floor(v), fy = v - y0;
    const a = Math.min(lh - 1, Math.max(0, y0)) * lw * 3, b = Math.min(lh - 1, Math.max(0, y0 + 1)) * lw * 3;
    const band = this.band;
    for (let k = 0; k < lw * 3; k++) band[k] = light[a + k] + (light[b + k] - light[a + k]) * fy;
    return { band, left: c.left, right: c.right, frac: c.frac };
  }
}
