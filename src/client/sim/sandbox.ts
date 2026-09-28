/**
 * Le bac, côté simulation : moteur, rendu, annulation, défis, enregistrement.
 *
 * Tout ce fichier tourne dans un Worker (sim/worker.ts) — le fil principal ne
 * simule plus rien, il envoie des ordres et reçoit des nouvelles. Le seul
 * intérêt : une explosion en 640×360 ne bloque plus le panneau, le zoom ni le
 * pinceau, qui vivent sur l'autre fil.
 *
 * Rien ici ne touche au DOM ni aux API de Worker (`postMessage` est un rappel
 * passé au constructeur) : Node peut donc le charger tel quel, et
 * test/sandbox.ts fait jouer le protocole sans navigateur.
 */
import { Engine } from "./engine.ts";
import { Tracker, type Patch } from "./render.ts";
import { encode } from "./codec.ts";
import { HERO, SAND, STONE, WATER, type MaterialId } from "./materials.ts";
import { applyGesture, weather, type Gesture } from "../gestures.ts";
import { Player, Recorder, put, type Beat, type Recording } from "../replay.ts";
import { CHALLENGES, SCENES, count } from "../challenges.ts";
import { SEEDS, terrain } from "../terrain.ts";
import { parseGoal, ticksFor } from "../ui.ts";

/** Les réglages du bac. Le panneau en est la source, le bac ne les invente pas. */
export interface Knobs {
  wind: number;
  ambient: number;
  gravity: 1 | -1;
  emit: MaterialId;
  weather: boolean;
  /** Ticks par 60e de seconde (0,25 à 4). */
  speed: number;
  running: boolean;
  heatmap: boolean;
}

export interface Turn {
  ticks: number;
  beats: Beat[];
  sums: [number, number][];
}

export type Order =
  | { t: "do"; g: Gesture }
  | { t: "set"; k: Partial<Knobs> }
  | { t: "size"; w: number; h: number; keep: boolean }
  | { t: "load"; data: string; ask?: number; quiet?: boolean }
  | { t: "edit"; do: "clear" | "undo" | "redo" | "step" | "snapshot" }
  | { t: "scene"; name: string }
  | { t: "terrain"; seed: number }
  | { t: "goal"; goal: string | null }
  | { t: "cursor"; x: number; y: number }
  | { t: "clip"; ask: number; x: number; y: number; x2: number; y2: number }
  | { t: "rec"; on: boolean }
  | { t: "play"; on: boolean }
  | { t: "host"; on: boolean }
  | { t: "follow"; rec: Recording | null }
  | ({ t: "turn" } & Turn);

export type News =
  | { t: "frame"; patches: Patch[]; w: number; h: number; ambient: number; probe: [MaterialId, number] | null; hero: [number, number] | null }
  | { t: "stats"; filled: number }
  | { t: "grid"; full: string }
  | { t: "start"; rec: Recording }
  | ({ t: "turn" } & Turn)
  | { t: "desync" }
  | { t: "reply"; ask: number; value: unknown }
  | { t: "say"; text: string }
  | { t: "won" }
  | { t: "rec"; ticks: number; beats: number; size: number; w: number; h: number }
  | { t: "play"; on: boolean };

const UNDO_MAX = 10;
/**
 * Mémoire que les crans d'annulation peuvent prendre, en octets. Un cran copie
 * sept octets par cellule (matière, vie, figé, quatre de température) : 400 Ko
 * en 320×180, mais 14,5 Mo en 1920×1080, où dix crans et leurs rétablissements
 * pesaient près de 300 Mo. Les grandes grilles ont donc moins de crans.
 */
const UNDO_BYTES = 64 * 1024 * 1024;
type Snapshot = { cells: Uint8Array; life: Uint8Array; temp: Float32Array; frozen: Uint8Array };

