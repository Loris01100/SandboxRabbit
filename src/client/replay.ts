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
import { decode, decodeFrozen, decodeLife, decodeNames, decodeTemp, encode } from "./sim/codec.ts";
import { MATERIALS, type MaterialId } from "./sim/materials.ts";

/** Les réglages de scène qui changent la simulation (pas le rendu). */
export interface Scene {
  wind: number;
  ambient: number;
  gravity: 1 | -1;
  emit: MaterialId;
  /** Niveau de météo (gestures.ts) ; un booléen dans les enregistrements d'avant l'orage. */
  weather: number | boolean;
  /**
   * Commandes du héros tenues (`engine.pilot`). Ses changements arrivent par
   * gestes ; il est ici pour le départ — un enregistrement lancé touche
   * enfoncée repartait sinon à l'arrêt. Absent des enregistrements d'avant.
   */
  pilot?: number;
  /**
   * Numéro du héros piloté (`engine.chosen`) : seul lui obéit à `pilot`. Absent
   * dans un enregistrement d'avant — le moteur prend alors le premier héros.
   */
  chosen?: number;
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

const sceneOf = (e: Engine, rain: number): Scene => ({
  wind: e.wind, ambient: e.ambient, gravity: e.gravity, emit: e.emit, weather: rain, pilot: e.pilot, chosen: e.chosen,
});

const same = (a: Scene, b: Scene): boolean =>
  a.wind === b.wind && a.ambient === b.ambient && a.gravity === b.gravity && a.emit === b.emit && a.weather === b.weather
  && (a.pilot ?? 0) === (b.pilot ?? 0) && (a.chosen ?? 0) === (b.chosen ?? 0);

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
  const grid = encode(e.cells, e.frozen, e.life, e.temp, e.names);
  // `flags` entre deux ticks, c'est l'horloge seule : `F_HELD` y est à zéro
  // partout (`release()` l'a rendu). Les octets sont ceux qu'écrivait le
  // tableau `clock` d'avant — un enregistrement d'alors se rejoue tel quel.
  const clock = encode(e.flags);
  put(e, grid, clock, e.ambient);
  return { grid, clock };
}

/**
 * Pose une grille encodée dans le moteur, comme au chargement d'un monde.
 * `clock` n'existe que pour un rejeu : un monde de la galerie n'en a pas, et la
 * grille se pose alors sur l'horloge en place (null).
 */
export function put(e: Engine, grid: string, clock: string | null, ambient: number): void {
  const n = e.cells.length;
  if (clock !== null) e.flags.set(decode(clock, n));
  e.adopt(decode(grid, n));
  e.frozen.set(decodeFrozen(grid, n));
  e.life.set(decodeLife(grid, n) ?? new Uint8Array(n));
  e.temp.set(decodeTemp(grid, n) ?? new Float32Array(n).fill(ambient));
  e.names = decodeNames(grid);
}

function apply(e: Engine, s: Scene): void {
  e.wind = s.wind;
  e.ambient = s.ambient;
  e.gravity = s.gravity;
  e.emit = s.emit;
  applyGesture(e, { t: "pilot", keys: s.pilot ?? 0 });
  // Retrouvé par son numéro au tick suivant : `hero`, un index, n'est pas dans la scène.
  e.chosen = int(s.chosen) && s.chosen > 0 && s.chosen < 256 ? s.chosen : 0;
}

/**
 * L'enregistreur. Il ne lit pas le moteur à chaque tick — trop cher, et
 * inutile : les gestes lui sont poussés, les réglages sont comparés (cinq
 * nombres), et le reste (annuler, vider, charger) le prévient par `stamp()`.
 */
export class Recorder {
  readonly rec: Recording;
  private engine: Engine;

