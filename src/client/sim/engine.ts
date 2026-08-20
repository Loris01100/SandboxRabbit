import {
  ACID, BATTERY, C4, CANDLE, EMBER, EMPTY, FALLOUT, FIRE, GLASS, ICE, LAVA, MATERIALS, METAL,
  FILINGS, MAGNET, MINE, NANITE, NITRO, PLANT, SALT, SALTWATER, SAND, SEED, SMOKE, SOURCE, SPARK, STEAM,
  STONE, SWITCH, THERMITE, TNT, URANIUM, WATER, WOOD, type MaterialId,
} from "./materials.ts";

/** Température de l'air au repos, en °C. */
export const AMBIENT = 20;
/** Part de la différence avec les voisins échangée par tick. */
const CONDUCTION = 0.16;
/** Retour vers l'ambiante par tick (le bac à sable perd sa chaleur). */
const COOLING = 0.02;
/** Ticks pendant lesquels un métal qui vient de conduire refuse l'étincelle. */
const RECOVERY = 8;
/** Ticks entre deux étincelles d'une pile (plus long que `RECOVERY`, sinon le fil sature). */
const PULSE = 24;
/** Cellules de chute au-delà desquelles l'atterrissage détonne la nitroglycérine. */
const SHOCK = 4;
/** Ticks de combustion de la thermite : assez pour percer, pas pour vider la scène. */
const BURN = 150;
/** Voisins d'uranium à partir desquels un tas s'emballe (4 = enfoui dans un bloc). */
const CRITICAL = 3;
/** Ticks d'emballement avant la détonation : le temps de casser le tas. */
const MELTDOWN = 120;
/** Rayon du souffle nucléaire. */
const NUKE = 16;
/** Portée de l'aimant, en cellules. */
const PULL = 5;

/**
 * `thermal()` lit trois propriétés par cellule et par tick : autant les sortir
 * de `MATERIALS` une fois pour toutes. Un accès de tableau typé au lieu d'une
 * propriété d'objet, sur 57 600 cellules × 60 fois par seconde.
 * Les tables **dérivent** du registre : ajouter une matière ne change rien ici.
 */
/** `kind`, en numérique : 0 vide, 1 statique, 2 poudre, 3 liquide, 4 gaz. */
const KINDS = { empty: 0, static: 1, powder: 2, liquid: 3, gas: 4 } as const;
const KIND = new Uint8Array(256);
const DENSITY = new Float32Array(256);
const HEAT = new Float32Array(256).fill(NaN); // NaN = ne chauffe pas
const BOIL_AT = new Float32Array(256).fill(Infinity);
const BOIL_INTO = new Uint8Array(256);
const FREEZE_AT = new Float32Array(256).fill(-Infinity);
const FREEZE_INTO = new Uint8Array(256);
for (const key of Object.keys(MATERIALS)) {
  const m = MATERIALS[Number(key)];
  KIND[m.id] = KINDS[m.kind];
  DENSITY[m.id] = m.density;
  if (m.heat !== undefined) HEAT[m.id] = m.heat;
  if (m.boil) { BOIL_AT[m.id] = m.boil.at; BOIL_INTO[m.id] = m.boil.into; }
  if (m.freeze) { FREEZE_AT[m.id] = m.freeze.at; FREEZE_INTO[m.id] = m.freeze.into; }
}

/**
 * Offsets d'un disque de rayon `radius`, du bord vers le centre — l'ordre dans
 * lequel le souffle doit traiter ses cellules. Mis en cache : les explosions
 * n'utilisent qu'une poignée de rayons.
 */
const DISCS = new Map<number, [number, number, number][]>();

function disc(radius: number): [number, number, number][] {
  const known = DISCS.get(radius);
  if (known) return known;
  const cells: [number, number, number][] = [];
  for (let y = -radius; y <= radius; y++) {
    for (let x = -radius; x <= radius; x++) {
      const d = Math.hypot(x, y);
      if (d <= radius) cells.push([x, y, d]);
    }
  }
  cells.sort((a, b) => b[2] - a[2]);
  DISCS.set(radius, cells);
  return cells;
}

/** Morceau de grille découpé puis reposé ailleurs (copier / coller). */
export interface Clip {
  width: number;
  height: number;
  cells: Uint8Array;
  life: Uint8Array;
  frozen: Uint8Array;
}

/**
 * Automate cellulaire type « falling sand ».
 *
 * Quatre tableaux plats de la taille de la grille :
 *  - `cells` : l'identifiant du matériau
 *  - `life`  : compteur de vie (feu, fumée, vapeur) ; pour une `SOURCE`, la
 *              matière qu'elle émet
 *  - `temp`  : température en °C, diffusée à chaque tick
 *  - `clock` : parité de la frame où la cellule a déjà bougé (évite qu'une
 *              cellule descende plusieurs fois dans le même tick)
 *  - `frozen`: cellules figées à la main, que la simulation saute
 *
 * Le balayage part du bas et alterne le sens en x d'une frame à l'autre, sinon
 * la matière dérive visiblement vers la gauche.
 */