const STATS = 500;
/**
 * Période de la grille encodée (`grid`), en ms.
 * ponytail: fixe quelle que soit la taille — l'encodage coûte 13 ms en
 * 1920×1080, qui s'ajoutent au tick quatre fois par seconde. L'espacer selon
 * la taille, ou n'encoder qu'à la demande (sauvegarde, lien, onglet masqué),
 * le jour où un gros incendie en grande grille saccade.
 */
const GRID = 250;
const TURN = 50;
const SUM = 60;
const CATCH_UP = 32;
/** Temps de simulation qu'une frame s'accorde, en ms : de quoi rendre et répondre sous 16,7 ms. */
const SLICE = 12;
const FOLLOW = "Vous suivez l'hôte : c'est lui qui mène le bac.";

function fingerprint(cells: Uint8Array): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < cells.length; i++) h = Math.imul(h ^ cells[i], 0x01000193);
  return h >>> 0;
}

export class Sandbox {
  engine: Engine;
  /** Les blocs changés depuis la frame d'avant, découpés pour la page qui les colorie. */
  tracker: Tracker;
  knobs: Knobs = {
    wind: 0, ambient: 20, gravity: 1, emit: WATER,
    weather: false, speed: 1, running: true, heatmap: false,
  };

  private send: (news: News) => void;
  private undoStack: Snapshot[] = [];
  private redoStack: Snapshot[] = [];
  private rec: Recorder | null = null;
  private film: Recording | null = null;
  private player: Player | null = null;
  /** Condition de victoire du défi en cours, lue deux fois par seconde. */
  private won: ((e: Engine) => boolean) | null = null;
  private cursor = { x: -1, y: -1 };
  /** Reliquat de tick quand la vitesse n'est pas entière (ralenti). */
  private pending = 0;
  private sinceStats = 0;
  private sinceGrid = 0;
  /**
   * Hôte d'un salon : la partie diffusée aux invités. C'est un enregistrement
   * comme un autre, vidé à chaque envoi — chaque invité simule de son côté en
   * la rejouant, et le moteur étant déterministe, tous voient le même bac.
   */
  private stream: Recorder | null = null;
  private sums: [number, number][] = [];
  private sinceTurn = 0;
  private sent = 0;
  private follower: Player | null = null;
  private checks = new Map<number, number>();
  private lost = false;

  constructor(width: number, height: number, send: (news: News) => void) {
    this.engine = new Engine(width, height);
    this.tracker = new Tracker(this.engine);
    this.send = send;
    seed(this.engine);
  }

  order(o: Order): void {
    if (this.follower && (o.t === "do" || o.t === "edit" || o.t === "scene" || o.t === "terrain" || o.t === "load"
      || o.t === "goal" || o.t === "rec" || o.t === "play")) {
      if (o.t !== "do" && !(o.t === "edit" && o.do === "snapshot")) this.send({ t: "say", text: FOLLOW });
      if (o.t === "load" && o.ask !== undefined) this.send({ t: "reply", ask: o.ask, value: false });
      return;
    }
    switch (o.t) {
      case "do":
        // Pendant un rejeu, le bac appartient à l'enregistrement : un geste de
        // plus ferait diverger la suite de ce qu'on est en train de regarder.
        if (this.player) return;
        applyGesture(this.engine, o.g);
        this.rec?.gesture(o.g);
        this.stream?.gesture(o.g);
        return;
      case "set": {
        Object.assign(this.knobs, o.k);
        const { wind, ambient, gravity, emit } = this.knobs;
        if (!this.follower) Object.assign(this.engine, { wind, ambient, gravity, emit });
        return;
      }
      case "host": return this.host(o.on);
      case "follow": return this.follow(o.rec);
      case "turn": {
        if (!this.follower) return;
        this.follower.feed(o.beats, o.ticks);
        for (const [at, sum] of o.sums) this.checks.set(at, sum);
        return;
      }
      case "size": return this.resize(o.w, o.h, o.keep);
      case "load": return this.load(o.data, o.ask, o.quiet);
      case "edit": return this.edit(o.do);
      case "scene": return this.scene(o.name);
      case "terrain": return this.world(o.seed);
      case "goal": {
        const goal = parseGoal(o.goal);
        this.won = goal
          ? (e) => (goal.op === "ge" ? count(e, goal.id) >= goal.n : count(e, goal.id) < goal.n)
          : null;
        return;
      }
      case "cursor":
        this.cursor = { x: o.x, y: o.y };
        return;
      case "clip": {
        const clip = this.engine.copy(o.x, o.y, o.x2, o.y2);
        // Renvoyé sous la forme qu'attend le geste « clip » : le fil principal
        // n'a plus qu'à le reposer tel quel au collage.
        this.send({
          t: "reply", ask: o.ask,
          value: { w: clip.width, h: clip.height, cells: encode(clip.cells, clip.frozen), life: encode(clip.life) },
        });
        return;
      }
      case "rec": return this.record(o.on);
      case "play": return this.play(o.on);
    }
  }

