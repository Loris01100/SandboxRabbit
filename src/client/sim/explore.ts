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
import { EMPTY, HERO, LAVA, MATERIALS, PETROLEUM, PLANT, SAND, STONE, URANIUM, WATER, WOOD, type MaterialId } from "./materials.ts";
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

/** `life` d'une matière tout juste posée, par id : ce qu'écrit `set()` (`MATERIALS[id].life ?? 0`). */
const BORN = new Uint8Array(256);
/** Température d'une matière tout juste posée, par id (`spawn`, sinon `heat`) ; NaN : celle de l'air. */
const WARM = new Float32Array(256).fill(Number.NaN);
for (const [key, m] of Object.entries(MATERIALS)) {
  BORN[Number(key)] = m.life ?? 0;
  WARM[Number(key)] = m.spawn ?? m.heat ?? Number.NaN;
}

/**
 * Grain du rendu (`noise`) d'un chunk, `STRIP` colonnes sur `h` rangées, de
 * gauche à droite puis de haut en bas : un hachage de la position, le même
 * pour tous les chunks. Un chunk revisité garde ainsi son grain, et le poser
 * n'est qu'une recopie de rangées. Hacher chaque cellule de chaque chunk
 * posé coûtait 2 ms d'un glissement ; un motif de grain qui revient toutes
 * les 256 colonnes ne se voit pas.
 */
const GRAINS = new Map<number, Int8Array>();
function grains(h: number): Int8Array {
  let g = GRAINS.get(h);
  if (!g) {
    g = new Int8Array(STRIP * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < STRIP; x++) g[y * STRIP + x] = Math.trunc(lattice(0x67a1, x, y) * 255) - 128;
    GRAINS.set(h, g);
  }
  return g;
}

/** La colonne `x` du monde dans son chunk, de 0 à `STRIP` - 1 (à gauche de zéro aussi). */
const inChunk = (x: number): number => x - Math.floor(x / STRIP) * STRIP;

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
  if (from >= to) return;
  const { cells, life, frozen, noise } = e, g = grains(h);
  const temp = e.temp, ambient = e.ambient;
  // Ce que ferait `set()`, sans ses trois lectures de `MATERIALS` ni son
  // réveil par cellule : 184 000 appels par chunk, la moitié d'un glissement.
  // Le réveil se fait d'un coup, par colonnes de blocs (`wakeColumns()`).
  for (let y = 0; y < h; y++) {
    for (let x = from, col = (from + x0 - r.a) * h + y; x < to; x++, col += h) {
      const i = y * w + x, id = r.cells[col];
      cells[i] = id;
      frozen[i] = 0;
      life[i] = BORN[id];
      const t = WARM[id];
      temp[i] = !Number.isNaN(t) ? t : ambient; // NaN : la matière n'a pas de température à elle
      noise[i] = g[y * STRIP + inChunk(x0 + x)];
    }
  }
  e.wakeColumns(from, to);
  for (let k = 0; k < r.rabbits.length; k += 3) {
    const x = r.rabbits[k] - x0;
    if (x - 2 >= from && x + 2 < to) e.spawnRabbit(x, r.rabbits[k + 1], r.rabbits[k + 2]);
  }
}

