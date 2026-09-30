import {
  EMBER, EMPTY, FIRE, GLASS, ICE, LAVA, MAGNET, MATERIALS, MOLTEN_GLASS, SPARK, SWITCH, THERMITE, URANIUM,
} from "./materials.ts";
import { type Engine } from "./engine.ts";

/**
 * Ce qu'il faut pour colorier un bac : la grille et son état, sans le moteur.
 * Le moteur l'est (le Worker, les tests), le miroir de la page aussi
 * (world.ts) — c'est ce qui laisse colorier aussi bien d'un côté que de
 * l'autre. `temp` : en °C, flottants dans le moteur, arrondis dans le miroir.
 * `press` : la pression de l'air, flottante dans le moteur, ramenée à ses
 * paliers (`AIR_LEVELS`) dans le miroir — la vue pression n'en lit pas plus.
 */
export interface Grid {
  width: number;
  height: number;
  ambient: number;
  cells: Uint8Array;
  life: Uint8Array;
  frozen: Uint8Array;
  noise: Int8Array;
  temp: ArrayLike<number>;
  press: ArrayLike<number>;
}

/**
 * Une bande de bac à reposer en (x, y) : les données brutes de ses cellules,
 * rangée par rangée, pas des pixels. C'est la carte graphique de la page qui
 * les colorie (screen.ts) ; la température y voyage arrondie au degré, de quoi
 * la lumière et la vue thermique. `noise`, fixe pour un moteur, ne voyage
 * qu'avec la première frame.
 */
export interface Patch {
  x: number;
  y: number;
  w: number;
  h: number;
  cells: Uint8Array;
  life: Uint8Array;
  frozen: Uint8Array;
  temp: Int16Array;
  /** Palier de pression (`airLevel()`), de quoi la vue pression. */
  press: Uint8Array;
  noise?: Int8Array;
}

/**
 * Le suivi des blocs changés, côté Worker. Il ne colorie rien : il découpe
 * dans le moteur les blocs que `engine.changed()` désigne, une bande par
 * rangée de blocs — du premier changé au dernier — et la page les repose
 * dans son miroir. Un bac au repos rend une liste vide ; la première frame
 * d'un moteur est entière, grain compris.
 *
 * Colorier ici coûtait 6 ms par tick en 1920×1080 chargé (npm run
 * directions) : c'est le shader de la page qui le fait maintenant.
 */
export class Tracker {
  private readonly engine: Engine;
  private readonly dirty: Uint8Array;
  private full = true;

  constructor(engine: Engine) {
    this.engine = engine;
    this.dirty = new Uint8Array(engine.cols * engine.rows);
  }

  take(): Patch[] {
    const { chunk, cols, rows, width: w, height: h, cells, life, frozen, temp, press, noise } = this.engine;
    const { dirty } = this;
    this.engine.changed(dirty);
    const full = this.full;
    if (full) { dirty.fill(1); this.full = false; }
    const patches: Patch[] = [];
    for (let cy = 0; cy < rows; cy++) {
      let first = -1, last = -1;
      for (let cx = 0; cx < cols; cx++) {
        if (!dirty[cy * cols + cx]) continue;
        if (first < 0) first = cx;
        last = cx;
      }
      if (first < 0) continue;
      const x = first * chunk, y0 = cy * chunk;
      const pw = Math.min(w, (last + 1) * chunk) - x, ph = Math.min(h, y0 + chunk) - y0;
      const p: Patch = {
        x, y: y0, w: pw, h: ph,
        cells: new Uint8Array(pw * ph), life: new Uint8Array(pw * ph),
        frozen: new Uint8Array(pw * ph), temp: new Int16Array(pw * ph), press: new Uint8Array(pw * ph),
      };
      if (full) p.noise = new Int8Array(pw * ph);
      for (let r = 0; r < ph; r++) {
        const from = (y0 + r) * w + x, to = r * pw;
        p.cells.set(cells.subarray(from, from + pw), to);
        p.life.set(life.subarray(from, from + pw), to);
        p.frozen.set(frozen.subarray(from, from + pw), to);
        p.noise?.set(noise.subarray(from, from + pw), to);
        for (let k = 0; k < pw; k++) p.temp[to + k] = Math.max(-32768, Math.min(32767, Math.round(temp[from + k])));
        for (let k = 0; k < pw; k++) p.press[to + k] = airLevel(press[from + k]);
      }
      patches.push(p);
    }
    return patches;
  }
}