  /**
   * Avance le bac de `ms` millisecondes et peint une frame.
   *
   * Au plus `SLICE` ms de simulation par frame (`late()`) : au-delà, le retard
   * est abandonné, pas reporté. Sans ça, une frame lente en réclamait plus à
   * la suivante — en 1920×1080, un lac qui s'étale coûte 16 ms le tick, et la
   * boucle montait à huit ticks par frame, 130 ms entre deux images, le
   * pinceau autant en retard. Un bac trop chargé ralentit, il ne rame plus.
   */
  frame(ms: number): void {
    const budget = ticksFor(this.knobs.speed, ms, this.pending);
    this.pending = budget.pending;
    const start = performance.now();
    if (this.follower) {
      this.catchUp(this.follower, start);
    } else if (this.player) {
      // Un rejeu remplace la simulation : c'est lui qui avance le bac. La pause
      // l'arrête aussi — il avançait sans elle, et « Pas à pas » n'y pouvait rien.
      if (this.knobs.running) {
        for (let n = budget.ticks; n > 0; n--) {
          if (!this.player.step()) { this.play(false); break; }
          if (this.late(start)) break;
        }
      }
    } else if (this.knobs.running) {
      for (let n = budget.ticks; n > 0; n--) {
        this.tick();
        if (this.late(start)) break;
      }
    }

    const patches = this.tracker.take();
    const { width: w, height: h } = this.engine;
    const { x, y } = this.cursor;
    const at = this.engine.inBounds(x, y) ? this.engine.index(x, y) : -1;
    const probe: [MaterialId, number] | null =
      at < 0 ? null : [this.engine.cells[at] as MaterialId, this.engine.temp[at]];
    const heart = this.engine.hero;
    const hero: [number, number] | null = heart >= 0 && this.engine.cells[heart] === HERO ? [heart % w, (heart / w) | 0] : null;
    this.send({ t: "frame", patches, w, h, ambient: this.engine.ambient, probe, hero });

    this.sinceStats += ms;
    if (this.sinceStats >= STATS) {
      this.sinceStats = 0;
      const { cells } = this.engine;
      let filled = 0;
      for (let i = 0; i < cells.length; i++) if (cells[i] !== 0) filled++;
      this.send({ t: "stats", filled });
      if (this.won?.(this.engine)) { this.won = null; this.send({ t: "won" }); }
    }

    this.sinceGrid += ms;
    if (this.sinceGrid >= GRID) {
      this.sinceGrid = 0;
      const { cells, frozen, life, temp } = this.engine;
      this.send({ t: "grid", full: encode(cells, frozen, life, temp) });
    }

    this.sinceTurn += ms;
    if (this.stream && this.sinceTurn >= TURN) {
      this.sinceTurn = 0;
      const { ticks } = this.stream.rec;
      const beats = this.stream.drain();
      if (ticks !== this.sent || beats.length > 0) {
        this.sent = ticks;
        this.send({ t: "turn", ticks, beats, sums: this.sums });
        this.sums = [];
      }
    }
  }

