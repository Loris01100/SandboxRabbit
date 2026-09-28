import { EMPTY, MAGNET, MATERIALS, SWITCH, THERMITE, URANIUM } from "./materials.ts";
import { type Engine } from "./engine.ts";

/**
 * Rendu 1 cellule = 1 pixel dans un tableau de pixels, puis mise à l'échelle
 * par le CSS (`image-rendering: pixelated`). C'est de loin le plus rapide :
 * aucun appel de dessin par cellule.
 *
 * Le renderer ne connaît **pas** de canvas : il remplit `pixels`, et c'est le
 * fil principal qui en fait un `putImageData` (world.ts). C'est ce qui permet
 * de le faire tourner dans un Worker, où il n'y a pas de canvas — et ce qui le
 * rend vérifiable sous Node, qui n'en a pas non plus.
 *
 * Il ne redessine que les blocs de veille que le moteur dit changés
 * (`engine.changed()`), et n'envoie qu'eux : un bac au repos en 1920×1080 ne
 * coûte plus 8 Mo de pixels par frame, mais rien.
 */
export class Renderer {
  /** RGBA, une cellule par pixel : l'image entière, tenue à jour bloc par bloc. */
  readonly pixels: Uint8ClampedArray;
  private readonly buffer: Uint32Array;
  /** Couleur de base pré-calculée par matériau, au format 0xAABBGGRR. */
  private readonly palette = new Uint32Array(256);
  /** Grain par matériau, sorti du registre comme la couleur : une lecture de
   *  tableau typé par pixel et par frame, au lieu d'une propriété d'objet. */
  private readonly grain = new Uint8Array(256);
  /** 1 pour les quatre matières dont `life` change l'aspect. Voir `draw()`. */
  private readonly glows = new Uint8Array(256);
  /** Blocs à redessiner à ce `draw()`. */
  private readonly dirty: Uint8Array;
  /** Tout redessiner au prochain `draw()` : premier dessin, vue basculée. */
  private full = true;
  private heat = false;

  private readonly engine: Engine;

  // Champ déclaré à la main plutôt qu'en paramètre-propriété : Node exécute le
  // TypeScript en le dépouillant, et cette syntaxe-là est la seule qu'il refuse
  // (`ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`) — elle mettait ce module hors de
  // portée de `node test/…`.
  constructor(engine: Engine) {
    this.engine = engine;
    this.pixels = new Uint8ClampedArray(engine.width * engine.height * 4);
    this.buffer = new Uint32Array(this.pixels.buffer);
    for (const key of Object.keys(MATERIALS)) {
      const m = MATERIALS[Number(key)];
      const [r, g, b] = m.color;
      this.palette[m.id] = 0xff000000 | (b << 16) | (g << 8) | r;
      this.grain[m.id] = m.noise;
    }
    for (const id of [SWITCH, MAGNET, THERMITE, URANIUM]) this.glows[id] = 1;
    this.dirty = new Uint8Array(engine.cols * engine.rows);
  }

  /** Affiche `temp` au lieu de la matière. La basculer redessine tout le bac. */
  get heatmap(): boolean {
    return this.heat;
  }

  set heatmap(on: boolean) {
    if (on === this.heat) return;
    this.heat = on;
    this.full = true;
  }

  /**
   * Redessine les blocs changés et rend ce qu'il faut reposer en face : une
   * bande par rangée de blocs, du premier bloc changé au dernier, avec ses
   * pixels copiés dans un tampon à elle — c'est ce tampon qui part vers la
   * page, transféré plutôt que copié. Un bac au repos rend une liste vide.
   */
  draw(): Patch[] {
    const { chunk, cols, rows, width: w, height: h, ambient } = this.engine;
    const { dirty, pixels } = this;
    this.engine.changed(dirty);
    if (this.full) { dirty.fill(1); this.full = false; }
    const warm = ambient + GLOW;
    const patches: Patch[] = [];
    for (let cy = 0; cy < rows; cy++) {
      const y0 = cy * chunk, y1 = Math.min(h, y0 + chunk);
      let first = -1, last = -1;
      for (let cx = 0; cx < cols; cx++) {
        if (!dirty[cy * cols + cx]) continue;
        if (first < 0) first = cx;
        last = cx;
        const x0 = cx * chunk, x1 = Math.min(w, x0 + chunk);
        for (let y = y0; y < y1; y++) {
          if (this.heat) this.shadeHeat(y * w + x0, y * w + x1);
          else this.shade(y * w + x0, y * w + x1, warm);
        }
      }
      if (first < 0) continue;
      const x = first * chunk, pw = Math.min(w, (last + 1) * chunk) - x, ph = y1 - y0;
      const strip = new Uint8ClampedArray(pw * ph * 4);
      for (let y = y0; y < y1; y++) strip.set(pixels.subarray((y * w + x) * 4, (y * w + x + pw) * 4), (y - y0) * pw * 4);
      patches.push({ x, y: y0, w: pw, h: ph, pixels: strip });
    }
    return patches;
  }