/**
 * Couleur et grain de chaque matière, 256 × RGBA : rouge, vert, bleu, grain.
 * La table du shader (screen.ts) et celle de `Renderer` : une seule source.
 */
export function palette(): Uint8Array {
  const out = new Uint8Array(256 * 4);
  for (const key of Object.keys(MATERIALS)) {
    const m = MATERIALS[Number(key)];
    out.set([m.color[0], m.color[1], m.color[2], m.noise], m.id * 4);
  }
  return out;
}

/**
 * Paliers de pression par unité : la vue pression distingue 1/8 d'unité, et
 * sature à 255 paliers (≈ 32, le cœur d'un souffle). Une bande n'en porte
 * qu'un octet par cellule ; le miroir range `palier / AIR_LEVELS`, que
 * `airLevel()` rend tel quel.
 */
export const AIR_LEVELS = 8;

/** Le palier d'une pression : arrondi au plus proche comme `floor(p·8 + 0,5)` du shader, borné à 255. */
export function airLevel(p: number): number {
  return Math.min(255, Math.floor(p * AIR_LEVELS + 0.5));
}

/** Ce que montre le bac : la matière, la température (`h`) ou la pression de l'air (`b`). */
export type View = "matter" | "heat" | "air";

/** Les quatre matières dont `life` change l'aspect, dans l'ordre qu'attend le shader. */
export const GLOWING = [URANIUM, THERMITE, SWITCH, MAGNET] as const;

/** Écart à l'ambiante à partir duquel une cellule commence à éclairer, en °C. */
export const GLOW = 40;

/**
 * Ce que chaque matière fait à la lumière de l'éclairage global (screen.ts),
 * 256 × RGBA : ce qu'elle émet (rouge, vert, bleu), puis ce qu'elle arrête
 * (255 = opaque). Le verre laisse passer, l'eau atténue, la pierre fait
 * de l'ombre. Le feu, gaz, arrête un peu : sans ça, une flamme n'émettrait
 * rien. La chaleur ajoute son rougeoiement dans le shader, au-delà de 450 °C.
 *
 * ponytail: seul le shader éclaire — `Renderer` (secours 2D, tests) n'en a
 * pas de copie, l'effet ne tient qu'en WebGL2. À recopier le jour où le
 * secours doit ressembler.
 */
export function lighting(): Uint8Array {
  const out = new Uint8Array(256 * 4);
  const opacity = { empty: 0, gas: 20, liquid: 70, powder: 255, static: 255 };
  for (const key of Object.keys(MATERIALS)) {
    const m = MATERIALS[Number(key)];
    out[m.id * 4 + 3] = opacity[m.kind];
  }
  const set = (id: number, r: number, g: number, b: number, a: number) => out.set([r, g, b, a], id * 4);
  set(FIRE, 255, 150, 50, 110);
  set(LAVA, 255, 110, 30, 255);
  set(EMBER, 230, 90, 30, 255);
  set(MOLTEN_GLASS, 255, 160, 70, 255);
  set(SPARK, 255, 240, 140, 255);
  set(URANIUM, 70, 200, 70, 255);
  set(GLASS, 0, 0, 0, 25);
  set(ICE, 0, 0, 0, 90);
  return out;
}

/** Une teinte d'heure : rouge, vert, bleu, multipliés à la couleur des matières qui n'émettent pas. */
export type Tint = readonly [number, number, number];

/**
 * Les heures de la journée : la lumière du ciel sur le bac. Le feu, la lave,
 * les braises gardent leur couleur (voir `lighting()`) : la nuit, ce sont eux
 * qui éclairent — avec l'éclairage global, la pierre autour sort de l'ombre.
 */