export class Engine {
  readonly width: number;
  readonly height: number;
  readonly cells: Uint8Array;
  readonly life: Uint8Array;
  /** Réassigné à chaque tick : les deux tampons de diffusion s'échangent. */
  temp: Float32Array;
  private tempNext: Float32Array;
  private readonly clock: Uint8Array;
  /** 1 = cellule figée : elle ne bouge plus et rien ne peut la pousser. */
  readonly frozen: Uint8Array;
  private parity = 0;
  /** Bruit fixe par cellule : donne du grain sans scintiller. */
  readonly noise: Int8Array;
  /** Sens de la gravité : 1 vers le bas, -1 vers le haut. */
  gravity: 1 | -1 = 1;
  /** Vent horizontal, de -1 (plein ouest) à 1 (plein est). */
  wind = 0;
  /** Température de l'air au repos : tout y retourne (climat de la scène). */
  ambient = AMBIENT;
  /** Matière émise par les cellules `SOURCE` déposées ensuite. */
  emit: MaterialId = WATER;

  constructor(width: number, height: number) {
    this.width = width;
    this.height = height;
    const n = width * height;
    this.cells = new Uint8Array(n);
    this.life = new Uint8Array(n);
    this.temp = new Float32Array(n).fill(this.ambient);
    this.tempNext = new Float32Array(n);
    this.clock = new Uint8Array(n);
    this.frozen = new Uint8Array(n);
    this.noise = new Int8Array(n);
    for (let i = 0; i < n; i++) this.noise[i] = ((Math.random() * 255) | 0) - 128;
  }

  index(x: number, y: number): number {
    return y * this.width + x;
  }

  inBounds(x: number, y: number): boolean {
    return x >= 0 && x < this.width && y >= 0 && y < this.height;
  }

  get(x: number, y: number): MaterialId {
    return this.inBounds(x, y) ? this.cells[this.index(x, y)] : STONE; // hors grille = mur
  }

  set(x: number, y: number, id: MaterialId): void {
    if (!this.inBounds(x, y)) return;
    const i = this.index(x, y);
    this.cells[i] = id;
    this.frozen[i] = 0; // repeindre par-dessus libère la cellule
    // Une source garde dans `life` la matière qu'elle crache.
    this.life[i] = id === SOURCE ? this.emit : (MATERIALS[id].life ?? 0);
    const spawn = MATERIALS[id].spawn ?? MATERIALS[id].heat;
    if (spawn !== undefined) this.temp[i] = spawn;
  }

  /**
   * Transformation décidée par une règle (le feu prend, l'acide ronge, le sel
   * fond) : elle passe son tour sur une cellule figée. `set()` libère au
   * contraire ce qu'il touche — c'est le geste du pinceau, pas de la
   * simulation.
   */
  private become(x: number, y: number, id: MaterialId): void {
    if (this.inBounds(x, y) && this.frozen[this.index(x, y)]) return;
    this.set(x, y, id);
  }

  clear(): void {
    this.cells.fill(EMPTY);
    this.life.fill(0);
    this.frozen.fill(0);
    this.temp.fill(this.ambient);
  }

  /**
   * Dépose un disque de matière (pinceau).
   * `overwrite = false` : on ne peint que le vide, la matière déjà là est
   * préservée. La gomme, elle, efface toujours.
   * `only` : ne touche que les cellules de cette matière (gomme sélective).
   */
  paint(cx: number, cy: number, radius: number, id: MaterialId, density = 1, overwrite = true, only?: MaterialId): void {
    const r2 = radius * radius;
    for (let y = cy - radius; y <= cy + radius; y++) {
      for (let x = cx - radius; x <= cx + radius; x++) {
        const dx = x - cx, dy = y - cy;
        if (dx * dx + dy * dy > r2) continue;
        if (!this.inBounds(x, y)) continue;
        if (density < 1 && Math.random() > density) continue;
        const at = this.cells[this.index(x, y)];
        if (only !== undefined && at !== only) continue;
        if (!overwrite && id !== EMPTY && at !== EMPTY) continue;
        this.set(x, y, id);
      }
    }
  }

  /**
   * Remplit un rectangle (bornes comprises, remises dans l'ordre) — l'outil
   * Rectangle. Le pinceau à main levée ne trace pas un mur droit, et il en faut
   * un pour bâtir un réservoir ou un moule.
   */
  rect(x0: number, y0: number, x1: number, y1: number, id: MaterialId, overwrite = true): void {
    const left = Math.max(0, Math.min(x0, x1));
    const right = Math.min(this.width - 1, Math.max(x0, x1));
    const top = Math.max(0, Math.min(y0, y1));
    const bottom = Math.min(this.height - 1, Math.max(y0, y1));
    for (let y = top; y <= bottom; y++) {
      for (let x = left; x <= right; x++) {
        // Même règle que le pinceau : « ne pas écraser » préserve ce qui est là.
        if (!overwrite && id !== EMPTY && this.cells[this.index(x, y)] !== EMPTY) continue;
        this.set(x, y, id);
      }
    }
  }