  /**
   * Invité : avance vers le tick de l'hôte. Un tiers du retard par frame —
   * régulier quand les messages arrivent par paquets de trois frames, et
   * l'écart se stabilise tout seul quelle que soit la vitesse choisie par
   * l'hôte.
   */
  private catchUp(p: Player, start: number): void {
    for (let n = Math.min(CATCH_UP, Math.ceil((p.rec.ticks - p.tick) / 3)); n > 0; n--) {
      const sum = this.checks.get(p.tick);
      if (sum !== undefined) {
        this.checks.delete(p.tick);
        if (!this.lost && sum !== fingerprint(this.engine.cells)) {
          this.lost = true;
          this.send({ t: "desync" });
        }
      }
      if (!p.step()) return;
      if (this.late(start)) return;
    }
  }

  /**
   * La frame a épuisé son temps de simulation : on oublie le reliquat. Au
   * moins un tick passe toujours — le bac avance, même lentement. Un invité en
   * retard le reste plus longtemps, sans rien perdre : la partie de l'hôte
   * l'attend.
   */
  private late(start: number): boolean {
    if (performance.now() - start < SLICE) return false;
    this.pending = 0;
    return true;
  }

  /** Hôte : (re)part de l'état présent — un arrivant ne connaît rien d'autre. */
  private host(on: boolean): void {
    this.stream = null;
    this.sums = [];
    if (!on) return;
    this.play(false);
    this.stream = new Recorder(this.engine, this.knobs.weather);
    this.sent = 0;
    this.send({ t: "start", rec: { ...this.stream.rec, beats: [] } });
  }

  private follow(rec: Recording | null): void {
    this.follower = null;
    this.checks.clear();
    this.lost = false;
    if (!rec) {
      const { wind, ambient, gravity, emit } = this.knobs;
      Object.assign(this.engine, { wind, ambient, gravity, emit });
      return;
    }
    this.play(false);
    this.record(false);
    this.won = null;
    try {
      this.follower = new Player({ ...rec, beats: [...rec.beats] }, this.engine);
    } catch {
      this.send({ t: "say", text: "Partie de l'hôte illisible." });
    }
  }

  /** Un tick de simulation, météo comprise — le seul endroit qui appelle `step()`. */
  private tick(): void {
    const rain = this.knobs.weather;
    this.rec?.tick(rain); // avant le pas : c'est l'état de la scène qui va servir
    this.stream?.tick(rain);
    if (rain) weather(this.engine);
    this.engine.step();
    const ticks = this.stream?.rec.ticks;
    if (ticks !== undefined && ticks % SUM === 0) this.sums.push([ticks, fingerprint(this.engine.cells)]);
  }

  /**
   * La grille a changé sans geste (annuler, vider, charger, décor) : les deux
   * enregistrements la gardent en entier. Le salon **en dernier** : `stamp()`
   * repose dans le bac la grille arrondie qu'il vient d'encoder, c'est donc la
   * sienne que le bac garde — celle que reçoivent les invités.
   */
  private stamp(): void {
    this.rec?.stamp();
    this.stream?.stamp();
  }

  private edit(what: "clear" | "undo" | "redo" | "step" | "snapshot"): void {
    // Pendant un rejeu, « Pas à pas » avance le rejeu lui-même…
    if (what === "step" && this.player) {
      if (!this.player.step()) this.play(false);
      return;
    }
    // …et vider, annuler ou rétablir l'arrêtent d'abord : il continuait sinon
    // sur une grille qu'il n'avait pas enregistrée, et divergeait. Annuler
    // ramène alors au bac d'avant le rejeu, que `play()` a mis de côté.
    if (what !== "snapshot") this.play(false);
    switch (what) {
      case "snapshot": return this.snapshot();
      case "step": return this.tick();
      case "clear":
        this.snapshot();
        this.engine.clear();
        this.stamp();
        // Un défi vidé est souvent gagné d'avance (Débâcle : plus de glace du
        // tout) : vider l'abandonne.
        this.won = null;
        return;
      case "undo": return this.jump(this.undoStack, this.redoStack, "Annulé", "Rien à annuler.");
      case "redo": return this.jump(this.redoStack, this.undoStack, "Rétabli", "Rien à rétablir.");
    }
  }

