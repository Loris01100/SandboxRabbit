/**
 * Les fils auxiliaires du moteur : ils font une part des travaux d'un tick
 * (`engine.job()`) sur la même mémoire partagée (`engine.memory`).
 *
 * Le fil qui simule — le Worker du bac, ou Node en test — coordonne et
 * travaille lui aussi. Pour une passe : il publie le travail dans `control`,
 * réveille les autres (`Atomics.notify`), chacun prend les travaux un à un
 * par un compteur atomique, puis il attend qu'ils aient tous fini
 * (`Atomics.wait`). Pas de `postMessage` par passe : il y en a sept par tick.
 *
 * Le résultat ne dépend ni du nombre de fils ni de qui prend quoi (voir
 * `Engine.step`). C'est ce qui permet d'attacher le pool **quand il est
 * prêt** : en attendant, le moteur fait tout lui-même, à l'identique.
 *
 * Pur, sans DOM : un fil auxiliaire n'est qu'un `Helper` (poster, écouter),
 * que le navigateur (sim/worker.ts, relancé en auxiliaire) et Node
 * (test/helper.ts) fournissent.
 */
import { CTL, Engine, JOB, type Memory } from "./engine.ts";

/** Un fil auxiliaire, vu du coordinateur : de quoi lui écrire et l'entendre. */
export interface Helper {
  post(message: unknown): void;
  listen(fn: (message: unknown) => void): void;
}

export class Pool {
  private readonly helpers: Helper[];
  /** Le moteur servi, et la génération de `bind()` dont on attend les « prêt ». */
  private engine: Engine | null = null;
  private generation = 0;
  private ready = 0;
  private resolve: (() => void) | null = null;

  constructor(helpers: Helper[]) {
    this.helpers = helpers;
    for (const h of helpers) h.listen((message) => this.hear(message));
  }

  /** Nombre de fils auxiliaires : le coordinateur en plus, c'est le nombre de cœurs employés. */
  get size(): number {
    return this.helpers.length;
  }

  /**
   * Sert un nouveau moteur (bac neuf, autre taille). L'ancien est lâché : ses
   * fils sortent de leur boucle (`JOB.stop`) et reçoivent la mémoire du
   * nouveau. Le pool ne s'attache au moteur qu'une fois tous prêts ; la
   * promesse se tient à ce moment-là.
   */
  bind(engine: Engine): Promise<void> {
    if (this.engine) {
      this.engine.pool = null;
      this.signal(this.engine, JOB.stop, 0);
    }
    this.engine = engine;
    this.generation++;
    this.ready = 0;
    const message = { generation: this.generation, memory: engine.memory };
    for (const h of this.helpers) h.post(message);
    return new Promise((resolve) => { this.resolve = resolve; });
  }

  /** Lâche le moteur servi : ses fils sortent de leur boucle. À appeler avant de les terminer. */
  release(): void {
    if (!this.engine) return;
    this.engine.pool = null;
    this.signal(this.engine, JOB.stop, 0);
    this.engine = null;
  }

  private hear(message: unknown): void {
    if ((message as { ready?: number }).ready !== this.generation || !this.engine) return;
    if (++this.ready < this.helpers.length) return;
    this.engine.pool = this;
    this.resolve?.();
    this.resolve = null;
  }

  /** Publie un travail dans `control` et réveille les fils. */
  private signal(engine: Engine, kind: number, count: number): void {
    const ctl = engine.control;
    Atomics.store(ctl, CTL.job, kind);
    Atomics.store(ctl, CTL.count, count);
    Atomics.store(ctl, CTL.next, 0);
    Atomics.store(ctl, CTL.done, 0);
    Atomics.add(ctl, CTL.gen, 1);
    Atomics.notify(ctl, CTL.gen);
  }

  /** Une passe : les `count` premiers travaux de `engine.jobs`, partagés entre tous les fils, coordinateur compris. */
  run(engine: Engine, kind: number, count: number): void {
    const ctl = engine.control;
    this.signal(engine, kind, count);
    take(engine, kind, count);
    const need = this.helpers.length;
    for (let done = Atomics.load(ctl, CTL.done); done < need; done = Atomics.load(ctl, CTL.done)) {
      Atomics.wait(ctl, CTL.done, done);
    }
  }
}

/** Prend les travaux un à un au compteur partagé, jusqu'à épuisement. */
function take(engine: Engine, kind: number, count: number): void {
  for (;;) {
    const k = Atomics.add(engine.control, CTL.next, 1);
    if (k >= count) return;
    engine.job(kind, engine.jobs[k]);
  }
}

/**
 * La boucle d'un fil auxiliaire, sur la mémoire reçue : il se déclare prêt,
 * puis attend chaque passe, en prend sa part et le dit. Rend la main à
 * `JOB.stop` — son fil peut alors recevoir la mémoire d'un autre moteur.
 *
 * Un moteur déjà lâché avant qu'il ne commence (deux `bind()` coup sur coup)
 * est reconnu d'emblée : sans ça, le fil attendait pour toujours une passe
 * qui ne viendrait plus, et ne lisait jamais la mémoire suivante.
 */
export function serve(message: { generation: number; memory: Memory }, ready: (message: { ready: number }) => void): void {
  const { memory } = message;
  const engine = new Engine(memory.width, memory.height, 1, memory);
  const ctl = engine.control;
  let seen = Atomics.load(ctl, CTL.gen);
  if (Atomics.load(ctl, CTL.job) === JOB.stop) return;
  ready({ ready: message.generation });
  for (;;) {
    Atomics.wait(ctl, CTL.gen, seen);
    seen = Atomics.load(ctl, CTL.gen);
    const kind = Atomics.load(ctl, CTL.job);
    if (kind === JOB.stop) return;
    engine.sync();
    take(engine, kind, Atomics.load(ctl, CTL.count));
    Atomics.add(ctl, CTL.done, 1);
    Atomics.notify(ctl, CTL.done);
  }
}
