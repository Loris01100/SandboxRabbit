import { EMPTY, MATERIALS } from "./materials";
import type { Engine } from "./engine";

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
    const { cells, noise } = this.engine;
    const { buffer, palette } = this;
    for (let i = 0; i < cells.length; i++) {
      const id = cells[i];
      const base = palette[id];
      if (id === EMPTY) { buffer[i] = base; continue; }
      // Le bruit par cellule décale les 3 canaux d'un même delta : la teinte
      // reste identique, seule la luminosité varie.
      const d = (noise[i] * MATERIALS[id].noise) >> 7;
      const r = clamp((base & 0xff) + d);
      const g = clamp(((base >> 8) & 0xff) + d);
      const b = clamp(((base >> 16) & 0xff) + d);
      buffer[i] = 0xff000000 | (b << 16) | (g << 8) | r;
    }
    this.ctx.putImageData(this.image, 0, 0);
  }
}

function clamp(v: number): number {
  return v < 0 ? 0 : v > 255 ? 255 : v;
}