export const HOURS: Record<string, Tint> = {
  matin: [1, 0.9, 0.8],
  "apres-midi": [1, 1, 1],
  soir: [0.95, 0.6, 0.45],
  nuit: [0.25, 0.3, 0.5],
};

/** Durée d'une journée entière en mode « Cycle », en secondes. */
export const DAY = 240;

/** La teinte du cycle au temps `seconds` : matin → après-midi → soir → nuit → matin, en fondu. */
export function hourTint(seconds: number): Tint {
  const tints = Object.values(HOURS);
  const phase = ((seconds / DAY) % 1 + 1) % 1 * tints.length;
  const from = tints[Math.floor(phase)], to = tints[(Math.floor(phase) + 1) % tints.length];
  const u = phase % 1;
  return [0, 1, 2].map((k) => from[k] + (to[k] - from[k]) * u) as unknown as Tint;
}

/** L'heure affichée pour chaque moment de `HOURS`, mêmes clés, même ordre. */
export const CLOCK: Record<string, number> = { matin: 6, "apres-midi": 15, soir: 20, nuit: 2 };

/**
 * L'heure du cycle au temps `seconds`, en heures dans [0, 24[ : elle suit
 * `hourTint()`, d'un moment de `CLOCK` au suivant, à travers minuit.
 */
export function clockAt(seconds: number): number {
  const hours = Object.values(CLOCK);
  const phase = ((seconds / DAY) % 1 + 1) % 1 * hours.length;
  const from = hours[Math.floor(phase)], to = hours[(Math.floor(phase) + 1) % hours.length];
  return (from + ((to - from + 24) % 24) * (phase % 1)) % 24;
}

/**
 * Rendu 1 cellule = 1 pixel dans un tableau de pixels, puis mise à l'échelle
 * par le CSS (`image-rendering: pixelated`). Aucun appel de dessin par cellule.
 *
 * C'est la **copie en JavaScript** du shader de screen.ts : le secours d'une
 * page sans WebGL2, et ce que lisent les tests et `npm run directions`, qui
 * n'ont pas de carte graphique. Les deux doivent colorier pareil — une règle
 * d'aspect changée ici l'est là-bas aussi.
 */
export class Renderer {
  /** RGBA, une cellule par pixel. */
  readonly pixels: Uint8ClampedArray;
  private readonly buffer: Uint32Array;
  /** Couleur de base pré-calculée par matériau, au format 0xAABBGGRR. */
  private readonly palette = new Uint32Array(256);
  /** Grain par matériau : une lecture de tableau typé par pixel, au lieu d'une propriété d'objet. */
  private readonly grain = new Uint8Array(256);
  /** 1 pour les quatre matières dont `life` change l'aspect. Voir `shade()`. */
  private readonly glows = new Uint8Array(256);
  /** 1 pour les matières qui émettent (`lighting()`) : l'heure ne les assombrit pas. */
  private readonly emits = new Uint8Array(256);
  /** La matière, la température (`shadeHeat`) ou la pression (`shadeAir`). */
  view: View = "matter";
  /** L'heure de la journée, voir `HOURS`. */
  tint: Tint = HOURS["apres-midi"];

  private readonly grid: Grid;

  // Champ déclaré à la main plutôt qu'en paramètre-propriété : Node exécute le
  // TypeScript en le dépouillant, et cette syntaxe-là est la seule qu'il refuse
  // (`ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`) — elle mettait ce module hors de
  // portée de `node test/…`.
  constructor(grid: Grid) {
    this.grid = grid;
    this.pixels = new Uint8ClampedArray(grid.width * grid.height * 4);
    this.buffer = new Uint32Array(this.pixels.buffer);
    const table = palette();
    for (let id = 0; id < 256; id++) {
      this.palette[id] = 0xff000000 | (table[id * 4 + 2] << 16) | (table[id * 4 + 1] << 8) | table[id * 4];
      this.grain[id] = table[id * 4 + 3];
    }
    for (const id of GLOWING) this.glows[id] = 1;
    const light = lighting();
    for (let id = 0; id < 256; id++) this.emits[id] = light[id * 4] + light[id * 4 + 1] + light[id * 4 + 2] > 0 ? 1 : 0;
  }

