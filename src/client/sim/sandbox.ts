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
import { Renderer } from "./render.ts";
import { encode } from "./codec.ts";
import { SAND, STONE, WATER, type MaterialId } from "./materials.ts";
import { applyGesture, weather, type Gesture } from "../gestures.ts";
import { Player, Recorder, put, type Recording } from "../replay.ts";
import { CHALLENGES, SCENES, count } from "../challenges.ts";
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
  /** Un salon est ouvert : il faut aussi la grille courte, quatre fois par seconde. */
  room: boolean;
}

export type Order =
  | { t: "do"; g: Gesture }
  | { t: "set"; k: Partial<Knobs> }
  | { t: "size"; w: number; h: number; keep: boolean }
  | { t: "load"; data: string; ask?: number; quiet?: boolean }
  | { t: "edit"; do: "clear" | "undo" | "redo" | "step" | "snapshot" }
  | { t: "scene"; name: string }
  | { t: "goal"; goal: string | null }
  | { t: "cursor"; x: number; y: number }
  | { t: "clip"; ask: number; x: number; y: number; x2: number; y2: number }
  | { t: "rec"; on: boolean }
  | { t: "play"; on: boolean };

export type News =
  /** Une frame prête à poser : `pixels` fait `w * h * 4` octets. */
  | { t: "frame"; pixels: Uint8ClampedArray; w: number; h: number; probe: [MaterialId, number] | null }
  /** Deux fois par seconde : ce qui coûte un balayage de la grille. */
  | { t: "stats"; filled: number }
  /** Quatre fois par seconde : la grille encodée (sauvegarde, mémoire locale, salon). */
  | { t: "grid"; full: string; room?: string }
  | { t: "reply"; ask: number; value: unknown }
  | { t: "say"; text: string }
  | { t: "won" }
  | { t: "rec"; ticks: number; beats: number; size: number; w: number; h: number }
  | { t: "play"; on: boolean };

/** Une copie des quatre tableaux : dix crans gardés (~230 ko le cran en 320×180). */
const UNDO_MAX = 10;
type Snapshot = { cells: Uint8Array; life: Uint8Array; temp: Float32Array; frozen: Uint8Array };

/** Intervalle des nouvelles chères, en ms. */
const STATS = 500;
const GRID = 250;

