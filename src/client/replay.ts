/**
 * Le rejeu : une partie décrite par son point de départ et ce qu'on y a fait.
 *
 * Le moteur ne tire au sort que par `engine.rand()` (xorshift semé) et toute
 * modification de la grille passe par un `Gesture` : il suffit donc de garder
 * la grille de départ, l'état du tirage, et la liste des gestes avec le numéro
 * de tick où ils sont tombés. Quelques kilo-octets rejouent une partie entière,
 * au pixel près — et la même fonction sert au test de non-régression (test/sim.ts).
 *
 * Ce module ne touche ni au DOM ni au bac affiché : le moteur est passé en
 * argument, donc Node peut le charger tel quel.
 */
import { type Engine } from "./sim/engine.ts";
import { applyGesture, weather, type Gesture } from "./gestures.ts";
import { decode, decodeFrozen, decodeLife, decodeTemp, encode } from "./sim/codec.ts";
import { type MaterialId } from "./sim/materials.ts";

/** Les réglages de scène qui changent la simulation (pas le rendu). */
export interface Scene {
  wind: number;
  ambient: number;
  gravity: 1 | -1;
  emit: MaterialId;
  weather: boolean;
}

/**
 * Ce qui arrive à un tick donné : un geste, un changement de réglage, ou une
 * grille posée d'un coup (annulation, chargement d'un monde, décor tiré au
 * sort — tout ce qui ne passe pas par un geste).
 */
export type Beat =
  | { at: number; g: Gesture }
  | { at: number; scene: Scene }
  | { at: number; grid: string; clock: string };

export interface Recording {
  /** Version du format : un enregistrement d'hier ne se rejoue pas au hasard. */
  v: 1;
  w: number;
  h: number;
  /** État du tirage au sort au premier tick — pas la graine du constructeur. */
  seed: number;
  /** Sens du balayage au premier tick. */
  scan: number;
  /** La grille de départ, état vivant compris (même format que les mondes). */
  grid: string;
  /** `clock`, à part : le codec des mondes ne le connaît pas. */
  clock: string;
  scene: Scene;
  beats: Beat[];
  /** Nombre de ticks enregistrés. */
  ticks: number;
}

const sceneOf = (e: Engine, rain: boolean): Scene => ({
  wind: e.wind, ambient: e.ambient, gravity: e.gravity, emit: e.emit, weather: rain,
});

const same = (a: Scene, b: Scene): boolean =>
  a.wind === b.wind && a.ambient === b.ambient && a.gravity === b.gravity && a.emit === b.emit && a.weather === b.weather;

/**
 * La grille et son état vivant : un incendie enregistré repart chaud.
 *
 * Le codec arrondit les températures par pas de 8 °C, donc l'enregistrement ne
 * peut pas repartir *exactement* de ce que le bac avait : on lui impose plutôt
 * l'arrondi, en relisant aussitôt ce qu'on vient d'écrire. Le bac tiède d'un
 * degré ou deux, personne ne le voit — un rejeu qui diverge au premier
 * changement d'état, si. C'est déjà ce que subit un monde sauvegardé puis relu.
 */
function snap(e: Engine): { grid: string; clock: string } {
  const grid = encode(e.cells, e.frozen, e.life, e.temp);
  const clock = encode(e.clock);
  put(e, grid, clock, e.ambient);
  return { grid, clock };
}

/** Pose une grille encodée dans le moteur, comme au chargement d'un monde. */
function put(e: Engine, grid: string, clock: string, ambient: number): void {
  const n = e.cells.length;
  e.clock.set(decode(clock, n));
  e.adopt(decode(grid, n));
  e.frozen.set(decodeFrozen(grid, n));
  e.life.set(decodeLife(grid, n) ?? new Uint8Array(n));
  e.temp.set(decodeTemp(grid, n) ?? new Float32Array(n).fill(ambient));
}

function apply(e: Engine, s: Scene): void {
  e.wind = s.wind;
  e.ambient = s.ambient;
  e.gravity = s.gravity;
  e.emit = s.emit;
}

/**
 * L'enregistreur. Il ne lit pas le moteur à chaque tick — trop cher, et
 * inutile : les gestes lui sont poussés, les réglages sont comparés (cinq
 * nombres), et le reste (annuler, vider, charger) le prévient par `stamp()`.
 */
export class Recorder {
  readonly rec: Recording;
  private engine: Engine;

  constructor(engine: Engine, rain: boolean) {
    this.engine = engine;
    this.rec = {
      v: 1, w: engine.width, h: engine.height,
      seed: engine.seed, scan: engine.scan,
      ...snap(engine), scene: sceneOf(engine, rain),
      beats: [], ticks: 0,
    };
  }

  /** Un geste vient d'être appliqué au bac. */
  gesture(g: Gesture): void {
    this.rec.beats.push({ at: this.rec.ticks, g });
  }

  /** La grille a changé sans geste : on la garde en entier (c'est rare). */
  stamp(): void {
    this.rec.beats.push({ at: this.rec.ticks, ...snap(this.engine) });
  }

  /** À appeler **juste avant** `engine.step()`, météo comprise. */
  tick(rain: boolean): void {
    const now = sceneOf(this.engine, rain);
    const last = this.scene();
    if (!same(now, last)) this.rec.beats.push({ at: this.rec.ticks, scene: now });
    this.rec.ticks++;
  }

  /** Les derniers réglages connus : le dernier `scene` posé, sinon ceux du départ. */
  private scene(): Scene {
    for (let i = this.rec.beats.length - 1; i >= 0; i--) {
      const b = this.rec.beats[i];
      if ("scene" in b) return b.scene;
    }
    return this.rec.scene;
  }

  /** Poids approximatif de l'enregistrement, en octets. */
  get size(): number {
    return JSON.stringify(this.rec).length;
  }
}

/**
 * Le lecteur. Il rejoue **dans le moteur qu'on lui donne** — celui du bac pour
 * regarder, un moteur neuf pour vérifier. La grille doit être à la bonne
 * taille : `rewind()` la refuse sinon.
 */
export class Player {
  readonly rec: Recording;
  readonly engine: Engine;
  /** Le tick à jouer au prochain `step()`. */
  tick = 0;
  private at = 0;
  private scene: Scene;

  constructor(rec: Recording, engine: Engine) {
    if (rec.w !== engine.width || rec.h !== engine.height) throw new Error("Rejeu fait pour une autre taille de grille.");
    this.rec = rec;
    this.engine = engine;
    this.scene = rec.scene;
    engine.seed = rec.seed;
    engine.scan = rec.scan;
    put(engine, rec.grid, rec.clock, rec.scene.ambient);
    apply(engine, rec.scene);
  }

  /** Joue un tick. Renvoie false quand l'enregistrement est fini. */
  step(): boolean {
    // Les beats sont poussés dans l'ordre des ticks : un simple curseur suffit.
    while (this.at < this.rec.beats.length && this.rec.beats[this.at].at === this.tick) {
      const b = this.rec.beats[this.at++];
      if ("g" in b) applyGesture(this.engine, b.g);
      else if ("scene" in b) { this.scene = b.scene; apply(this.engine, b.scene); }
      else put(this.engine, b.grid, b.clock, this.scene.ambient);
    }
    if (this.tick >= this.rec.ticks) return false;
    if (this.scene.weather) weather(this.engine);
    this.engine.step();
    this.tick++;
    return true;
  }
}