  /** Tout le bac. */
  draw(): void {
    this.paint(0, 0, this.grid.width, this.grid.height);
  }

  /** Le rectangle de (x0, y0) à (x1, y1) exclus. */
  paint(x0: number, y0: number, x1: number, y1: number): void {
    const w = this.grid.width;
    const warm = this.grid.ambient + GLOW;
    for (let y = y0; y < y1; y++) {
      if (this.view === "air") this.shadeAir(y * w + x0, y * w + x1);
      else if (this.view === "heat") this.shadeHeat(y * w + x0, y * w + x1);
      else this.shade(y * w + x0, y * w + x1, warm);
    }
  }

  /** Les cellules `from` à `to` (exclu) d'une rangée, en couleurs de matière. `warm` : seuil de lumière. */
  private shade(from: number, to: number, warm: number): void {
    const { cells, noise, frozen, life, width, temp } = this.grid;
    const { buffer, palette, grain, glows, emits } = this;
    const [tr, tg, tb] = this.tint;
    for (let i = from; i < to; i++) {
      const id = cells[i];
      const base = palette[id];
      // Lumière : `temp` est déjà diffusé par le moteur, donc l'air autour
      // d'une flamme est chaud — c'est un halo tout prêt, sans flou à calculer.
      const t = temp[i];
      const lit = t > warm ? Math.min(1, (t - warm) / 400) : 0;
      if (id === EMPTY) {
        const sky = dim(base, tr, tg, tb);
        buffer[i] = lit === 0 ? sky : light(sky, lit);
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
      const raw = 0xff000000 | (b << 16) | (g << 8) | r;
      const shade = emits[id] ? raw : dim(raw, tr, tg, tb);
      buffer[i] = lit === 0 ? shade : light(shade, lit);
    }
  }

  /** Bleu sous l'ambiante, puis corps noir : rouge → jaune → blanc jusqu'à 1200 °C. */
  private shadeHeat(from: number, to: number): void {
    // Le pivot suit le climat de la scène, pas la constante : à -40 °C tout
    // était bleu uni, et la vue thermique ne montrait plus rien.
    const { temp, ambient } = this.grid;
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

  /**
   * La pression de l'air, par palier (`airLevel`) : bleu profond, cyan, puis
   * blanc à 255 paliers. Sans pression, la matière assombrie aux 77/256, en
   * entiers comme le shader : on voit où l'onde se heurte aux murs et quelle
   * vitre elle presse. Tout en entiers, rampe comprise : en flottants, le
   * GPU arrondissait autrement 2 % des paliers.
   */
  private shadeAir(from: number, to: number): void {
    const { press, cells } = this.grid;
    const { buffer, palette } = this;
    for (let i = from; i < to; i++) {
      const l = airLevel(press[i]);
      if (l === 0) {
        const base = palette[cells[i]];
        const r = ((base & 0xff) * 77) >> 8, g = (((base >> 8) & 0xff) * 77) >> 8, b = (((base >> 16) & 0xff) * 77) >> 8;
        buffer[i] = 0xff000000 | (b << 16) | (g << 8) | r;
        continue;
      }
      const r = Math.max(0, Math.min(255, 3 * l - 510)), g = Math.max(0, Math.min(255, 3 * l - 255));
      const b = 60 + Math.min(195, Math.floor((39 * l) / 17)); // 195 × 3l / 255
      buffer[i] = 0xff000000 | (b << 16) | (g << 8) | r;
    }
  }
}

/** Multiplie chaque canal d'une couleur 0xAABBGGRR par sa part de la teinte ; tronqué, comme `floor()` du shader. */
function dim(color: number, r: number, g: number, b: number): number {
  return 0xff000000 | (((color >> 16) & 0xff) * b << 16) | (((color >> 8) & 0xff) * g << 8) | ((color & 0xff) * r);
}

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