export class Sandbox {
  engine: Engine;
  renderer: Renderer;
  knobs: Knobs = {
    wind: 0, ambient: 20, gravity: 1, emit: WATER,
    weather: false, speed: 1, running: true, heatmap: false, room: false,
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

  constructor(width: number, height: number, send: (news: News) => void) {
    this.engine = new Engine(width, height);
    this.renderer = new Renderer(this.engine);
    this.send = send;
    seed(this.engine);
  }

  order(o: Order): void {
    switch (o.t) {
      case "do":
        // Pendant un rejeu, le bac appartient à l'enregistrement : un geste de
        // plus ferait diverger la suite de ce qu'on est en train de regarder.
        if (this.player) return;
        applyGesture(this.engine, o.g);
        this.rec?.gesture(o.g);
        return;
      case "set": {
        Object.assign(this.knobs, o.k);
        const { wind, ambient, gravity, emit, heatmap } = this.knobs;
        Object.assign(this.engine, { wind, ambient, gravity, emit });
        this.renderer.heatmap = heatmap;
        return;
      }
      case "size": return this.resize(o.w, o.h, o.keep);
      case "load": return this.load(o.data, o.ask, o.quiet);
      case "edit": return this.edit(o.do);
      case "scene": return this.scene(o.name);
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

  /** Avance le bac de `ms` millisecondes et peint une frame. */
  frame(ms: number): void {
    const budget = ticksFor(this.knobs.speed, ms, this.pending);
    this.pending = budget.pending;
    if (this.player) {
      // Un rejeu remplace la simulation : c'est lui qui avance le bac.
      for (let n = budget.ticks; n > 0; n--) {
        if (!this.player.step()) { this.play(false); break; }
      }
    } else if (this.knobs.running) {
      for (let n = budget.ticks; n > 0; n--) this.tick();
    }

    this.renderer.draw();
    const { width: w, height: h } = this.engine;
    const { x, y } = this.cursor;
    const at = this.engine.inBounds(x, y) ? this.engine.index(x, y) : -1;
    const probe: [MaterialId, number] | null =
      at < 0 ? null : [this.engine.cells[at] as MaterialId, this.engine.temp[at]];
    // ponytail: les pixels sont copiés (clone structuré), pas transférés — 230 ko
    // par frame en 320×180. Passer au transfert, avec deux tampons qui font la
    // navette, le jour où ça se voit dans un profil.
    this.send({ t: "frame", pixels: this.renderer.pixels, w, h, probe });

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
      this.send({
        t: "grid",
        full: encode(cells, frozen, life, temp),
        // Le salon n'a que faire des vies et des températures, et le message est
        // plafonné en face : on lui garde la version courte.
        room: this.knobs.room ? encode(cells, frozen) : undefined,
      });
    }
  }

  /** Un tick de simulation, météo comprise — le seul endroit qui appelle `step()`. */
  private tick(): void {
    const rain = this.knobs.weather;
    this.rec?.tick(rain); // avant le pas : c'est l'état de la scène qui va servir
    if (rain) weather(this.engine);
    this.engine.step();
  }

  private edit(what: "clear" | "undo" | "redo" | "step" | "snapshot"): void {
    switch (what) {
      case "snapshot": return this.snapshot();
      case "step": return this.tick();
      case "clear":
        this.snapshot();
        this.engine.clear();
        this.rec?.stamp();
        return;
      case "undo": return this.jump(this.undoStack, this.redoStack, "Annulé", "Rien à annuler.");
      case "redo": return this.jump(this.redoStack, this.undoStack, "Rétabli", "Rien à rétablir.");
    }
  }

  private snapshot(): void {
    if (this.player) return;
    this.undoStack.push(this.capture());
    if (this.undoStack.length > UNDO_MAX) this.undoStack.shift();
    this.redoStack.length = 0; // un nouveau geste referme la branche annulée
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
    // La grille change sans geste : l'enregistrement la garde en entier.
    this.rec?.stamp();
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
    this.snapshot();
    this.engine.clear();
    found.build(this.engine);
    this.rec?.stamp();
    this.won = challenge ? challenge.won : null;
  }

  /**
   * Une grille venue d'ailleurs (galerie, lien, hôte d'un salon). La donnée
   * n'est pas de confiance : un base64 tronqué fait jeter `atob`, et `adopt`
   * écarte les matières inconnues.
   */
  private load(data: string, ask?: number, quiet?: boolean): void {
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
    this.rec?.stamp();
    if (ask !== undefined) this.send({ t: "reply", ask, value: true });
  }

  private resize(width: number, height: number, keep: boolean): void {
    const { wind, ambient, gravity, emit } = this.engine;
    this.engine = new Engine(width, height);
    Object.assign(this.engine, { wind, ambient, gravity, emit });
    this.renderer = new Renderer(this.engine);
    this.renderer.heatmap = this.knobs.heatmap;
    // Les crans n'ont plus la bonne longueur, et l'enregistrement en cours ne
    // décrit plus rien de rejouable.
    this.undoStack.length = 0;
    this.redoStack.length = 0;
    if (this.rec) {
      this.rec = null;
      this.send({ t: "say", text: "Enregistrement abandonné : le bac a changé de taille." });
    }
    if (!keep) seed(this.engine);
  }

  private record(on: boolean): void {
    if (on) {
      if (this.player) return; // on n'enregistre pas un rejeu
      this.rec = new Recorder(this.engine, this.knobs.weather);
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
      this.send({ t: "play", on: false });
      return;
    }
    if (this.player || !this.film) return;
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
