/**
 * Le mode exploration : un monde infini en largeur, vu par une fenêtre qui
 * glisse (docs/agents/exploration.md, étape 3).
 *
 * Le moteur garde sa grille de toujours, la fenêtre. Quand le héros sort des
 * trois chunks du milieu, elle glisse d'un chunk (`STRIP` colonnes) : celui
 * qui sort est encodé et rangé (`kept`), celui qui entre est relu s'il a déjà
 * été vu, sinon bâti par la graine (`raise()`). Hors de la fenêtre, le monde
 * est gelé.
 *
 * La décision ne dépend que de la grille (la place du héros après le tick) :
 * deux machines qui jouent la même partie décalent au même tick. Bâtir
 * d'avance (`prepare()`) ne compte pas : `raise()` est pur, le chunk bâti en
 * huit morceaux sur huit images est celui qu'on aurait bâti d'un coup.
 *
 * Le générateur du monde infini (`land()`, `raise()`, `lay()`) vit ici et pas
 * dans terrain.ts : ce module n'est chargé (`import()` de sandbox.ts) qu'au
 * premier clic sur Explorer. Le Worker de simulation a un budget (80 Kio), et
 * un joueur qui n'explore pas n'a pas à télécharger de quoi le faire.
 * terrain.ts lui prête son relief et son sous-sol (`plan()`, `surface()`,
 * `under()`) : les deux mondes partagent la même roche.
 *
 * Pur, sans DOM : test/sim.ts et test/sandbox.ts le font jouer sous Node.
 */
import type { Engine } from "./engine.ts";
import { decode, decodeFrozen, decodeLife, decodeTemp, encode } from "./codec.ts";
import { EMPTY, HERO, LAVA, PETROLEUM, PLANT, SAND, STONE, URANIUM, WATER, WOOD, type MaterialId } from "./materials.ts";
import { SEALS, lattice, plan, surface, under } from "../terrain.ts";

/**
 * Échelle du décor en mode exploration : arbres, grottes et lacs gardent la
 * taille qu'ils ont en 320×180, ×1,5, quelle que soit la grille. Sans elle, un
 * monde 1280×720 a des arbres quatre fois plus grands, et le héros (sept
 * cellules) y paraît minuscule même zoomé.
 */
export const EXPLORE_SCALE = 1.5;


/**
 * Largeur d'un chunk du mode exploration, en colonnes (docs/agents/exploration.md).
 * Multiple de 16 et de 32 : un décalage de la fenêtre garde l'alignement des
 * blocs de veille et du damier.
 */
export const STRIP = 256;

/** Grain du rendu (`noise`) d'une cellule du monde : un hachage, pour qu'un chunk revisité garde le même grain. */
function grain(x: number, y: number): number {
  return ((lattice(0x67a1, x, y) * 255) | 0) - 128;
}

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
 * l'ambiante. Ne consomme aucun tirage du bac. C'est `lay(raise(…))` : le mode
 * exploration appelle les deux à part, pour bâtir d'avance hors du bac.
 */
export function land(e: Engine, seed: number, scale: number, x0: number, from: number, to: number): void {
  from = Math.max(0, from);
  to = Math.min(e.width, to);
  if (from >= to) return;
  lay(e, raise(seed, scale, e.height, x0 + from, x0 + to), x0);
}

/** Une tranche du monde bâtie hors du bac : colonnes `[a, b)` du monde, `cells` colonne par colonne, de haut en bas ; les lapins en triplets (x du monde, y, sens). */
export interface Raised {
  a: number;
  b: number;
  h: number;
  cells: Uint8Array;
  rabbits: number[];
}

/**
 * Bâtit les colonnes `[a, b)` du monde, haut de `h`, sans toucher à aucun
 * bac : pur, donc calculable d'avance et par morceaux (`join()`), au résultat
 * identique (voir `land()`). Coûte de l'ordre de 30 ms pour 256 colonnes de
 * 720 : le mode exploration le répartit sur plusieurs images.
 */
export function raise(seed: number, scale: number, h: number, a: number, b: number): Raised {
  const p = plan(seed, h, scale);
  const { s, sea } = p;
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

  // Les lapins : leur corps (colonnes x - 2 … x + 2) tient dans leur chunk ; `lay()` les pose sur la grille bâtie.
  const rabbits: number[] = [];
  const bunny = (x: number): boolean => sandy(x) && roll(x) >= 0.012 && roll(x) < 0.02;
  for (let x = a; x < b; x++) {
    const m = x - Math.floor(x / STRIP) * STRIP;
    if (m < 3 || m > STRIP - 4 || !bunny(x)) continue;
    let alone = true;
    for (let k = 1; k <= 5; k++) if (bunny(x - k)) alone = false;
    if (alone) rabbits.push(x, top(x) - 2, lattice(seed + 53, x, 0) < 0.5 ? 1 : -1);
  }
  return { a, b, h, cells: out, rabbits };
}

