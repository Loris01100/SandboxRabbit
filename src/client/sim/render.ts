import { EMPTY, MAGNET, MATERIALS, SWITCH, THERMITE, URANIUM } from "./materials.ts";
import { type Engine } from "./engine.ts";

/**
 * Rendu 1 cellule = 1 pixel dans un ImageData, puis mise à l'échelle par le CSS
 * (`image-rendering: pixelated`). C'est de loin le plus rapide : un seul
 * `putImageData` par frame, aucun appel de dessin par cellule.
 */
export class Renderer {
  private readonly ctx: CanvasRenderingContext2D;
  private readonly image: ImageData;
  private readonly buffer: Uint32Array;
  /** Couleur de base pré-calculée par matériau, au format 0xAABBGGRR. */
  private readonly palette = new Uint32Array(256);
  /** Grain par matériau, sorti du registre comme la couleur : une lecture de
   *  tableau typé par pixel et par frame, au lieu d'une propriété d'objet. */
  private readonly grain = new Uint8Array(256);
  /** 1 pour les quatre matières dont `life` change l'aspect. Voir `draw()`. */
  private readonly glows = new Uint8Array(256);
  /** Affiche `temp` au lieu de la matière. */
  heatmap = false;

  private readonly engine: Engine;

  // Champ déclaré à la main plutôt qu'en paramètre-propriété : Node exécute le
  // TypeScript en le dépouillant, et cette syntaxe-là est la seule qu'il refuse
  // (`ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`) — elle mettait ce module hors de
  // portée de `node test/…`.
  constructor(canvas: HTMLCanvasElement, engine: Engine) {
    this.engine = engine;
    canvas.width = engine.width;
    canvas.height = engine.height;
    const ctx = canvas.getContext("2d", { alpha: false });
    if (!ctx) throw new Error("Canvas 2D indisponible");
    this.ctx = ctx;
    this.image = ctx.createImageData(engine.width, engine.height);
    this.buffer = new Uint32Array(this.image.data.buffer);
    for (const key of Object.keys(MATERIALS)) {
      const m = MATERIALS[Number(key)];
      const [r, g, b] = m.color;
      this.palette[m.id] = 0xff000000 | (b << 16) | (g << 8) | r;
      this.grain[m.id] = m.noise;
    }
    for (const id of [SWITCH, MAGNET, THERMITE, URANIUM]) this.glows[id] = 1;
  }

  draw(): void {
    if (this.heatmap) { this.drawHeat(); return; }
    const { cells, noise, frozen, life, width, temp, ambient } = this.engine;
    const { buffer, palette, grain, glows } = this;
    // Le seuil de lumière est le même pour tout le bac : il n'a rien à faire
    // dans une boucle de 230 000 tours.
    const warm = ambient + GLOW;
    for (let i = 0; i < cells.length; i++) {
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
    this.ctx.putImageData(this.image, 0, 0);
  }

  /** Bleu sous l'ambiante, puis corps noir : rouge → jaune → blanc jusqu'à 1200 °C. */
  private drawHeat(): void {
    // Le pivot suit le climat de la scène, pas la constante : à -40 °C tout
    // était bleu uni, et la vue thermique ne montrait plus rien.
    const { temp, ambient } = this.engine;
    const { buffer } = this;
    for (let i = 0; i < temp.length; i++) {
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
    this.ctx.putImageData(this.image, 0, 0);
  }
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