/** Recalcule le grain du rendu des colonnes `[from, to)` du bac (un chunk rangé ne le garde pas). */
export function regrain(e: Engine, x0: number, from: number, to: number): void {
  const { width: w, height: h, noise } = e;
  const g = grains(h);
  // Un chunk entier (le cas du glissement) : une recopie par rangée.
  if (inChunk(x0 + from) === 0 && to - from === STRIP) {
    for (let y = 0; y < h; y++) noise.set(g.subarray(y * STRIP, (y + 1) * STRIP), y * w + from);
    return;
  }
  for (let y = 0; y < h; y++) for (let x = from; x < to; x++) noise[y * w + x] = g[y * STRIP + inChunk(x0 + x)];
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
  /**
   * Chunks sortis de la fenêtre, par numéro : encodés (codec : matière, figé,
   * `life`, température), ou encore bruts (`Stash`) le temps que `prepare()`
   * les encode — l'encodage coûtait 5 ms au tick du glissement. Un chunk qui
   * va rentrer est au contraire décodé d'avance. Brut ou encodé, il revient
   * identique : la température brute est déjà arrondie au pas du codec.
   */
  readonly kept = new Map<number, string | Stash>();
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
    // Rangé de nouveau à sa prochaine sortie, tel qu'il sera devenu.
    this.kept.delete(c);
    if (data !== undefined && this.reread(e, data, into * STRIP)) regrain(e, this.x0, into * STRIP, (into + 1) * STRIP);
    else lay(e, this.built(c, e.height), this.x0);
    return dx;
  }

  /**
   * Repose un chunk rangé ; false s'il est illisible. Venu d'une partie
   * reprise (`resume()`), il a passé par le stockage local, qu'une autre
   * version ou un quota plein a pu abîmer : rebâti par la graine plutôt que
   * de jeter au tick du glissement. `open()` jette avant toute écriture.
   */
  private reread(e: Engine, data: string | Stash, x: number): boolean {
    try {
      unpack(e, data, x);
      return true;
    } catch {
      return false;
    }
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
    const k = x < 0 ? null : x >= e.width - 2 * STRIP ? e.width / STRIP : x < 2 * STRIP ? -1 : null;
    const c = k === null ? null : this.chunk(k);
    // Un chunk rangé brut et qui n'est pas sur le point de rentrer : encodé
    // maintenant, un par image (2 ms), pour ne pas garder 700 Ko par chunk.
    for (const [n, entry] of this.kept) {
      if (typeof entry === "string" || n === c) continue;
      this.kept.set(n, seal(entry));
      return;
    }
    if (c === null) return;
    const entry = this.kept.get(c);
    if (entry !== undefined) {
      // Il va rentrer : décodé d'avance (5 ms), il ne reste au glissement que la recopie.
      if (typeof entry === "string") {
        try {
          this.kept.set(c, open(entry, e.height));
        } catch {
          this.kept.delete(c); // illisible : il sera bâti par la graine
        }
      }
      return;
    }
    if (this.early?.c !== c) this.early = { c, parts: [] };
    const { parts } = this.early;
    if (parts.length * PIECE >= STRIP) return;
    const at = c * STRIP + parts.length * PIECE;
    parts.push(raise(this.seed, this.scale, e.height, at, at + PIECE));
  }

  /**
   * La partie, de quoi la reprendre plus tard (`resume()`) : graine, origine,
   * héros piloté, la fenêtre (`grid`, encodée par le bac) et les chunks
   * rangés, les plus proches de la fenêtre d'abord. Au-delà de `SAVE_MAX`
   * caractères, les plus lointains sont laissés : ils reviendront tels que
   * la graine les bâtit. La graine en tête, pour que la page la lise sans
   * tout relire (`savedSeed()` de main.ts).
   * ponytail: un seul monde rangé, dans le stockage local (environ 5 Mo) ;
   * IndexedDB, ou ne ranger que les chunks touchés, le jour où ça ne suffit
   * plus (docs/agents/exploration.md, étape 5).
   */
  save(e: Engine, grid: string): string {
    const mid = this.chunk(e.width / STRIP / 2);
    const all = [...this.kept].sort((a, b) => Math.abs(a[0] - mid) - Math.abs(b[0] - mid));
    const kept: [number, string][] = [];
    let size = grid.length;
    for (const [n, entry] of all) {
      const data = typeof entry === "string" ? entry : seal(entry);
      size += data.length;
      if (size > SAVE_MAX) break;
      kept.push([n, data]);
    }
    const log: Log = { seed: this.seed, x0: this.x0, chosen: e.chosen, grid, kept };
    return JSON.stringify(log);
  }

  /**
   * Reprend une partie rangée par `save()` : la fenêtre est déjà posée dans
   * le bac (`put()` de sandbox.ts, qui a jeté si elle était illisible). Le
   * grain n'est pas rangé : il vient de la position, refait ici.
   */
  resume(e: Engine, log: Log): void {
    this.x0 = log.x0;
    for (const [n, data] of log.kept) this.kept.set(n, data);
    for (let x = 0; x < e.width; x += STRIP) regrain(e, this.x0, x, x + STRIP);
    e.chosen = log.chosen;
  }

  /** Le chunk `c` est-il bâti d'avance, en entier ? (tests) */
  ready(c: number): boolean {
    return this.early?.c === c && this.early.parts.length * PIECE >= STRIP;
  }
}

/** Une partie rangée (`save()`), telle que la relit `parse()`. */
export interface Log {
  seed: number;
  x0: number;
  chosen: number;
  grid: string;
  kept: [number, string][];
}

/**
 * Plafond d'une partie rangée, en caractères : le stockage local tient
 * environ 5 millions de caractères par site, et les autres clés (le bac, les
 * records, les mondes publiés) y vivent aussi. Une fenêtre pèse 100 à 200 Ko,
 * un chunk rangé 10 à 25 : une centaine de chunks.
 */
const SAVE_MAX = 3_000_000;

/**
 * Relit une partie rangée par `save()`, null si ce n'en est pas une. Venue du
 * stockage local : la forme est vérifiée ici, la fenêtre par `put()`, chaque
 * chunk à sa relecture (`reread()`).
 */