  private snapshot(): void {
    if (this.player) return;
    this.undoStack.push(this.capture());
    if (this.undoStack.length > this.undoMax()) this.undoStack.shift();
    this.redoStack.length = 0; // un nouveau geste referme la branche annulée
  }

  /** Crans d'annulation tenus pour cette taille de grille : dix au plus, deux au moins (`UNDO_BYTES`). */
  private undoMax(): number {
    return Math.max(2, Math.min(UNDO_MAX, Math.floor(UNDO_BYTES / (7 * this.engine.cells.length))));
  }

  private capture(): Snapshot {
    const { cells, life, temp, frozen } = this.engine;
    return { cells: cells.slice(), life: life.slice(), temp: temp.slice(), frozen: frozen.slice() };
  }

  private restore(state: Snapshot): void {
    this.engine.cells.set(state.cells);
    this.engine.life.set(state.life);
    this.engine.temp.set(state.temp);
    this.engine.frozen.set(state.frozen);
    this.engine.wakeAll();
    // La grille change sans geste : l'enregistrement la garde en entier.
    this.stamp();
  }

  /** Dépile d'un côté en empilant de l'autre : annuler et rétablir sont le même geste. */
  private jump(from: Snapshot[], to: Snapshot[], done: string, empty: string): void {
    const state = from.pop();
    if (!state) { this.send({ t: "say", text: empty }); return; }
    to.push(this.capture());
    this.restore(state);
    const left = from.length;
    this.send({ t: "say", text: `${done} (${left} cran${left > 1 ? "s" : ""} restant${left > 1 ? "s" : ""}).` });
  }

  /** Un décor tiré au sort ou un défi livré : la scène est bâtie en code. */
  private scene(name: string): void {
    const challenge = CHALLENGES.find((c) => c.name === name);
    const found = challenge ?? SCENES.find((s) => s.name === name);
    if (!found) return;
    this.play(false); // la scène remplace la grille du rejeu : il s'arrête
    this.snapshot();
    this.engine.clear();
    found.build(this.engine);
    this.stamp();
    this.won = challenge ? challenge.won : null;
  }

  /**
   * Un monde généré (terrain.ts), à la taille du bac. Même chemin qu'un décor :
   * le rejeu s'arrête, le bac d'avant reste annulable, et la grille entière
   * part aux enregistrements — un invité reçoit le monde, pas la graine.
   * Une graine hors de 1..`SEEDS` venue de la page est ramenée dedans.
   */
  private world(seed: number): void {
    this.play(false);
    this.snapshot();
    this.engine.clear();
    terrain(this.engine, Math.min(SEEDS, Math.max(1, Math.floor(seed) || 1)));
    this.stamp();
    this.won = null;
  }

  /**
   * Une grille venue d'ailleurs (galerie, lien, hôte d'un salon). La donnée
   * n'est pas de confiance : un base64 tronqué fait jeter `atob`, et `adopt`
   * écarte les matières inconnues.
   */
  private load(data: string, ask?: number, quiet?: boolean): void {
    this.play(false); // la grille venue d'ailleurs remplace celle du rejeu
    if (!quiet) this.snapshot();
    try {
      put(this.engine, data, null, this.engine.ambient);
    } catch {
      // On dépile à la main : « annuler » empilerait la grille à moitié posée
      // dans les crans à rétablir, et un Ctrl+Y la ramènerait.
      if (!quiet) {
        const before = this.undoStack.pop();
        if (before) this.restore(before);
      }
      this.send({ t: "say", text: "Grille illisible." });
      if (ask !== undefined) this.send({ t: "reply", ask, value: false });
      return;
    }
    this.stamp();
    // Un autre monde : l'objectif du défi en cours ne le concerne plus. Un
    // monde-défi de la galerie réarme le sien juste après (ordre `goal`).
    this.won = null;
    if (ask !== undefined) this.send({ t: "reply", ask, value: true });
  }

