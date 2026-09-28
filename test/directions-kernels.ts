/**
 * Les deux noyaux de `npm run directions` : le mouvement (du sable qui tombe,
 * la logique d'`updatePowder`) et la chaleur (la diffusion à cinq points de
 * `thermal()`). Pas le moteur : sa charge, réduite à ce qui se compare d'une
 * technique à l'autre — un cœur, plusieurs cœurs, la carte graphique.
 *
 * Partagés entre test/directions.ts et test/directions-worker.ts : les deux
 * fils font exactement le même travail, seul le découpage change.
 */

/** Côté d'un bloc du damier, en cellules. */
export const BLOCK = 64;

export const EMPTY = 0;
export const SAND = 1;
export const STONE = 2;

/**
 * Tirage d'un bloc à un tick donné : un hachage de (bloc, tick), pas une suite
 * partagée. C'est ce qui rend le multi-cœur déterministe — le résultat ne
 * dépend plus de l'ordre dans lequel les cœurs finissent.
 */
export function blockSeed(bx: number, by: number, tick: number): number {
  let h = Math.imul(bx, 0x27d4eb2d) ^ Math.imul(by, 0x165667b1) ^ Math.imul(tick, 0x9e3779b1);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  return (h ^ (h >>> 13)) >>> 0 || 1;
}

/**
 * Fait tomber le sable du bloc (bx, by) : droit, sinon en diagonale d'un côté
 * tiré au sort. Un grain peut sortir du bloc d'une cellule : c'est pourquoi le
 * damier ne traite jamais deux blocs voisins en même temps.
 */
export function sandBlock(cells: Uint8Array, clock: Uint8Array, w: number, h: number, bx: number, by: number, tick: number): void {
  const x0 = bx * BLOCK, y0 = by * BLOCK;
  const x1 = Math.min(w, x0 + BLOCK), y1 = Math.min(h, y0 + BLOCK);
  const parity = tick & 1;
  let s = blockSeed(bx, by, tick);
  for (let y = y1 - 1; y >= y0; y--) {
    if (y === h - 1) continue;
    for (let k = x0; k < x1; k++) {
      const x = parity ? k : x1 - 1 - (k - x0);
      const i = y * w + x;
      if (cells[i] !== SAND || clock[i] === parity) continue;
      clock[i] = parity;
      const down = i + w;
      if (cells[down] === EMPTY) { cells[down] = SAND; cells[i] = EMPTY; clock[down] = parity; continue; }
      s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0;
      const dir = s & 1 ? 1 : -1;
      if (x + dir >= 0 && x + dir < w && cells[down + dir] === EMPTY) { cells[down + dir] = SAND; cells[i] = EMPTY; clock[down + dir] = parity; continue; }
      if (x - dir >= 0 && x - dir < w && cells[down - dir] === EMPTY) { cells[down - dir] = SAND; cells[i] = EMPTY; clock[down - dir] = parity; }
    }
  }
}

/** Blocs d'une phase du damier : (bx, by) de même parité que (px, py), jamais deux voisins. */
export function phaseBlocks(w: number, h: number, px: number, py: number): Int32Array {
  const cols = Math.ceil(w / BLOCK), rows = Math.ceil(h / BLOCK);
  const out: number[] = [];
  for (let by = py; by < rows; by += 2) for (let bx = px; bx < cols; bx += 2) out.push(bx, by);
  return Int32Array.from(out);
}

/** Diffusion de la chaleur sur les rangées `y0` à `y1` (exclue), de `src` vers `dst` : la boucle de `thermal()`, sans les changements d'état. */
export function diffuseRows(src: Float32Array, dst: Float32Array, w: number, h: number, y0: number, y1: number): void {
  for (let y = y0; y < y1; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const t = src[i];
      const sum =
        (y > 0 ? src[i - w] : t) + (y < h - 1 ? src[i + w] : t) +
        (x > 0 ? src[i - 1] : t) + (x < w - 1 ? src[i + 1] : t);
      dst[i] = t + 0.16 * (sum - 4 * t) + 0.02 * (20 - t);
    }
  }
}

/** La scène commune : un sol de pierre, un tiers de la hauteur en sable qui tombe, des températures variées. */
export function scene(cells: Uint8Array, temp: Float32Array, w: number, h: number): void {
  cells.fill(EMPTY);
  for (let y = h - 8; y < h; y++) cells.fill(STONE, y * w, (y + 1) * w);
  const top = Math.floor(h * 0.1), bottom = Math.floor(h * 0.43);
  for (let y = top; y < bottom; y++) cells.fill(SAND, y * w, (y + 1) * w);
  for (let i = 0; i < temp.length; i++) temp[i] = 20 + ((i * 2654435761) >>> 24);
}