/**
 * Recolle des tranches contiguës bâties à part (`raise()` par morceaux) : la
 * même tranche que si on l'avait bâtie d'un coup. Les colonnes se suivent
 * dans `cells`, il n'y a qu'à mettre bout à bout.
 */
export function join(parts: Raised[]): Raised {
  const { h } = parts[0];
  const a = parts[0].a, b = parts[parts.length - 1].b;
  const cells = new Uint8Array((b - a) * h);
  const rabbits: number[] = [];
  for (const p of parts) {
    cells.set(p.cells, (p.a - a) * h);
    rabbits.push(...p.rabbits);
  }
  return { a, b, h, cells, rabbits };
}

/**
 * Pose une tranche bâtie (`raise()`) dans le bac dont la colonne 0 est la
 * colonne `x0` du monde : matière, température ramenée à l'ambiante, grain,
 * puis les lapins dont le corps tient dans la tranche. Ce qui dépasse du bac
 * est ignoré.
 */
export function lay(e: Engine, r: Raised, x0: number): void {
  const { width: w } = e, { h } = r;
  const from = Math.max(0, r.a - x0), to = Math.min(w, r.b - x0);
  const { noise } = e;
  const temp = e.temp, ambient = e.ambient;
  for (let x = from; x < to; x++) {
    const col = (x + x0 - r.a) * h;
    for (let y = 0; y < h; y++) {
      const i = y * w + x;
      temp[i] = ambient;
      e.set(x, y, r.cells[col + y] as MaterialId);
      noise[i] = grain(x0 + x, y);
    }
  }
  for (let k = 0; k < r.rabbits.length; k += 3) {
    const x = r.rabbits[k] - x0;
    if (x - 2 >= from && x + 2 < to) e.spawnRabbit(x, r.rabbits[k + 1], r.rabbits[k + 2]);
  }
}

/** Recalcule le grain du rendu des colonnes `[from, to)` du bac (un chunk rangé ne le garde pas). */
export function regrain(e: Engine, x0: number, from: number, to: number): void {
  const { width: w, height: h, noise } = e;
  for (let y = 0; y < h; y++) for (let x = from; x < to; x++) noise[y * w + x] = grain(x0 + x, y);
}


/** La fenêtre : cinq chunks de large, la hauteur du monde. */
export const WINDOW_W = 5 * STRIP;
export const WINDOW_H = 720;
/** Colonnes bâties d'avance par image : environ 4 ms, un huitième de chunk. */
const PIECE = 32;

export class Explore {
  readonly seed: number;
  readonly scale: number;
  /** Colonne du monde qui est la colonne 0 du bac. Multiple de `STRIP`. */
  x0 = -2 * STRIP;
  /** Chunks sortis de la fenêtre, encodés (codec : matière, figé, `life`, température), par numéro. */
  readonly kept = new Map<number, string>();
  /** Le chunk en cours de construction d'avance : son numéro et ses morceaux faits. */
  private early: { c: number; parts: Raised[] } | null = null;

  constructor(seed: number, scale = EXPLORE_SCALE) {
    this.seed = seed;
    this.scale = scale;
  }

  /**
   * Bâtit la fenêtre de départ, monde x de `-2 * STRIP` à `3 * STRIP`, et pose
   * le héros au sec le plus près du milieu (colonne 0 du monde, à peu près).
   * Rend l'index de son cœur, -1 faute de place.
   */
  start(e: Engine): number {
    e.clear();
    land(e, this.seed, this.scale, this.x0, 0, e.width);
    const { width: w, height: h, cells } = e;
    for (let d = 0; d < w / 2; d++) {
      const x = (w >> 1) + (d & 1 ? d : -d);
      let y = 0;
      while (y < h && cells[y * w + x] === 0) y++;
      if (y >= h || (cells[y * w + x] !== SAND && cells[y * w + x] !== STONE)) continue;
      const heart = e.spawnHero(x, y - 2);
      if (heart >= 0) return heart;
    }
    return -1;
  }

  /** Numéro du chunk du monde qui occupe les colonnes `[k * STRIP, (k + 1) * STRIP)` du bac. */
  private chunk(k: number): number {
    return this.x0 / STRIP + k;
  }

  /** Colonne du héros piloté dans le bac, -1 sans héros. */
  private heroX(e: Engine): number {
    const at = e.hero;
    return at >= 0 && e.cells[at] === HERO ? at % e.width : -1;
  }