  /** Les cellules `from` à `to` (exclu) d'une rangée, en couleurs de matière. `warm` : seuil de lumière. */
  private shade(from: number, to: number, warm: number): void {
    const { cells, noise, frozen, life, width, temp } = this.engine;
    const { buffer, palette, grain, glows } = this;
    for (let i = from; i < to; i++) {
      const id = cells[i];
      const base = palette[id];
      // Lumière : `temp` est déjà diffusé par le moteur, donc l'air autour
      // d'une flamme est chaud — c'est un halo tout prêt, sans flou à calculer.
      const t = temp[i];
      const lit = t > warm ? Math.min(1, (t - warm) / 400) : 0;
      if (id === EMPTY) {
        buffer[i] = lit === 0 ? base : light(base, lit);
        continue;
      }
      // Quatre matières seulement s'éclairent selon leur `life` — l'interrupteur
      // fermé et l'aimant inversé (qui n'ont pas de couleur propre pour ça), la
      // thermite allumée, l'uranium qui s'emballe et pâlit avant de sauter. Une
      // table dit lesquelles : ailleurs, `life` n'est même pas lu.
      const glow = glows[id] === 0 ? 0
        : id === URANIUM ? life[i] >> 1
        : id === THERMITE ? (life[i] > 0 ? 110 : 0)
        : life[i] === 1 ? 55
        : 0;
      // Le bruit par cellule décale les 3 canaux d'un même delta : la teinte
      // reste identique, seule la luminosité varie. Une cellule figée est
      // tramée en damier, pour la distinguer au premier coup d'œil.
      const d = frozen[i]
        ? ((i + ((i / width) | 0)) & 1 ? 45 : -45)
        : glow || (noise[i] * grain[id]) >> 7;
      const r = clamp((base & 0xff) + d);
      const g = clamp(((base >> 8) & 0xff) + d);
      const b = clamp(((base >> 16) & 0xff) + d);
      const shade = 0xff000000 | (b << 16) | (g << 8) | r;
      buffer[i] = lit === 0 ? shade : light(shade, lit);
    }
  }

  /** Bleu sous l'ambiante, puis corps noir : rouge → jaune → blanc jusqu'à 1200 °C. */
  private shadeHeat(from: number, to: number): void {
    // Le pivot suit le climat de la scène, pas la constante : à -40 °C tout
    // était bleu uni, et la vue thermique ne montrait plus rien.
    const { temp, ambient } = this.engine;
    const { buffer } = this;
    for (let i = from; i < to; i++) {
      const t = temp[i];
      let r: number, g: number, b: number;
      if (t < ambient) {
        const cold = clamp01((ambient - t) / 60);
        r = 20 * (1 - cold); g = 40 + 80 * cold; b = 60 + 195 * cold;
      } else {
        const u = clamp01((t - ambient) / 1180);
        r = 30 + 225 * clamp01(u * 3);
        g = 255 * clamp01(u * 3 - 1);
        b = 255 * clamp01(u * 3 - 2);
      }
      buffer[i] = 0xff000000 | (b << 16) | (g << 8) | r;
    }
  }
}

/** Un rectangle de l'image à reposer en (x, y), ses pixels RGBA rangée par rangée. */
export interface Patch {
  x: number;
  y: number;
  w: number;
  h: number;
  pixels: Uint8ClampedArray;
}

/** Écart à l'ambiante à partir duquel une cellule commence à éclairer, en °C. */
const GLOW = 40;

/** Réchauffe une couleur 0xAABBGGRR vers l'orange d'une flamme. */
function light(color: number, amount: number): number {
  const r = clamp((color & 0xff) + 170 * amount);
  const g = clamp(((color >> 8) & 0xff) + 95 * amount);
  const b = clamp(((color >> 16) & 0xff) + 25 * amount);
  return 0xff000000 | (b << 16) | (g << 8) | r;
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

function clamp(v: number): number {
  return v < 0 ? 0 : v > 255 ? 255 : v;
}

/**
 * Vignette d'un monde décodé : mêmes couleurs, sans le bruit ni l'état (`life`,
 * `frozen`) qui ne sont pas sauvegardés. Le canvas est rendu à la taille de la
 * grille et mis à l'échelle par le CSS, comme le bac lui-même.
 */
export function thumbnail(cells: Uint8Array, width: number, height: number): HTMLCanvasElement {
  // Une carte de galerie fait 170 px de large. Rendre un monde 640×360 pixel à
  // pixel, c'est cinquante canvas de 230 400 pixels que le navigateur garde en
  // mémoire pour les montrer deux fois plus petits : on n'échantillonne qu'une
  // cellule sur `pas`. Au-dessous de 320 de large, rien ne change.
  const pas = Math.max(1, Math.ceil(width / 320));
  const w = Math.ceil(width / pas);
  const h = Math.ceil(height / pas);
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d", { alpha: false });
  if (!ctx) return canvas;
  const image = ctx.createImageData(w, h);
  const buffer = new Uint32Array(image.data.buffer);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      // Un monde sauvegardé peut contenir un id disparu depuis : on retombe sur le vide.
      const [r, g, b] = (MATERIALS[cells[y * pas * width + x * pas]] ?? MATERIALS[EMPTY]).color;
      buffer[y * w + x] = 0xff000000 | (b << 16) | (g << 8) | r;
    }
  }
  ctx.putImageData(image, 0, 0);
  return canvas;
}