  private resize(width: number, height: number, keep: boolean): void {
    // Le rejeu tient l'ancien moteur : il continuerait d'avancer dans le vide.
    this.play(false);
    // Un bac neuf (la cuvette, ou rien) remplirait d'avance plus d'un objectif.
    // Un défi livré se rebâtit après (`fit()` puis l'ordre `scene`).
    this.won = null;
    const { wind, ambient, gravity, emit } = this.engine;
    this.engine = new Engine(width, height);
    Object.assign(this.engine, { wind, ambient, gravity, emit });
    this.tracker = new Tracker(this.engine);
    // Les crans n'ont plus la bonne longueur, et l'enregistrement en cours ne
    // décrit plus rien de rejouable.
    this.undoStack.length = 0;
    this.redoStack.length = 0;
    if (this.rec) {
      this.rec = null;
      this.send({ t: "say", text: "Enregistrement abandonné : le bac a changé de taille." });
    }
    if (!keep) seed(this.engine);
    if (this.stream) this.host(true);
    if (this.follower) {
      this.follow(null);
      this.send({ t: "desync" });
    }
  }

  private record(on: boolean): void {
    if (on) {
      if (this.player) return; // on n'enregistre pas un rejeu
      this.rec = new Recorder(this.engine, this.knobs.weather);
      this.stream?.stamp();
      return;
    }
    if (!this.rec) return;
    this.film = this.rec.rec;
    this.send({
      t: "rec", ticks: this.film.ticks, beats: this.film.beats.length, size: this.rec.size,
      w: this.film.w, h: this.film.h,
    });
    this.rec = null;
  }

  private play(on: boolean): void {
    if (!on) {
      if (!this.player) return;
      this.player = null;
      // Le rejeu a posé ses réglages dans le moteur (vent, ambiante, gravité,
      // matière des sources) : on remet ceux du panneau, sinon le bouton
      // Gravité disait « vers le bas » d'un bac qui tombait vers le haut.
      const { wind, ambient, gravity, emit } = this.knobs;
      Object.assign(this.engine, { wind, ambient, gravity, emit });
      this.send({ t: "play", on: false });
      return;
    }
    if (this.player || !this.film) return;
    if (this.stream) {
      this.send({ t: "say", text: "Pas de rejeu pendant un salon partagé." });
      return;
    }
    if (this.rec) {
      this.send({ t: "say", text: "Enregistrement en cours : arrêtez-le d'abord." });
      return;
    }
    if (this.film.w !== this.engine.width || this.film.h !== this.engine.height) {
      this.send({ t: "say", text: "Rejeu fait pour une autre taille de grille." });
      return;
    }
    this.snapshot(); // le bac d'avant reste annulable
    this.player = new Player(this.film, this.engine);
    this.send({ t: "play", on: true });
  }
}

/** Une petite cuvette de pierre avec du sable et de l'eau, pour ne pas démarrer devant du vide. */
export function seed(e: Engine): void {
  for (let x = 0; x < e.width; x++) {
    const bowl = Math.round(e.height - 12 - 26 * Math.sin((x / e.width) * Math.PI));
    for (let y = bowl; y < e.height; y++) e.set(x, y, STONE);
  }
  for (let x = 60; x < 140; x++) {
    for (let y = 60; y < 90; y++) e.set(x, y, SAND);
  }
  for (let x = 180; x < 260; x++) {
    for (let y = 50; y < 80; y++) e.set(x, y, WATER);
  }
}