export function parse(text: string): Log | null {
  let o: unknown;
  try {
    o = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof o !== "object" || o === null) return null;
  const { seed, x0, chosen, grid, kept } = o as Record<string, unknown>;
  if (!Number.isSafeInteger(seed) || !Number.isSafeInteger(x0) || (x0 as number) % STRIP !== 0
    || !Number.isInteger(chosen) || (chosen as number) < 0 || (chosen as number) > 255
    || typeof grid !== "string" || !Array.isArray(kept)) return null;
  for (const k of kept as unknown[]) {
    if (!Array.isArray(k) || k.length !== 2 || !Number.isSafeInteger(k[0]) || typeof k[1] !== "string") return null;
  }
  return { seed: seed as number, x0: x0 as number, chosen: chosen as number, grid, kept: kept as [number, string][] };
}

/**
 * Un chunk rangé, pas encore encodé : ses couches, `STRIP` colonnes de large,
 * et sa température en octets, **arrondie comme le codec** (`heat`). Relu
 * avant d'être encodé, il revient donc exactement comme il serait revenu
 * encodé : le résultat ne dépend pas de la cadence des images.
 */
export interface Stash {
  cells: Uint8Array;
  frozen: Uint8Array;
  life: Uint8Array;
  heat: Uint8Array;
  /** Le chunk encodé dont il a été décodé (`open()`), s'il l'a été : `seal()` le rend sans réencoder. */
  data?: string;
}

/**
 * Pas et plancher de la température du codec (sim/codec.ts, bloc 4) : gelés
 * avec son format — un monde enregistré ne se relirait plus sinon. Recopiés
 * ici pour arrondir un chunk rangé sans l'encoder.
 */
const STEP = 8, FLOOR = -60;

/** Range les colonnes `[x, x + STRIP)` du bac, rangée par rangée, sans les encoder. */
function pack(e: Engine, x: number): Stash {
  const { width: w, height: h, temp } = e;
  const n = STRIP * h;
  const s: Stash = { cells: new Uint8Array(n), frozen: new Uint8Array(n), life: new Uint8Array(n), heat: new Uint8Array(n) };
  for (let y = 0; y < h; y++) {
    const from = y * w + x, to = y * STRIP;
    s.cells.set(e.cells.subarray(from, from + STRIP), to);
    s.frozen.set(e.frozen.subarray(from, from + STRIP), to);
    s.life.set(e.life.subarray(from, from + STRIP), to);
    for (let k = 0; k < STRIP; k++) {
      const v = Math.round((temp[from + k] - FLOOR) / STEP);
      s.heat[to + k] = v < 0 ? 0 : v > 255 ? 255 : v;
    }
  }
  return s;
}

/** Encode un chunk rangé (codec). La température repart de ses octets : le codec la retrouve au même octet près. */
function seal(s: Stash): string {
  if (s.data !== undefined) return s.data;
  const temp = new Float32Array(s.heat.length);
  for (let i = 0; i < temp.length; i++) temp[i] = s.heat[i] * STEP + FLOOR;
  return encode(s.cells, s.frozen, s.life, temp);
}

/** Décode un chunk rangé, haut de `h`. */
function open(data: string, h: number): Stash {
  const n = STRIP * h;
  const temp = decodeTemp(data, n);
  const heat = new Uint8Array(n);
  if (temp) for (let i = 0; i < n; i++) heat[i] = (temp[i] - FLOOR) / STEP;
  return { cells: decode(data, n), frozen: decodeFrozen(data, n), life: decodeLife(data, n) ?? new Uint8Array(n), heat, data };
}

/**
 * Repose un chunk rangé aux colonnes `[x, x + STRIP)`, juste vidées par
 * `shift()`. `paste()` réveille ce qu'il écrit et écarte les matières
 * inconnues ; la température est écrite à la main dans le tampon courant,
 * sur des blocs que `paste()` vient de réveiller — leur prochaine passe de
 * chaleur part donc d'elle. Elle revient arrondie au pas du codec (8 °C).
 */
function unpack(e: Engine, entry: string | Stash, x: number): void {
  const { width: w, height: h, temp } = e;
  const s = typeof entry === "string" ? open(entry, h) : entry;
  e.paste({ width: STRIP, height: h, cells: s.cells, frozen: s.frozen, life: s.life }, x, 0);
  for (let y = 0; y < h; y++) {
    const to = y * w + x, from = y * STRIP;
    for (let k = 0; k < STRIP; k++) temp[to + k] = s.heat[from + k] * STEP + FLOOR;
  }
}
