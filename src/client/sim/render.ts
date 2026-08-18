import { EMPTY, MATERIALS, SWITCH } from "./materials";
import { AMBIENT, type Engine } from "./engine";

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
  /** Affiche `temp` au lieu de la matière. */
  heatmap = false;

  constructor(canvas: HTMLCanvasElement, private readonly engine: Engine) {
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
    }
  }

  draw(): void {
    if (this.heatmap) { this.drawHeat(); return; }
    const { cells, noise, frozen, life, width } = this.engine;
    const { buffer, palette } = this;
    for (let i = 0; i < cells.length; i++) {
      const id = cells[i];
      const base = palette[id];
      if (id === EMPTY) { buffer[i] = base; continue; }
      // Le bruit par cellule décale les 3 canaux d'un même delta : la teinte
      // reste identique, seule la luminosité varie.
      // Une cellule figée est tramée en damier, pour la distinguer au premier coup d'œil.
      // Un interrupteur fermé s'éclaire : c'est le seul signe visible de son état.
      const d = frozen[i]
        ? ((i + ((i / width) | 0)) & 1 ? 45 : -45)
        : id === SWITCH && life[i] === 1
          ? 55
          : (noise[i] * MATERIALS[id].noise) >> 7;
      const r = clamp((base & 0xff) + d);
      const g = clamp(((base >> 8) & 0xff) + d);
      const b = clamp(((base >> 16) & 0xff) + d);
      buffer[i] = 0xff000000 | (b << 16) | (g << 8) | r;
    }
    this.ctx.putImageData(this.image, 0, 0);
  }

  /** Bleu sous l'ambiante, puis corps noir : rouge → jaune → blanc jusqu'à 1200 °C. */
  private drawHeat(): void {
    const { temp } = this.engine;
    const { buffer } = this;
    for (let i = 0; i < temp.length; i++) {
      const t = temp[i];
      let r: number, g: number, b: number;
      if (t < AMBIENT) {
        const cold = clamp01((AMBIENT - t) / 60);
        r = 20 * (1 - cold); g = 40 + 80 * cold; b = 60 + 195 * cold;
      } else {
        const u = clamp01((t - AMBIENT) / 1180);
        r = 30 + 225 * clamp01(u * 3);
        g = 255 * clamp01(u * 3 - 1);
        b = 255 * clamp01(u * 3 - 2);
      }
      buffer[i] = 0xff000000 | (b << 16) | (g << 8) | r;
    }
    this.ctx.putImageData(this.image, 0, 0);
  }
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
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d", { alpha: false });
  if (!ctx) return canvas;
  const image = ctx.createImageData(width, height);
  const buffer = new Uint32Array(image.data.buffer);
  for (let i = 0; i < cells.length; i++) {
    // Un monde sauvegardé peut contenir un id disparu depuis : on retombe sur le vide.
    const [r, g, b] = (MATERIALS[cells[i]] ?? MATERIALS[EMPTY]).color;
    buffer[i] = 0xff000000 | (b << 16) | (g << 8) | r;
  }
  ctx.putImageData(image, 0, 0);
  return canvas;
}