  constructor(engine: Engine, rain: number) {
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
  tick(rain: number): void {
    const now = sceneOf(this.engine, rain);
    const last = this.scene();
    if (!same(now, last)) this.rec.beats.push({ at: this.rec.ticks, scene: now });
    this.rec.ticks++;
  }

  /**
   * Rend les beats accumulés et les oublie : c'est le salon qui s'en sert, il
   * les diffuse au fil de l'eau plutôt que de garder la partie entière. Les
   * derniers réglages passent dans `rec.scene`, sinon `tick()` les croirait
   * changés et en pousserait un beat à chaque tick.
   */
  drain(): Beat[] {
    const beats = this.rec.beats;
    this.rec.scene = this.scene();
    this.rec.beats = [];
    return beats;
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

  /**
   * La suite d'une partie qui se joue ailleurs (salon) : l'enregistrement
   * s'allonge pendant qu'on le rejoue. Les beats déjà joués sont jetés, sinon
   * un invité garderait toute la séance en mémoire.
   */
  feed(beats: Beat[], ticks: number): void {
    this.rec.beats.splice(0, this.at);
    this.at = 0;
    this.rec.beats.push(...beats);
    this.rec.ticks = ticks;
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
    weather(this.engine, +this.scene.weather);
    this.engine.step();
    this.tick++;
    return true;
  }
}

/* ----------------------------------------------- classement des défis */

/**
 * Ticks au plus d'une partie de défi recevable au classement : cinq minutes à
 * 60 ticks par seconde. Chaque visiteur rejoue chaque record pour le vérifier
 * (sim/verdict.ts) : sans plafond, un rejeu d'une heure le tenait une minute.
 * Le Worker garde le même plafond (`TRIAL_TICKS` d'app.ts).
 */
export const TRIAL_TICKS = 5 * 60 * 60;

/**
 * Une partie de défi recevable au classement : dans le bac des défis
 * (320×180), sous `TRIAL_TICKS`, et jouée au pinceau — ni grille posée d'un
 * coup (annuler, rétablir : un beat `grid`), ni morceau collé (`clip`).
 * L'un comme l'autre peut poser n'importe quelle grille, celle d'un défi déjà
 * gagné comprise : le rejeu ne prouverait plus rien.
 */
export function fair(rec: Recording): boolean {
  if (rec.w !== 320 || rec.h !== 180 || rec.ticks < 1 || rec.ticks > TRIAL_TICKS) return false;
  return rec.beats.every((b) => !("grid" in b) && !("g" in b && b.g.t === "clip"));
}

/* ------------------------------------------------------ export et import */

/** Le plus grand bac du sélecteur : un rejeu plus grand ne vient pas d'ici. */
const CELLS_MAX = 1920 * 1080;
/**
 * Poids maximal d'un rejeu importé, JSON décompressé, en octets. Une partie de
 * dix minutes en pèse quelques dizaines de kilo-octets ; sans plafond, un lien
 * de quelques kilo-octets pouvait se décompresser en gigaoctets.
 */
export const FILM_MAX = 8 * 1024 * 1024;

type Field = "n" | "b" | "s";
/** Les champs de chaque geste et leur type : nombre fini, booléen, texte. */
const FIELDS: Record<Gesture["t"], Record<string, Field>> = {
  paint: { x: "n", y: "n", r: "n", id: "n", d: "n", over: "b" },
  fill: { x: "n", y: "n", id: "n" },
  rect: { x: "n", y: "n", x2: "n", y2: "n", id: "n", over: "b" },
  frozen: { x: "n", y: "n", r: "n", on: "b" },
  toggle: { x: "n", y: "n" },
  clip: { x: "n", y: "n", w: "n", h: "n", cells: "s", life: "s" },
  pilot: { keys: "n" },
  hero: {},
  name: { id: "n", name: "s" },
};

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const int = (v: unknown): v is number => Number.isSafeInteger(v);
const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const typed = (v: unknown, f: Field): boolean => (f === "n" ? finite(v) : f === "b" ? typeof v === "boolean" : typeof v === "string");

/**
 * Une grille encodée qu'on saura poser : `atob` lève sur un caractère hors
 * base64, et une levée au milieu d'un rejeu arrêterait le bac en plein tick.
 */
function readable(data: unknown, n: number): data is string {
  if (typeof data !== "string") return false;
  try {
    decode(data, n); decodeFrozen(data, n); decodeLife(data, n); decodeTemp(data, n);
    return true;
  } catch {
    return false;
  }
}

function isScene(s: unknown): s is Scene {
  return isObject(s) && finite(s.wind) && finite(s.ambient) && (s.gravity === 1 || s.gravity === -1)
    && int(s.emit) && MATERIALS[s.emit as MaterialId] !== undefined && (typeof s.weather === "boolean" || (int(s.weather) && s.weather >= 0 && s.weather <= 3))
    && (s.pilot === undefined || int(s.pilot)) && (s.chosen === undefined || int(s.chosen));
}

/**
 * Un geste qu'`applyGesture` saura appliquer sans lever. Il écarte déjà les
 * coordonnées non entières et les ids inconnus, et `disc()` borne les rayons :
 * reste à garantir les types, et un morceau collé lisible.
 */
export function isGesture(g: unknown, n: number): g is Gesture {
  if (!isObject(g) || typeof g.t !== "string" || !Object.hasOwn(FIELDS, g.t)) return false;
  const fields = FIELDS[g.t as Gesture["t"]];
  for (const k in fields) if (!typed(g[k], fields[k])) return false;
  if (g.t === "paint" && g.only !== undefined && !finite(g.only)) return false;
  if (g.t === "clip" && int(g.w) && int(g.h) && g.w * g.h > 0 && g.w * g.h <= n) {
    return readable(g.cells, g.w * g.h) && readable(g.life, g.w * g.h);
  }
  return true;
}

/**
 * Passe au crible un enregistrement venu d'ailleurs (lien, fichier) : rendu
 * tel quel s'il se rejoue sans lever, null sinon. C'est une partie qu'on n'a
 * pas jouée, rejouée dans notre bac : comme une grille de la galerie, `adopt()`
 * en écartera les ids inconnus à la pose — ici on s'assure qu'aucun champ ne
 * fera tomber le `Player` en route.
 */
export function vet(raw: unknown): Recording | null {
  if (!isObject(raw) || raw.v !== 1) return null;
  const { w, h, seed, scan, grid, clock, scene, beats, ticks } = raw;
  if (!int(w) || !int(h) || w <= 0 || h <= 0 || w * h > CELLS_MAX) return null;
  const n = w * h;
  if (!int(seed) || !int(scan) || !int(ticks) || ticks < 0) return null;
  if (!readable(grid, n) || !readable(clock, n) || !isScene(scene) || !vetBeats(beats, n, ticks)) return null;
  return { v: 1, w, h, seed, scan, grid, clock, scene, beats, ticks };
}

/**
 * Des beats que le `Player` jouera sans lever, pour une grille de `n`
 * cellules. À part de `vet()` pour la suite de partie d'un hôte de salon
 * (`turn`), qui arrive vingt fois par seconde : revérifier chaque fois la
 * grille de départ coûterait un décodage entier.
 */
export function vetBeats(beats: unknown, n: number, ticks: number): beats is Beat[] {
  if (!Array.isArray(beats)) return false;
  // Le lecteur avance un curseur : des beats dans le désordre seraient sautés.
  let last = 0;
  for (const b of beats as unknown[]) {
    if (!isObject(b) || !int(b.at) || b.at < last || b.at > ticks) return false;
    last = b.at;
    if ("g" in b) { if (!isGesture(b.g, n)) return false; }
    else if ("scene" in b) { if (!isScene(b.scene)) return false; }
    else if (!readable(b.grid, n) || !readable(b.clock, n)) return false;
  }
  return true;
}

/** Un rejeu en fichier : le JSON tel quel. Null s'il est trop lourd, illisible ou mal formé. */
export function parse(json: string): Recording | null {
  if (json.length > FILM_MAX) return null;
  try {
    return vet(JSON.parse(json));
  } catch {
    return null;
  }
}

/**
 * Un rejeu pour un lien : le JSON compressé (deflate, natif du navigateur),
 * en base64 url comme les grilles du codec. Le JSON répète ses clés à chaque
 * geste : la compression le ramène à peu près au poids de la grille de départ.
 */
export async function pack(rec: Recording): Promise<string> {
  const stream = new Blob([JSON.stringify(rec)]).stream().pipeThrough(new CompressionStream("deflate-raw"));
  const bytes = new Uint8Array(await new Response(stream).arrayBuffer());
  let binary = "";
  for (let i = 0; i < bytes.length; i += 4096) binary += String.fromCodePoint(...bytes.subarray(i, i + 4096));
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

/** L'inverse de `pack()`, plafonné à `FILM_MAX` pendant la décompression. Null si le lien est abîmé. */
export async function unpack(text: string): Promise<Recording | null> {
  try {
    const binary = atob(text.replaceAll("-", "+").replaceAll("_", "/"));
    const bytes = Uint8Array.from(binary, (c) => c.codePointAt(0)!);
    const reader = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("deflate-raw")).getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > FILM_MAX) { await reader.cancel(); return null; }
      chunks.push(value);
    }
    return parse(await new Blob(chunks as ConstructorParameters<typeof Blob>[0]).text());
  } catch {
    return null;
  }
}