  /**
   * Découpe un rectangle de la grille (bornes comprises, remises dans l'ordre).
   * `life` part avec : sans lui un interrupteur collé perdrait son état et une
   * source la matière qu'elle crache. La température, elle, reste au bac.
   */
  copy(x0: number, y0: number, x1: number, y1: number): Clip {
    const left = Math.max(0, Math.min(x0, x1));
    const top = Math.max(0, Math.min(y0, y1));
    // Bornes remises dans la grille : un rectangle entièrement dehors donnerait
    // une largeur négative, et `new Uint8Array(-3)` jette.
    const width = Math.max(1, Math.min(this.width - 1, Math.max(x0, x1)) - left + 1);
    const height = Math.max(1, Math.min(this.height - 1, Math.max(y0, y1)) - top + 1);
    const clip: Clip = {
      width, height,
      cells: new Uint8Array(width * height),
      life: new Uint8Array(width * height),
      frozen: new Uint8Array(width * height),
    };
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const from = this.index(left + x, top + y);
        const to = y * width + x;
        clip.cells[to] = this.cells[from];
        clip.life[to] = this.life[from];
        clip.frozen[to] = this.frozen[from];
      }
    }
    return clip;
  }

  /**
   * Pose une grille venue d'ailleurs (monde sauvegardé, lien partagé, salon).
   * Un id absent de `MATERIALS` — matière retirée depuis, ou octet inventé —
   * retombe sur le vide : sans ça `MATERIALS[id].heat` jette à chaque tick et
   * le bac s'arrête pour de bon.
   */
  adopt(cells: Uint8Array): void {
    for (let i = 0; i < this.cells.length; i++) {
      this.cells[i] = MATERIALS[cells[i]] ? cells[i] : EMPTY;
    }
  }

  /** Repose un morceau, coin haut-gauche en (cx, cy). Ce qui dépasse est ignoré. */
  paste(clip: Clip, cx: number, cy: number): void {
    for (let y = 0; y < clip.height; y++) {
      for (let x = 0; x < clip.width; x++) {
        if (!this.inBounds(cx + x, cy + y)) continue;
        const to = this.index(cx + x, cy + y);
        const from = y * clip.width + x;
        // Un morceau peut venir d'un pair : même filtre que `adopt`.
        this.cells[to] = MATERIALS[clip.cells[from]] ? clip.cells[from] : EMPTY;
        this.life[to] = clip.life[from];
        this.frozen[to] = clip.frozen[from];
      }
    }
  }

  /** Fige (ou libère) un disque : la matière garde son identité mais ne bouge plus. */
  setFrozen(cx: number, cy: number, radius: number, on: boolean): void {
    const r2 = radius * radius;
    for (let y = cy - radius; y <= cy + radius; y++) {
      for (let x = cx - radius; x <= cx + radius; x++) {
        const dx = x - cx, dy = y - cy;
        if (dx * dx + dy * dy > r2 || !this.inBounds(x, y)) continue;
        const i = this.index(x, y);
        if (this.cells[i] !== EMPTY) this.frozen[i] = on ? 1 : 0;
      }
    }
  }

  /**
   * Remplit la poche de matière identique sous (x,y) — clic droit.
   * Parcours en largeur avec une pile de scalaires : pas d'objets, la poche
   * peut faire toute la grille.
   */
  fill(x: number, y: number, id: MaterialId): void {
    if (!this.inBounds(x, y)) return;
    const start = this.index(x, y);
    const from = this.cells[start];
    if (from === id) return;
    const stack = [start];
    while (stack.length > 0) {
      const i = stack.pop()!;
      if (this.cells[i] !== from || this.frozen[i]) continue;
      this.become(i % this.width, (i / this.width) | 0, id);
      const cx = i % this.width;
      if (cx > 0) stack.push(i - 1);
      if (cx < this.width - 1) stack.push(i + 1);
      if (i >= this.width) stack.push(i - this.width);
      if (i < this.cells.length - this.width) stack.push(i + this.width);
    }
  }

  /**
   * Une cellule pleine peut-elle prendre la place d'une autre ? Appelée à
   * chaque tentative de déplacement, soit plusieurs fois par cellule et par
   * tick : elle lit les tables plutôt que le registre.
   */
  private displaces(moverId: MaterialId, targetId: MaterialId): boolean {
    if (targetId === EMPTY) return true;
    const kind = KIND[targetId];
    if (kind === KINDS.static || kind === KINDS.powder) return false;
    return DENSITY[moverId] > DENSITY[targetId];
  }

  private swap(a: number, b: number): void {
    const c = this.cells[a]; this.cells[a] = this.cells[b]; this.cells[b] = c;
    const l = this.life[a]; this.life[a] = this.life[b]; this.life[b] = l;
    const t = this.temp[a]; this.temp[a] = this.temp[b]; this.temp[b] = t;
    this.clock[a] = this.parity;
    this.clock[b] = this.parity;
  }

  /** Tente le déplacement vers (x,y) ; renvoie true si la cellule a bougé. */
  private tryMove(from: number, x: number, y: number, id: MaterialId): boolean {
    if (!this.inBounds(x, y)) return false;
    const to = this.index(x, y);
    if (this.frozen[to]) return false;
    if (!this.displaces(id, this.cells[to])) return false;
    this.swap(from, to);
    return true;
  }

  /** Sens horizontal tiré au sort, biaisé par le vent. */
  private drift(): number {
    return Math.random() < 0.5 + this.wind / 2 ? 1 : -1;
  }

  step(): void {
    this.parity ^= 1;
    const { width: w, height: h } = this;
    const leftToRight = this.parity === 0;
    // On balaie dans le sens de la gravité : la matière tombe d'abord.
    for (let k = 0; k < h; k++) {
      const y = this.gravity === 1 ? h - 1 - k : k;
      for (let j = 0; j < w; j++) {
        const x = leftToRight ? j : w - 1 - j;
        const i = y * w + x;
        const id = this.cells[i];
        if (id === EMPTY) continue;
        if (this.frozen[i]) continue; // figée : aucune règle ne s'applique
        if (this.clock[i] === this.parity) continue;
        this.clock[i] = this.parity;
        this.update(i, x, y, id);
      }
    }
    this.thermal();
  }

  private update(i: number, x: number, y: number, id: MaterialId): void {
    switch (id) {
      case FIRE: this.updateFire(i, x, y); return;
      case LAVA: this.updateLava(i, x, y); return;
      case ACID: this.updateAcid(i, x, y); return;
      case PLANT: this.updatePlant(x, y); return;
      case TNT: this.updateTnt(x, y); return;
      case NITRO: this.updateNitro(i, x, y); return;
      case C4: this.updateC4(i, x, y); return;
      case MINE: this.updateMine(x, y); return;
      case THERMITE: this.updateThermite(i, x, y); return;
      case URANIUM: this.updateUranium(i, x, y); return;
      case FALLOUT: this.updateFallout(i, x, y); return;
      case SALT: this.updateSalt(i, x, y); return;
      case SEED: this.updateSeed(i, x, y); return;
      case NANITE: this.updateNanite(i, x, y); return;
      case SOURCE: this.updateSource(i, x, y); return;
      case CANDLE: this.updateCandle(i, x, y); return;
      case BATTERY: this.updateBattery(i, x, y); return;
      case SWITCH: this.updateSwitch(i, x, y); return;
      case EMBER: this.updateEmber(i, x, y); return;
      case SPARK: this.updateSpark(i, x, y); return;
      case MAGNET: this.updateMagnet(i, x, y); return;
      // Le métal ne fait que sortir de sa période de repos.
      case METAL: if (this.life[i] > 0) this.life[i]--; return;
    }
    switch (KIND[id]) {
      case KINDS.powder: this.updatePowder(i, x, y, id); return;
      case KINDS.liquid: this.updateLiquid(i, x, y, id); return;
      case KINDS.gas: this.updateGas(i, x, y, id); return;
      default: return; // statique
    }
  }

  private updatePowder(i: number, x: number, y: number, id: MaterialId): void {
    const down = y + this.gravity;
    if (this.tryMove(i, x, down, id)) return;
    const dir = this.drift();
    if (this.tryMove(i, x + dir, down, id)) return;
    this.tryMove(i, x - dir, down, id);
  }

  private updateLiquid(i: number, x: number, y: number, id: MaterialId): void {
    const down = y + this.gravity;
    if (this.tryMove(i, x, down, id)) return;
    const dir = this.drift();
    if (this.tryMove(i, x + dir, down, id)) return;
    if (this.tryMove(i, x - dir, down, id)) return;
    // Étalement : on glisse aussi loin que possible du même côté.
    const spread = MATERIALS[id].spread ?? 1;
    let cur = i, cx = x;
    for (let s = 0; s < spread; s++) {
      if (!this.tryMove(cur, cx + dir, y, id)) break;
      cx += dir;
      cur = this.index(cx, y);
    }
  }

  private updateGas(i: number, x: number, y: number, id: MaterialId): void {
    if (this.decay(i, id, EMPTY)) return;
    this.moveGas(i, x, y, id);
  }

  /** Montée d'un gaz, sans le vieillissement (le feu gère sa propre fin de vie). */
  private moveGas(i: number, x: number, y: number, id: MaterialId): void {
    const up = y - this.gravity;
    const dir = this.drift();
    if (Math.random() < 0.7 && this.tryMove(i, x, up, id)) return;
    if (this.tryMove(i, x + dir, up, id)) return;
    this.tryMove(i, x + dir, y, id);
  }

  /** Décrémente la vie ; à zéro remplace par `into`. */
  private decay(i: number, id: MaterialId, into: MaterialId): boolean {
    const max = MATERIALS[id].life ?? 0;
    if (max === 0) return false;
    if (this.life[i] === 0) this.life[i] = max;
    if (--this.life[i] > 0) return false;
    this.cells[i] = into;
    this.life[i] = MATERIALS[into].life ?? 0;
    return true;
  }

  private updateFire(i: number, x: number, y: number): void {
    // L'eau tue la flamme, et se change en vapeur.
    for (const [nx, ny] of this.neighbors(x, y)) {
      const n = this.get(nx, ny);
      if (n === WATER || n === SALTWATER) {
        this.become(nx, ny, STEAM);
        this.become(x, y, STEAM);
        return;
      }
    }
    this.ignite(x, y);
    if (this.decay(i, FIRE, SMOKE)) return;
    if (Math.random() < 0.6) this.moveGas(i, x, y, FIRE);
  }

  private updateLava(i: number, x: number, y: number): void {
    for (const [nx, ny] of this.neighbors(x, y)) {
      const n = this.get(nx, ny);
      if (n === WATER || n === SALTWATER) {
        this.become(nx, ny, STEAM);
        this.become(x, y, STONE);
        return;
      }
      if (n === SAND && Math.random() < 0.01) this.become(nx, ny, LAVA);
    }
    this.ignite(x, y, 2);
    this.updateLiquid(i, x, y, LAVA);
  }

  /** Met le feu aux voisins inflammables. */
  private ignite(x: number, y: number, boost = 1): void {
    for (const [nx, ny] of this.neighbors(x, y)) {
      const n = this.get(nx, ny);
      const chance = MATERIALS[n]?.flammable;
      if (!chance || Math.random() > chance * boost) continue;
      // Le bois ne disparaît pas en fumée : il passe par la braise.
      this.become(nx, ny, n === WOOD && Math.random() < 0.5 ? EMBER : FIRE);
    }
  }

  private updateAcid(i: number, x: number, y: number): void {
    for (const [nx, ny] of this.neighbors(x, y)) {
      const n = this.get(nx, ny);
      const dissolvable = n === STONE || n === WOOD || n === SAND || n === PLANT
        || n === GLASS || n === ICE || n === SEED;
      if (dissolvable && Math.random() < 0.06) {
        this.become(nx, ny, EMPTY);
        if (Math.random() < 0.5) { this.become(x, y, SMOKE); return; } // l'acide s'use
      }
    }
    this.updateLiquid(i, x, y, ACID);
  }

  private updatePlant(x: number, y: number): void {
    if (Math.random() > 0.08) return;
    let drank = false;
    for (const [nx, ny] of this.neighbors(x, y)) {
      if (this.get(nx, ny) === WATER) { this.become(nx, ny, PLANT); drank = true; break; }
    }
    if (!drank) return;
    // Une pousse peut partir vers le haut ou en biais.
    const dx = (Math.random() * 3 | 0) - 1;
    const up = y - this.gravity;
    if (this.get(x + dx, up) === EMPTY && Math.random() < 0.5) this.become(x + dx, up, PLANT);
  }

  /** Le TNT n'attend que la flamme ; la chaîne se propage par le feu de l'explosion. */
  private updateTnt(x: number, y: number): void {
    for (const [nx, ny] of this.neighbors(x, y)) {
      const n = this.get(nx, ny);
      if (n === FIRE || n === LAVA) { this.explode(x, y); return; }
    }
  }

  /**
   * Nitroglycérine : le choc, pas la chaleur. `life` compte les cellules de
   * chute (le `swap` l'emmène avec elle) ; l'atterrissage au-delà de `SHOCK`
   * détonne. Posée à la main, elle est inoffensive.
   */
  private updateNitro(i: number, x: number, y: number): void {
    for (const [nx, ny] of this.neighbors(x, y)) {
      const n = this.get(nx, ny);
      if (n === FIRE || n === LAVA) { this.explode(x, y, 5); return; }
    }
    const down = y + this.gravity;
    if (this.tryMove(i, x, down, NITRO)) {
      const j = this.index(x, down);
      if (this.life[j] < SHOCK) this.life[j]++;
      return;
    }
    if (this.life[i] >= SHOCK) { this.explode(x, y, 5); return; }
    this.life[i] = 0; // elle s'est arrêtée : le compteur repart de zéro
    this.updateLiquid(i, x, y, NITRO);
  }

  /**
   * C4 : le feu ne lui fait rien, seule l'étincelle le déclenche. `life` = 1
   * marque une charge amorcée par la détonation d'une voisine, pour qu'un mur
   * parte en entier sans dépendre des flammes.
   */
  private updateC4(i: number, x: number, y: number): void {
    if (this.life[i] === 1) { this.explode(x, y, 9); return; }
    for (const [nx, ny] of this.neighbors(x, y)) {
      if (this.get(nx, ny) === SPARK) { this.explode(x, y, 9); return; }
    }
  }

  /** Mine : seul ce qui coule appuie dessus, on peut donc la murer sans la faire sauter. */
  private updateMine(x: number, y: number): void {
    const above = y - this.gravity;
    if (!this.inBounds(x, above)) return;
    const kind = MATERIALS[this.cells[this.index(x, above)]].kind;
    if (kind === "powder" || kind === "liquid") this.explode(x, y, 6);
  }

  /**
   * Thermite : elle ne souffle rien, elle perce. `life` = ticks de combustion
   * restants (0 = éteinte), pendant lesquels elle impose 2800 °C sur place —
   * au-dessus du point de fusion de la pierre, que rien d'autre n'atteint.
   */
  private updateThermite(i: number, x: number, y: number): void {
    if (this.life[i] > 0) {
      this.temp[i] = 2800;
      // `convert` plutôt que `set` : la braise garde la chaleur accumulée.
      if (--this.life[i] === 0) { this.convert(i, EMBER); return; }
      // Elle continue de tomber en brûlant : elle s'enfonce dans ce qu'elle
      // liquéfie (densité 8, elle passe sous la lave), et c'est ça qui perce.
      this.updatePowder(i, x, y, THERMITE);
      return;
    }
    for (const [nx, ny] of this.neighbors(x, y)) {
      const n = this.get(nx, ny);
      const lit = n === THERMITE && this.life[this.index(nx, ny)] > 0;
      if (n === FIRE || n === LAVA || n === SPARK || lit) { this.life[i] = BURN; return; }
    }
    this.updatePowder(i, x, y, THERMITE);
  }

  /**
   * Uranium. Son déclencheur n'est ni le feu ni le choc : c'est **sa propre
   * masse**. Isolé il tiédit et sert de chauffage ; en tas il s'emballe,
   * chauffe de plus en plus (visible en vue thermique), et finit par sauter.
   * Casser le tas fait redescendre le compteur : c'est la seule parade.
   */
  private updateUranium(i: number, x: number, y: number): void {
    let mass = 0;
    for (const [nx, ny] of this.neighbors(x, y)) if (this.get(nx, ny) === URANIUM) mass++;
    if (mass >= CRITICAL) {
      if (++this.life[i] >= MELTDOWN) { this.nuke(x, y); return; }
    } else if (this.life[i] > 0) this.life[i]--;
    this.temp[i] = Math.max(this.temp[i], 60 + this.life[i] * 6);
    this.updatePowder(i, x, y, URANIUM);
  }

  /** Le souffle, puis ce qui distingue le nucléaire : le nuage qui reste. */
  private nuke(cx: number, cy: number): void {
    this.explode(cx, cy, NUKE);
    for (const [ox, oy] of disc(NUKE)) {
      const x = cx + ox, y = cy + oy;
      if (!this.inBounds(x, y)) continue;
      if (this.cells[this.index(x, y)] === EMPTY && Math.random() < 0.2) this.become(x, y, FALLOUT);
    }
  }

  /** Les retombées : un gaz ordinaire, sauf que rien de vivant n'y tient. */
  private updateFallout(i: number, x: number, y: number): void {
    for (const [nx, ny] of this.neighbors(x, y)) {
      const n = this.get(nx, ny);
      if (n === PLANT || n === SEED) this.become(nx, ny, EMPTY);
    }
    this.updateGas(i, x, y, FALLOUT);
  }

  /**
   * Souffle. Le cœur est pulvérisé comme avant, mais la couronne est
   * **projetée vers l'extérieur** au lieu d'être effacée : la matière retombe
   * en débris. On traite les cellules de la plus lointaine à la plus proche,
   * pour que chacune parte vers une place déjà libérée.
   *
   * Ce qui n'a nulle part où aller (un mur plein) est pulvérisé : sans ce
   * repli, une explosion ne percerait plus la pierre.
   */
  explode(cx: number, cy: number, radius = 7): void {
    for (const [ox, oy, d] of disc(radius)) {
      const x = cx + ox, y = cy + oy;
      if (!this.inBounds(x, y)) continue;
      const i = this.index(x, y);
      const id = this.cells[i];
      // Une charge voisine survit à la déflagration et part au tick suivant :
      // le TNT par le feu qu'on vient de semer, le C4 amorcé par `life`.
      if ((id === TNT || id === C4) && d > 0) {
        if (id === C4) this.life[i] = 1;
        continue;
      }
      if (this.frozen[i]) continue;
      // La portée décroît du centre vers le bord, où plus rien ne bouge.
      const range = Math.round((1 - d / radius) * radius * 1.5);
      // D'abord le rayon, puis — s'il est bouché — un jet vers le haut : c'est
      // ce qui fait sortir les débris d'une charge posée à même le sol, que le
      // seul rayon (dirigé vers le bas) laisserait sur place.
      const thrown = d > radius * 0.5 && range > 0
        && (this.hurl(i, x, y, ox / d, oy / d, range)
          || this.hurl(i, x, y, (ox / d) * 0.6, -this.gravity, range));
      if (!thrown) this.become(x, y, Math.random() < 0.5 ? FIRE : EMPTY);
      else if (Math.random() < 0.25) this.become(x, y, FIRE); // le cratère continue de brûler
    }
  }

  /**
   * Projette le contenu d'une cellule le long du rayon, jusqu'à `range`
   * cellules : elle se dépose sur la **dernière place libre** rencontrée. Les
   * débris d'une charge enterrée ressortent ainsi par le cratère au lieu de
   * s'écraser dans la matière voisine, et deux projections ne peuvent pas
   * atterrir au même endroit — la matière est conservée.
   *
   * Renvoie false si le rayon est bouché : à l'appelant de pulvériser.
   */
  private hurl(from: number, x: number, y: number, dx: number, dy: number, range: number): boolean {
    const id = this.cells[from];
    if (id === EMPTY) return true; // rien à projeter, rien à pulvériser non plus
    let to = -1;
    for (let s = 1; s <= range; s++) {
      const tx = x + Math.round(dx * s), ty = y + Math.round(dy * s);
      if (!this.inBounds(tx, ty)) break;
      const j = this.index(tx, ty);
      if (this.frozen[j]) break;
      if (this.cells[j] === EMPTY) to = j;
    }
    if (to < 0) return false;
    this.cells[to] = id;
    this.life[to] = this.life[from];
    this.temp[to] = this.temp[from];
    this.clock[to] = this.parity; // le débris a déjà bougé ce tick
    this.cells[from] = EMPTY;
    this.life[from] = 0;
    return true;
  }

  /** Le sel se dissout dans l'eau et fait fondre la glace. */
  private updateSalt(i: number, x: number, y: number): void {
    for (const [nx, ny] of this.neighbors(x, y)) {
      const n = this.get(nx, ny);
      if (n === WATER) { this.become(nx, ny, SALTWATER); this.become(x, y, EMPTY); return; }
      if (n === ICE && Math.random() < 0.25) { this.become(nx, ny, WATER); this.become(x, y, EMPTY); return; }
    }
    this.updatePowder(i, x, y, SALT);
  }

  private updateSeed(i: number, x: number, y: number): void {
    for (const [nx, ny] of this.neighbors(x, y)) {
      if (this.get(nx, ny) === WATER) { this.become(x, y, PLANT); return; }
    }
    this.updatePowder(i, x, y, SEED);
  }

  /** Gelée grise : dévore un voisin, se réplique, puis meurt de vieillesse. */
  private updateNanite(i: number, x: number, y: number): void {
    if (this.decay(i, NANITE, EMPTY)) return;
    for (const [nx, ny] of this.neighbors(x, y)) {
      const n = this.get(nx, ny);
      if (n === EMPTY || n === NANITE || n === GLASS || n === SOURCE) continue;
      if (Math.random() < 0.2) { this.become(nx, ny, NANITE); break; }
    }
    this.updatePowder(i, x, y, NANITE);
  }

  /** Générateur : crache sa matière (stockée dans `life`) dans la case libre voisine. */
  private updateSource(i: number, x: number, y: number): void {
    if (Math.random() > 0.5) return;
    const id = this.life[i] || WATER;
    const dy = MATERIALS[id].kind === "gas" ? -this.gravity : this.gravity;
    if (this.get(x, y + dy) === EMPTY) this.become(x, y + dy, id);
  }

  /** Bougie : `life` sert de mèche allumée. Une fois prise, elle réalimente sa flamme. */
  private updateCandle(i: number, x: number, y: number): void {
    for (const [nx, ny] of this.neighbors(x, y)) {
      const n = this.get(nx, ny);
      if (n === FIRE || n === LAVA || n === EMBER || n === SPARK) this.life[i] = 1;
      else if (n === WATER || n === SALTWATER) this.life[i] = 0;
    }
    const up = y - this.gravity;
    if (this.life[i] === 1 && this.get(x, up) === EMPTY) this.become(x, up, FIRE);
  }

  /** Braise : plus de flamme, mais ça chauffe (via `heat`) et ça peut rallumer. */
  private updateEmber(i: number, x: number, y: number): void {
    if (this.decay(i, EMBER, SMOKE)) return;
    this.ignite(x, y, 0.5);
    this.updatePowder(i, x, y, EMBER);
  }

  /** Met le métal voisin sous tension, s'il est sorti de sa période de repos. */
  private charge(x: number, y: number): void {
    if (!this.inBounds(x, y)) return;
    const j = this.index(x, y);
    if (this.cells[j] !== METAL || this.life[j] !== 0) return;
    this.cells[j] = SPARK;
    this.life[j] = MATERIALS[SPARK].life!;
  }

  /** Pile : une étincelle dans le métal voisin toutes les `PULSE` frames. */
  private updateBattery(i: number, x: number, y: number): void {
    if (this.life[i] > 0) { this.life[i]--; return; }
    this.life[i] = PULSE;
    for (const [nx, ny] of this.neighbors(x, y)) this.charge(nx, ny);
  }

  /**
   * Interrupteur : `life` = 1 quand il est fermé. Il ne devient jamais étincelle
   * lui-même — il la relaie de l'autre côté — sinon il perdrait son identité en
   * redevenant du métal.
   */
  private updateSwitch(i: number, x: number, y: number): void {
    if (this.life[i] !== 1) return;
    let live = false;
    for (const [nx, ny] of this.neighbors(x, y)) if (this.get(nx, ny) === SPARK) live = true;
    if (!live) return;
    for (const [nx, ny] of this.neighbors(x, y)) this.charge(nx, ny);
  }

  /** Ouvre / ferme l'interrupteur sous le curseur (clic sur un interrupteur déjà posé). */
  toggleSwitch(x: number, y: number): void {
    if (!this.inBounds(x, y)) return;
    const i = this.index(x, y);
    if (this.cells[i] === SWITCH) this.life[i] ^= 1;
  }

  /**
   * Étincelle : ne circule que dans le métal, allume et fait sauter le reste.
   * Le métal traversé se repose `RECOVERY` ticks, sinon l'étincelle repart
   * aussitôt en arrière et le circuit ne s'éteint jamais.
   */
  private updateSpark(i: number, x: number, y: number): void {
    for (const [nx, ny] of this.neighbors(x, y)) {
      if (!this.inBounds(nx, ny)) continue;
      const n = this.cells[this.index(nx, ny)];
      if (n === TNT) this.explode(nx, ny);
      else if (n !== C4) this.charge(nx, ny); // le C4 se déclenche seul en voyant l'étincelle
    }
    this.ignite(x, y, 3);
    if (--this.life[i] > 0) return;
    this.cells[i] = METAL;
    this.life[i] = RECOVERY;
  }

  /**
   * Diffusion de la chaleur, puis changements d'état.
   * Une seule loi remplace autant de cas particuliers : l'eau bout ou gèle, la
   * glace fond, le sable vitrifie, l'huile s'auto-enflamme.
   */
  /**
   * Diffusion, puis changements d'état — en deux balayages au lieu de quatre :
   * les sources de chaleur doivent toutes être posées avant que la diffusion ne
   * lise les voisines, mais le seuil d'ébullition, lui, se teste sur la
   * température qu'on vient de calculer. Et les deux tampons s'échangent plutôt
   * que de se recopier (230 ko par tick en 320×180, pour rien).
   */
  private thermal(): void {
    const { width: w, height: h, cells, temp, tempNext, ambient } = this;
    for (let i = 0; i < cells.length; i++) {
      const heat = HEAT[cells[i]];
      // Une source tire vers sa température sans l'imposer : une flamme peut
      // encore faire fondre la glace qu'elle touche. (NaN = ne chauffe pas.)
      if (heat === heat) temp[i] += (heat - temp[i]) * 0.5;
    }
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        const t = temp[i];
        const sum =
          (y > 0 ? temp[i - w] : t) + (y < h - 1 ? temp[i + w] : t) +
          (x > 0 ? temp[i - 1] : t) + (x < w - 1 ? temp[i + 1] : t);
        const next = t + CONDUCTION * (sum - 4 * t) + COOLING * (ambient - t);
        tempNext[i] = next;
        const id = cells[i];
        if (next > BOIL_AT[id]) this.convert(i, BOIL_INTO[id]);
        else if (next < FREEZE_AT[id]) this.convert(i, FREEZE_INTO[id]);
      }
    }
    this.temp = tempNext;
    this.tempNext = temp;
  }

  /** Retourne le pôle de l'aimant sous le curseur : attirer ↔ repousser. */
  toggleMagnet(x: number, y: number): void {
    if (!this.inBounds(x, y)) return;
    const i = this.index(x, y);
    if (this.cells[i] === MAGNET) this.life[i] ^= 1;
  }

  /**
   * Déplace la limaille d'un cran vers l'aimant (ou à l'opposé si son pôle est
   * inversé, `life` = 1) — le seul mouvement qui ignore la gravité.
   *
   * L'ordre de parcours du disque suit le sens du champ : les grains qui
   * arrivent les premiers doivent trouver la place libre. En attirant on part
   * donc du centre, en repoussant du bord — exactement comme le souffle.
   */
  private updateMagnet(i: number, x: number, y: number): void {
    const cells = disc(PULL);
    const push = this.life[i] === 1 ? 1 : -1;
    for (let k = 0; k < cells.length; k++) {
      const [dx, dy] = cells[push === 1 ? k : cells.length - 1 - k];
      if (dx === 0 && dy === 0) continue;
      if (!this.inBounds(x + dx, y + dy)) continue;
      const at = this.index(x + dx, y + dy);
      if (this.cells[at] !== FILINGS || this.frozen[at]) continue;
      this.tryMove(at, x + dx + push * Math.sign(dx), y + dy + push * Math.sign(dy), FILINGS);
    }
  }

  /** Changement d'état sur place ; la température, elle, ne se réinitialise pas. */
  private convert(i: number, into: MaterialId): void {
    this.cells[i] = into;
    this.life[i] = MATERIALS[into].life ?? 0;
  }

  private *neighbors(x: number, y: number): Generator<[number, number]> {
    yield [x, y - 1];
    yield [x, y + 1];
    yield [x - 1, y];
    yield [x + 1, y];
  }
}
