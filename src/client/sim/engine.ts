import {
  ACID, BATTERY, C4, CANDLE, EMBER, EMPTY, FIRE, GLASS, ICE, LAVA, MATERIALS, METAL,
  MINE, NANITE, NITRO, PLANT, SALT, SALTWATER, SAND, SEED, SMOKE, SOURCE, SPARK, STEAM,
  STONE, SWITCH, THERMITE, TNT, WATER, WOOD, type MaterialId,
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
  readonly temp: Float32Array;
  private readonly tempNext: Float32Array;
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
  /** Matière émise par les cellules `SOURCE` déposées ensuite. */
  emit: MaterialId = WATER;

  constructor(width: number, height: number) {
    this.width = width;
    this.height = height;
    const n = width * height;
    this.cells = new Uint8Array(n);
    this.life = new Uint8Array(n);
    this.temp = new Float32Array(n).fill(AMBIENT);
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

  clear(): void {
    this.cells.fill(EMPTY);
    this.life.fill(0);
    this.frozen.fill(0);
    this.temp.fill(AMBIENT);
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
      this.set(i % this.width, (i / this.width) | 0, id);
      const cx = i % this.width;
      if (cx > 0) stack.push(i - 1);
      if (cx < this.width - 1) stack.push(i + 1);
      if (i >= this.width) stack.push(i - this.width);
      if (i < this.cells.length - this.width) stack.push(i + this.width);
    }
  }

  /** Une cellule pleine peut-elle prendre la place d'une autre ? */
  private displaces(moverId: MaterialId, targetId: MaterialId): boolean {
    if (targetId === EMPTY) return true;
    const target = MATERIALS[targetId];
    if (target.kind === "static" || target.kind === "powder") return false;
    return MATERIALS[moverId].density > target.density;
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
      case SALT: this.updateSalt(i, x, y); return;
      case SEED: this.updateSeed(i, x, y); return;
      case NANITE: this.updateNanite(i, x, y); return;
      case SOURCE: this.updateSource(i, x, y); return;
      case CANDLE: this.updateCandle(i, x, y); return;
      case BATTERY: this.updateBattery(i, x, y); return;
      case SWITCH: this.updateSwitch(i, x, y); return;
      case EMBER: this.updateEmber(i, x, y); return;
      case SPARK: this.updateSpark(i, x, y); return;
      // Le métal ne fait que sortir de sa période de repos.
      case METAL: if (this.life[i] > 0) this.life[i]--; return;
    }
    switch (MATERIALS[id].kind) {
      case "powder": this.updatePowder(i, x, y, id); return;
      case "liquid": this.updateLiquid(i, x, y, id); return;
      case "gas": this.updateGas(i, x, y, id); return;
      default: return; // static
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
        this.set(nx, ny, STEAM);
        this.set(x, y, STEAM);
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
        this.set(nx, ny, STEAM);
        this.set(x, y, STONE);
        return;
      }
      if (n === SAND && Math.random() < 0.01) this.set(nx, ny, LAVA);
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
      this.set(nx, ny, n === WOOD && Math.random() < 0.5 ? EMBER : FIRE);
    }
  }

  private updateAcid(i: number, x: number, y: number): void {
    for (const [nx, ny] of this.neighbors(x, y)) {
      const n = this.get(nx, ny);
      const dissolvable = n === STONE || n === WOOD || n === SAND || n === PLANT
        || n === GLASS || n === ICE || n === SEED;
      if (dissolvable && Math.random() < 0.06) {
        this.set(nx, ny, EMPTY);
        if (Math.random() < 0.5) { this.set(x, y, SMOKE); return; } // l'acide s'use
      }
    }
    this.updateLiquid(i, x, y, ACID);
  }

  private updatePlant(x: number, y: number): void {
    if (Math.random() > 0.08) return;
    let drank = false;
    for (const [nx, ny] of this.neighbors(x, y)) {
      if (this.get(nx, ny) === WATER) { this.set(nx, ny, PLANT); drank = true; break; }
    }
    if (!drank) return;
    // Une pousse peut partir vers le haut ou en biais.
    const dx = (Math.random() * 3 | 0) - 1;
    const up = y - this.gravity;
    if (this.get(x + dx, up) === EMPTY && Math.random() < 0.5) this.set(x + dx, up, PLANT);
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

  /** Souffle un disque : la moitié part en flammes, le reste est pulvérisé. */
  explode(cx: number, cy: number, radius = 7): void {
    const r2 = radius * radius;
    for (let y = cy - radius; y <= cy + radius; y++) {
      for (let x = cx - radius; x <= cx + radius; x++) {
        const dx = x - cx, dy = y - cy;
        if (dx * dx + dy * dy > r2 || !this.inBounds(x, y)) continue;
        // Une charge voisine survit à la déflagration et part au tick suivant :
        // le TNT par le feu qu'on vient de semer, le C4 amorcé par `life`.
        const j = this.index(x, y);
        if ((this.cells[j] === TNT || this.cells[j] === C4) && (dx !== 0 || dy !== 0)) {
          if (this.cells[j] === C4) this.life[j] = 1;
          continue;
        }
        this.set(x, y, Math.random() < 0.5 ? FIRE : EMPTY);
      }
    }
  }

  /** Le sel se dissout dans l'eau et fait fondre la glace. */
  private updateSalt(i: number, x: number, y: number): void {
    for (const [nx, ny] of this.neighbors(x, y)) {
      const n = this.get(nx, ny);
      if (n === WATER) { this.set(nx, ny, SALTWATER); this.set(x, y, EMPTY); return; }
      if (n === ICE && Math.random() < 0.25) { this.set(nx, ny, WATER); this.set(x, y, EMPTY); return; }
    }
    this.updatePowder(i, x, y, SALT);
  }

  private updateSeed(i: number, x: number, y: number): void {
    for (const [nx, ny] of this.neighbors(x, y)) {
      if (this.get(nx, ny) === WATER) { this.set(x, y, PLANT); return; }
    }
    this.updatePowder(i, x, y, SEED);
  }

  /** Gelée grise : dévore un voisin, se réplique, puis meurt de vieillesse. */
  private updateNanite(i: number, x: number, y: number): void {
    if (this.decay(i, NANITE, EMPTY)) return;
    for (const [nx, ny] of this.neighbors(x, y)) {
      const n = this.get(nx, ny);
      if (n === EMPTY || n === NANITE || n === GLASS || n === SOURCE) continue;
      if (Math.random() < 0.2) { this.set(nx, ny, NANITE); break; }
    }
    this.updatePowder(i, x, y, NANITE);
  }

  /** Générateur : crache sa matière (stockée dans `life`) dans la case libre voisine. */
  private updateSource(i: number, x: number, y: number): void {
    if (Math.random() > 0.5) return;
    const id = this.life[i] || WATER;
    const dy = MATERIALS[id].kind === "gas" ? -this.gravity : this.gravity;
    if (this.get(x, y + dy) === EMPTY) this.set(x, y + dy, id);
  }

  /** Bougie : `life` sert de mèche allumée. Une fois prise, elle réalimente sa flamme. */
  private updateCandle(i: number, x: number, y: number): void {
    for (const [nx, ny] of this.neighbors(x, y)) {
      const n = this.get(nx, ny);
      if (n === FIRE || n === LAVA || n === EMBER || n === SPARK) this.life[i] = 1;
      else if (n === WATER || n === SALTWATER) this.life[i] = 0;
    }
    const up = y - this.gravity;
    if (this.life[i] === 1 && this.get(x, up) === EMPTY) this.set(x, up, FIRE);
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
  // ponytail: trois balayages pleins par tick (~1,3 ms en 320×180) ; si ça
  // devient le budget limitant, fusionner les passes ou n'en faire qu'une sur deux.
  private thermal(): void {
    const { width: w, height: h, cells, temp, tempNext } = this;
    for (let i = 0; i < cells.length; i++) {
      const heat = MATERIALS[cells[i]].heat;
      // Une source tire vers sa température sans l'imposer : une flamme peut
      // encore faire fondre la glace qu'elle touche.
      if (heat !== undefined) temp[i] += (heat - temp[i]) * 0.5;
    }
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        const t = temp[i];
        const sum =
          (y > 0 ? temp[i - w] : t) + (y < h - 1 ? temp[i + w] : t) +
          (x > 0 ? temp[i - 1] : t) + (x < w - 1 ? temp[i + 1] : t);
        tempNext[i] = t + CONDUCTION * (sum - 4 * t) + COOLING * (AMBIENT - t);
      }
    }
    temp.set(tempNext);
    for (let i = 0; i < cells.length; i++) {
      const m = MATERIALS[cells[i]];
      if (m.boil && temp[i] > m.boil.at) this.convert(i, m.boil.into);
      else if (m.freeze && temp[i] < m.freeze.at) this.convert(i, m.freeze.into);
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