  /** De combien glisser après ce tick : `STRIP` si le héros a passé le quatrième chunk, `-STRIP` s'il est dans le premier, 0 sinon. */
  due(e: Engine): number {
    const x = this.heroX(e);
    if (x < 0) return 0;
    if (x >= e.width - STRIP) return STRIP;
    if (x < STRIP) return -STRIP;
    return 0;
  }

  /**
   * Fait glisser la fenêtre si le héros l'exige (`due()`). Après chaque tick,
   * entre deux ticks : c'est ce qu'exige `Engine.shift()`. Rend le décalage
   * fait, 0 le plus souvent.
   */
  slide(e: Engine): number {
    const dx = this.due(e);
    if (dx === 0) return 0;
    const w = e.width, last = w / STRIP - 1;
    // Le chunk qui sort : rangé tel quel, avant de glisser.
    const out = dx > 0 ? 0 : last;
    this.kept.set(this.chunk(out), pack(e, out * STRIP));
    e.shift(dx);
    this.x0 += dx;
    const into = dx > 0 ? last : 0;
    const c = this.chunk(into);
    const data = this.kept.get(c);
    if (data !== undefined) {
      unpack(e, data, into * STRIP);
      regrain(e, this.x0, into * STRIP, (into + 1) * STRIP);
      // Rangé de nouveau à sa prochaine sortie, tel qu'il sera devenu.
      this.kept.delete(c);
    } else {
      lay(e, this.built(c, e.height), this.x0);
    }
    return dx;
  }

  /** Le chunk `c`, bâti d'avance s'il l'a été, sinon bâti maintenant (le reste des morceaux). */
  private built(c: number, h: number): Raised {
    const parts = this.early?.c === c ? this.early.parts : [];
    this.early = null;
    let at = c * STRIP + parts.length * PIECE;
    while (at < (c + 1) * STRIP) {
      parts.push(raise(this.seed, this.scale, h, at, at + PIECE));
      at += PIECE;
    }
    return join(parts);
  }

  /**
   * Bâtit d'avance un morceau (`PIECE` colonnes) du chunk qui entrera si le
   * héros continue : à droite dès qu'il est dans le quatrième chunk, à gauche
   * dans le deuxième. Rien si ce chunk a déjà été vu (il sera relu, pas
   * bâti) ou déjà prêt. Appelé par le bac une fois par image : une tranche
   * entière coûte 30 ms, huit morceaux en coûtent 4 chacun.
   */
  prepare(e: Engine): void {
    const x = this.heroX(e);
    if (x < 0) return;
    const k = x >= e.width - 2 * STRIP ? e.width / STRIP : x < 2 * STRIP ? -1 : null;
    if (k === null) return;
    const c = this.chunk(k);
    if (this.kept.has(c)) return;
    if (this.early?.c !== c) this.early = { c, parts: [] };
    const { parts } = this.early;
    if (parts.length * PIECE >= STRIP) return;
    const at = c * STRIP + parts.length * PIECE;
    parts.push(raise(this.seed, this.scale, e.height, at, at + PIECE));
  }

  /** Le chunk `c` est-il bâti d'avance, en entier ? (tests) */
  ready(c: number): boolean {
    return this.early?.c === c && this.early.parts.length * PIECE >= STRIP;
  }
}

/** Encode les colonnes `[x, x + STRIP)` du bac : matière, figé, `life`, température. */
function pack(e: Engine, x: number): string {
  const { width: w, height: h } = e;
  const clip = e.copy(x, 0, x + STRIP - 1, h - 1);
  const temp = new Float32Array(STRIP * h);
  for (let y = 0; y < h; y++) temp.set(e.temp.subarray(y * w + x, y * w + x + STRIP), y * STRIP);
  return encode(clip.cells, clip.frozen, clip.life, temp);
}

/**
 * Repose un chunk rangé aux colonnes `[x, x + STRIP)`, juste vidées par
 * `shift()`. `paste()` réveille ce qu'il écrit et écarte les matières
 * inconnues ; la température est écrite à la main dans le tampon courant,
 * sur des blocs que `paste()` vient de réveiller — leur prochaine passe de
 * chaleur part donc d'elle. Elle revient arrondie au pas du codec (8 °C).
 */
function unpack(e: Engine, data: string, x: number): void {
  const { width: w, height: h } = e;
  const n = STRIP * h;
  e.paste({ width: STRIP, height: h, cells: decode(data, n), frozen: decodeFrozen(data, n), life: decodeLife(data, n) ?? new Uint8Array(n) }, x, 0);
  const temp = decodeTemp(data, n);
  if (temp) for (let y = 0; y < h; y++) e.temp.set(temp.subarray(y * STRIP, (y + 1) * STRIP), y * w + x);
}
