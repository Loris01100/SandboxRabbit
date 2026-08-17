import {
  ACID, EMPTY, FIRE, LAVA, MATERIALS, PLANT, SAND, SMOKE, STEAM, STONE, WATER, WOOD,
  type MaterialId,
} from "./materials";

/**
 * Automate cellulaire type « falling sand ».
 *
 * Trois tableaux plats de la taille de la grille :
 *  - `cells` : l'identifiant du matériau
 *  - `life`  : compteur de vie (feu, fumée, vapeur)
 *  - `clock` : parité de la frame où la cellule a déjà bougé (évite qu'une
 *              cellule descende plusieurs fois dans le même tick)
 *
 * Le balayage part du bas et alterne le sens en x d'une frame à l'autre, sinon
 * la matière dérive visiblement vers la gauche.
 */
export class Engine {
  readonly width: number;
  readonly height: number;
  readonly cells: Uint8Array;
  readonly life: Uint8Array;
  private readonly clock: Uint8Array;
  private parity = 0;
  /** Bruit fixe par cellule : donne du grain sans scintiller. */
  readonly noise: Int8Array;

  constructor(width: number, height: number) {
    this.width = width;
    this.height = height;
    const n = width * height;
    this.cells = new Uint8Array(n);
    this.life = new Uint8Array(n);
    this.clock = new Uint8Array(n);
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
    this.life[i] = MATERIALS[id].life ?? 0;
  }

  clear(): void {
    this.cells.fill(EMPTY);
    this.life.fill(0);
  }

  /** Dépose un disque de matière (pinceau). */
  paint(cx: number, cy: number, radius: number, id: MaterialId, density = 1): void {
    const r2 = radius * radius;
    for (let y = cy - radius; y <= cy + radius; y++) {
      for (let x = cx - radius; x <= cx + radius; x++) {
        const dx = x - cx, dy = y - cy;
        if (dx * dx + dy * dy > r2) continue;
        if (!this.inBounds(x, y)) continue;
        if (density < 1 && Math.random() > density) continue;
        this.set(x, y, id);
      }
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
    this.clock[a] = this.parity;
    this.clock[b] = this.parity;
  }

  /** Tente le déplacement vers (x,y) ; renvoie true si la cellule a bougé. */
  private tryMove(from: number, x: number, y: number, id: MaterialId): boolean {
    if (!this.inBounds(x, y)) return false;
    const to = this.index(x, y);
    if (!this.displaces(id, this.cells[to])) return false;
    this.swap(from, to);
    return true;
  }

  step(): void {
    this.parity ^= 1;
    const { width: w, height: h } = this;
    const leftToRight = this.parity === 0;
    for (let y = h - 1; y >= 0; y--) {
      for (let k = 0; k < w; k++) {
        const x = leftToRight ? k : w - 1 - k;
        const i = y * w + x;
        const id = this.cells[i];
        if (id === EMPTY) continue;
        if (this.clock[i] === this.parity) continue;
        this.clock[i] = this.parity;
        this.update(i, x, y, id);
      }
    }
  }

  private update(i: number, x: number, y: number, id: MaterialId): void {
    switch (id) {
      case FIRE: this.updateFire(i, x, y); return;
      case LAVA: this.updateLava(i, x, y); return;
      case ACID: this.updateAcid(i, x, y); return;
      case PLANT: this.updatePlant(x, y); return;
    }
    switch (MATERIALS[id].kind) {
      case "powder": this.updatePowder(i, x, y, id); return;
      case "liquid": this.updateLiquid(i, x, y, id); return;
      case "gas": this.updateGas(i, x, y, id); return;
      default: return; // static
    }
  }

  private updatePowder(i: number, x: number, y: number, id: MaterialId): void {
    if (this.tryMove(i, x, y + 1, id)) return;
    const dir = Math.random() < 0.5 ? 1 : -1;
    if (this.tryMove(i, x + dir, y + 1, id)) return;
    this.tryMove(i, x - dir, y + 1, id);
  }

  private updateLiquid(i: number, x: number, y: number, id: MaterialId): void {
    if (this.tryMove(i, x, y + 1, id)) return;
    const dir = Math.random() < 0.5 ? 1 : -1;
    if (this.tryMove(i, x + dir, y + 1, id)) return;
    if (this.tryMove(i, x - dir, y + 1, id)) return;
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
    const dir = Math.random() < 0.5 ? 1 : -1;
    if (Math.random() < 0.7 && this.tryMove(i, x, y - 1, id)) return;
    if (this.tryMove(i, x + dir, y - 1, id)) return;
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
      if (this.get(nx, ny) === WATER) {
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
      if (n === WATER) {
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
      const chance = MATERIALS[this.get(nx, ny)]?.flammable;
      if (chance && Math.random() < chance * boost) this.set(nx, ny, FIRE);
    }
  }

  private updateAcid(i: number, x: number, y: number): void {
    for (const [nx, ny] of this.neighbors(x, y)) {
      const n = this.get(nx, ny);
      const dissolvable = n === STONE || n === WOOD || n === SAND || n === PLANT;
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
    if (this.get(x + dx, y - 1) === EMPTY && Math.random() < 0.5) this.set(x + dx, y - 1, PLANT);
  }

  private *neighbors(x: number, y: number): Generator<[number, number]> {
    yield [x, y - 1];
    yield [x, y + 1];
    yield [x - 1, y];
    yield [x + 1, y];
  }
}
