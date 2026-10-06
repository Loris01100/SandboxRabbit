/**
 * Le protocole du bac : `npm run check` (Node exécute le TS tel quel).
 *
 * Depuis que la simulation vit dans un Worker, le fil principal ne lit plus le
 * moteur — il envoie des ordres et affiche des nouvelles. C'est donc ce
 * va-et-vient qu'il faut vérifier, et il n'a besoin d'aucun navigateur :
 * `Sandbox` ne connaît ni le DOM ni `postMessage`, juste un rappel.
 */
import assert from "node:assert/strict";
import { Sandbox, type News } from "../src/client/sim/sandbox.ts";
import { Renderer, glide, land, type Mirror } from "../src/client/sim/render.ts";
import { decode, encode } from "../src/client/sim/codec.ts";
import { count } from "../src/client/challenges.ts";
import { verdict } from "../src/client/sim/verdict.ts";
import { TRIAL_TICKS, fair, put } from "../src/client/replay.ts";
import { EMPTY, FIRE, HERO, HERO_BODY, HERO_HEAD, HERO_LEGS, PILOT, SAND, STONE, TNT, WATER } from "../src/client/sim/materials.ts";
import { Engine } from "../src/client/sim/engine.ts";
import { EXPLORE_SCALE, Explore, STRIP, WINDOW_H, WINDOW_W, land as build, parse, type Log } from "../src/client/sim/explore.ts";

const W = 80, H = 45;

/** Un bac neuf et la liste de ce qu'il a dit. */
function bac(): { sim: Sandbox; news: News[] } {
  const news: News[] = [];
  const sim = new Sandbox(W, H, (n) => news.push(n));
  return { sim, news };
}

/** Fait tourner `frames` frames de 16 ms. */
function run(sim: Sandbox, frames: number): void {
  for (let n = 0; n < frames; n++) sim.frame(16);
}

const last = <T extends News["t"]>(news: News[], t: T): Extract<News, { t: T }> | undefined =>
  [...news].reverse().find((n) => n.t === t) as Extract<News, { t: T }> | undefined;

type Frame = Extract<News, { t: "frame" }>;

/** Pixels portés par une frame : la somme de ses bandes. */
const area = (f: Frame): number => f.patches.reduce((s, p) => s + p.w * p.h, 0);

// Une frame par appel, aux dimensions de la grille.
{
  const { sim, news } = bac();
  assert.ok(count(sim.engine, STONE) > 0, "le bac démarre graîné, pas devant du vide");
  sim.frame(16);
  const frame = last(news, "frame")!;
  assert.deepEqual([frame.w, frame.h], [W, H], "la frame porte la taille de la grille");
  assert.equal(area(frame), W * H, "la première frame couvre tout le bac");
}

/**
 * Les frames ne portent que les blocs changés : la page les recopie dans son
 * miroir (world.ts), qui doit rester, cellule pour cellule, la grille du
 * moteur — sinon un bloc oublié par le suivi reste en retard à l'écran. Et ce
 * miroir se colorie comme le moteur lui-même (`Renderer`, le secours sans
 * WebGL2 et la copie du shader).
 */
{
  const { sim, news } = bac();
  const n = W * H;
  const miroir = {
    width: W, height: H, ambient: 20,
    cells: new Uint8Array(n), life: new Uint8Array(n), frozen: new Uint8Array(n),
    noise: new Int8Array(n), temp: new Float32Array(n), press: new Float32Array(n),
  };
  const reçues = () => {
    for (const f of news.splice(0)) {
      if (f.t !== "frame") continue;
      miroir.ambient = f.ambient;
      for (const p of f.patches) land(miroir, p);
    }
  };
  run(sim, 400);
  reçues();
  run(sim, 5);
  assert.equal(news.filter((f) => f.t === "frame").reduce((s, f) => s + area(f as Frame), 0), 0, "un bac au repos n'envoie plus une cellule");

  sim.order({ t: "do", g: { t: "paint", x: 70, y: 5, r: 1, id: SAND, d: 1, over: true } });
  sim.frame(16);
  const touchées = area(last(news, "frame")!);
  assert.ok(touchées > 0 && touchées < (W * H) / 2, `un grain de sable ne renvoie que son coin de bac (${touchées} cellules)`);

  /** Le miroir recomposé est-il la grille du moteur ? Températures et pression brutes, comme elles voyagent. */
  const pareil = (quand: string) => {
    reçues();
    const e = sim.engine;
    assert.deepEqual(miroir.cells, e.cells, `même matière — ${quand}`);
    assert.deepEqual(miroir.life, e.life, `même état vivant — ${quand}`);
    assert.deepEqual(miroir.frozen, e.frozen, `même figé — ${quand}`);
    assert.deepEqual(miroir.noise, e.noise, `même grain — ${quand}`);
    assert.deepEqual(miroir.temp, e.temp, `mêmes températures — ${quand}`);
    assert.equal(miroir.ambient, e.ambient, `même ambiante — ${quand}`);
    assert.deepEqual(miroir.press, e.press, `même pression — ${quand}`);
  };
  sim.order({ t: "do", g: { t: "paint", x: 20, y: 10, r: 3, id: FIRE, d: 1, over: true } });
  run(sim, 30);
  pareil("un feu en cours");
  sim.order({ t: "set", k: { running: false } });
  sim.order({ t: "do", g: { t: "rect", x: 50, y: 20, x2: 60, y2: 25, id: WATER, over: true } });
  sim.frame(16);
  pareil("un geste bac en pause");
  sim.order({ t: "set", k: { running: true, ambient: 60 } });
  run(sim, 20);
  pareil("une autre ambiante");
  // Un souffle : la pression voyage jusqu'au miroir, puis y retombe à zéro.
  sim.order({ t: "do", g: { t: "paint", x: 40, y: 30, r: 2, id: TNT, d: 1, over: true } });
  sim.order({ t: "do", g: { t: "paint", x: 40, y: 27, r: 1, id: FIRE, d: 1, over: true } });
  run(sim, 6);
  pareil("un souffle");
  assert.ok(miroir.press.some((p) => p > 0), "la pression d'un souffle arrive au miroir");
  run(sim, 300);
  pareil("un souffle retombé");
  assert.ok(!miroir.press.some((p) => p > 0), "et y retombe à zéro");

  const page = new Renderer(miroir), moteur = new Renderer(sim.engine);
  page.draw();
  moteur.draw();
  let écarts = 0;
  for (let i = 0; i < page.pixels.length; i++) if (Math.abs(page.pixels[i] - moteur.pixels[i]) > 2) écarts++;
  assert.ok(écarts < page.pixels.length / 1000, `le miroir se colorie comme le moteur, à l'arrondi des températures près (${écarts} canaux écartés)`);
}

/**
 * Le son : une explosion est signalée dans la frame qui l'a jouée, et dans
 * celle-là seulement (la page la jouerait sinon à chaque image) ; le feu
 * nourrit le fond sonore des stats, qui se tait en pause.
 */
{
  const { sim, news } = bac();
  sim.order({ t: "do", g: { t: "paint", x: 40, y: 30, r: 2, id: TNT, d: 1, over: true } });
  sim.order({ t: "do", g: { t: "paint", x: 40, y: 27, r: 1, id: FIRE, d: 1, over: true } });
  run(sim, 60);
  const frames = news.filter((n): n is Frame => n.t === "frame");
  const bruyantes = frames.filter((f) => f.heard && f.heard.booms > 0);
  assert.ok(bruyantes.length > 0, "l'explosion du TNT s'entend");
  assert.ok(bruyantes.length < frames.length, "et seulement dans les frames qui l'ont jouée");
  const coup = bruyantes[0].heard!;
  assert.ok(coup.loudest > 0 && Math.abs(coup.at - 40) <= 3, `le plus gros rayon et sa colonne (${coup.loudest} en ${coup.at})`);
  assert.equal(sim.engine.heard.booms, 0, "relevé, le compte repart de zéro");

  sim.order({ t: "do", g: { t: "paint", x: 20, y: 10, r: 4, id: FIRE, d: 1, over: true } });
  run(sim, 32);
  assert.ok(last(news, "stats")!.hum.fire > 0, "le feu nourrit le fond sonore");
  sim.order({ t: "set", k: { running: false } });
  run(sim, 32);
  assert.deepEqual(last(news, "stats")!.hum, { fire: 0, lava: 0, rain: 0 }, "en pause, tout se tait");
}

// La sonde suit le curseur, et se tait quand il sort du bac.
{
  const { sim, news } = bac();
  sim.order({ t: "do", g: { t: "paint", x: 10, y: 5, r: 2, id: STONE, d: 1, over: true } });
  sim.order({ t: "cursor", x: 10, y: 5 });
  sim.frame(16);
  assert.equal(last(news, "frame")!.probe?.[0], STONE, "la matière sous le curseur");
  sim.order({ t: "cursor", x: -1, y: -1 });
  sim.frame(16);
  assert.equal(last(news, "frame")!.probe, null, "hors du bac, rien à sonder");
}

// Un geste modifie la grille ; annuler la remet, rétablir la refait.
{
  const { sim, news } = bac();
  sim.order({ t: "edit", do: "snapshot" });
  sim.order({ t: "do", g: { t: "rect", x: 2, y: 2, x2: 20, y2: 6, id: WATER, over: true } });
  const posé = count(sim.engine, WATER);
  assert.ok(posé > 0, "le geste a bien peint");

  sim.order({ t: "edit", do: "undo" });
  assert.equal(count(sim.engine, WATER), 0, "annulé : l'eau n'a jamais coulé");
  assert.match(last(news, "say")!.text, /^Annulé \(0 cran/, "et le compte de crans remonte à la page");

  sim.order({ t: "edit", do: "redo" });
  assert.equal(count(sim.engine, WATER), posé, "rétabli : la même eau");

  sim.order({ t: "edit", do: "undo" });
  sim.order({ t: "edit", do: "undo" });
  assert.equal(last(news, "say")!.text, "Rien à annuler.", "et la pile vide le dit");
}

/** En 1920×1080 un cran pèse 14,5 Mo : l'annulation en garde moins, pas dix. */
{
  const news: News[] = [];
  const sim = new Sandbox(1920, 1080, (n) => news.push(n));
  for (let n = 0; n < 8; n++) {
    sim.order({ t: "edit", do: "snapshot" });
    sim.order({ t: "do", g: { t: "paint", x: 100 + n * 10, y: 100, r: 3, id: SAND, d: 1, over: true } });
  }
  let crans = 0;
  for (;;) {
    sim.order({ t: "edit", do: "undo" });
    if (last(news, "say")!.text === "Rien à annuler.") break;
    crans++;
  }
  assert.equal(crans, 4, "quatre crans, soit moins de 64 Mo de copies");
}

/**
 * Un bac trop lourd pour sa frame ralentit au lieu de rattraper : une frame
 * de 100 ms à vitesse ×4 réclame huit ticks, mais une bande d'eau qui tombe
 * sur toute la largeur d'un 1920×1080 n'en laisse passer que ce qui tient
 * dans `SLICE`. Sans ce plafond, la frame suivante en réclamait encore plus.
 */
{
  const news: News[] = [];
  const sim = new Sandbox(1920, 1080, (n) => news.push(n));
  sim.order({ t: "do", g: { t: "rect", x: 0, y: 100, x2: 1919, y2: 400, id: WATER, over: false } });
  sim.order({ t: "set", k: { speed: 4 } });
  sim.order({ t: "rec", on: true });
  sim.frame(100);
  sim.order({ t: "rec", on: false });
  const joués = last(news, "rec")!.ticks;
  assert.ok(joués >= 1 && joués < 8, `une frame surchargée s'arrête à temps (${joués} ticks sur 8 demandés)`);
}

/** Un monde généré se bâtit à la taille du bac, et s'annule comme un décor. */
{
  const { sim } = bac();
  const avant = sim.engine.cells.slice();
  sim.order({ t: "terrain", seed: 4217 });
  assert.notDeepEqual(sim.engine.cells, avant, "le monde a remplacé la cuvette");
  const bâti = sim.engine.cells.slice();
  sim.order({ t: "edit", do: "undo" });
  assert.deepEqual(sim.engine.cells, avant, "annuler ramène le bac d'avant");
  sim.order({ t: "terrain", seed: 4217 });
  assert.deepEqual(sim.engine.cells, bâti, "la même graine redonne le même monde");
}

/**
 * Le mode exploration, côté protocole : la frame dit où est la fenêtre dans
 * le monde (`origin`), et ce qui suppose une grille qui ne glisse pas est
 * refusé — annuler ramènerait une autre grille sous un mode qui glisse.
 */
{
  const news: News[] = [];
  const sim = new Sandbox(WINDOW_W, WINDOW_H, (n) => news.push(n));
  const dit = (): string | undefined => last(news, "say")?.text;
  sim.order({ t: "explore", seed: 4217 });
  await sim.arrival; // le mode se charge à la demande (`import()`)
  sim.frame(16);
  assert.equal(last(news, "frame")!.origin, -2 * STRIP, "la fenêtre part de deux chunks à gauche du zéro du monde");
  assert.ok(last(news, "frame")!.hero, "un héros est posé");
  sim.order({ t: "edit", do: "undo" });
  assert.equal(dit(), "Pas d'annulation en exploration.", "pas d'annulation");
  sim.order({ t: "rec", on: true });
  assert.equal(dit(), "Pas d'enregistrement en exploration.", "pas d'enregistrement");
  sim.order({ t: "host", on: true });
  sim.frame(16);
  assert.equal(last(news, "frame")!.origin, null, "un salon arrête l'exploration");
  sim.order({ t: "host", on: false });
  sim.order({ t: "explore", seed: 4217 });
  sim.order({ t: "terrain", seed: 1 });
  await sim.arrival;
  sim.frame(16);
  assert.equal(last(news, "frame")!.origin, null, "un autre monde, demandé pendant que le mode se charge, l'emporte");
  sim.order({ t: "explore", seed: 4217 });
  await sim.arrival;
  sim.frame(16);
  assert.equal(last(news, "frame")!.origin, -2 * STRIP, "rechargé, le module repart");
  sim.order({ t: "terrain", seed: 1 });
  sim.frame(16);
  assert.equal(last(news, "frame")!.origin, null, "un autre monde arrête l'exploration");

  const petit = bac();
  petit.sim.order({ t: "explore", seed: 1 });
  await petit.sim.arrival;
  assert.match(last(petit.news, "say")!.text, /1280 × 720/, "un bac d'une autre taille est refusé");
  petit.sim.frame(16);
  assert.equal(last(petit.news, "frame")!.origin, null, "… et reste un bac ordinaire");
}

/**
 * La fenêtre glisse (sim/explore.ts) : un chunk qui sort est rangé, relu tel
 * quel quand il revient ; un chunk jamais vu est bâti par la graine ; bâti
 * d'avance par morceaux ou d'un coup, c'est le même. Le héros est déplacé à
 * la main : le faire marcher sur 400 cellules prendrait des milliers de ticks.
 */
{
  const G = 4217;
  /** Enlève le héros et le repose au sec, à partir de la colonne `x` vers la droite ; rend la colonne. */
  const téléporte = (e: Engine, x: number): number => {
    for (let i = 0; i < e.cells.length; i++) {
      const id = e.cells[i];
      if (id === HERO || id === HERO_HEAD || id === HERO_BODY || id === HERO_LEGS) e.set(i % e.width, Math.trunc(i / e.width), EMPTY);
    }
    for (let at = x; ; at++) {
      let y = 0;
      while (e.get(at, y) === EMPTY) y++;
      if (e.get(at, y) !== WATER && e.spawnHero(at, y - 2) >= 0) return at;
    }
  };
  const partie = (): [Engine, Explore] => {
    const e = new Engine(WINDOW_W, WINDOW_H, 1);
    const ex = new Explore(G, EXPLORE_SCALE);
    assert.ok(ex.start(e) >= 0, "le départ pose un héros");
    return [e, ex];
  };

  const [e, ex] = partie();
  const gauche = e.copy(0, 0, STRIP - 1, WINDOW_H - 1);
  téléporte(e, 700);
  assert.equal(ex.slide(e), 0, "dans les trois chunks du milieu, la fenêtre ne bouge pas");
  téléporte(e, 1100);
  assert.equal(ex.slide(e), STRIP, "passé le quatrième chunk, elle glisse d'un chunk vers la droite");
  assert.equal(ex.x0, -STRIP, "… et son origine avec");
  assert.ok(ex.kept.has(-2), "le chunk sorti est rangé");
  assert.equal(e.cells[e.hero], HERO, "le héros piloté a glissé avec la grille");

  const témoin = new Engine(WINDOW_W, WINDOW_H, 1);
  témoin.clear();
  build(témoin, G, EXPLORE_SCALE, -STRIP, 0, WINDOW_W);
  const bande = (g: Engine, x: number): Uint8Array => g.copy(x, 0, x + STRIP - 1, WINDOW_H - 1).cells;
  assert.deepEqual(bande(e, WINDOW_W - STRIP), bande(témoin, WINDOW_W - STRIP), "le chunk jamais vu est bâti par la graine");

  téléporte(e, 100);
  assert.equal(ex.slide(e), -STRIP, "dans le premier chunk, elle revient d'un chunk");
  assert.equal(ex.x0, -2 * STRIP, "… à son origine de départ");
  assert.deepEqual(bande(e, 0), gauche.cells, "le chunk rangé revient tel qu'il était parti");
  assert.deepEqual(e.copy(0, 0, STRIP - 1, WINDOW_H - 1).life, gauche.life, "… `life` compris");
  assert.ok(!ex.kept.has(-2), "relu, il n'est plus rangé : il le sera de nouveau à sa sortie");

  // Bâti d'avance (huit morceaux, huit images) ou d'un coup : le même chunk.
  const [d, avance] = partie(), [s, sur] = partie();
  téléporte(d, 900);
  téléporte(s, 900);
  for (let k = 0; k < 8; k++) avance.prepare(d);
  assert.ok(avance.ready(3), "dans le quatrième chunk, le chunk de droite se bâtit d'avance");
  téléporte(d, 1100);
  téléporte(s, 1100);
  avance.slide(d);
  sur.slide(s);
  assert.deepEqual(d.cells, s.cells, "bâti d'avance ou au dernier moment : la même fenêtre");
  assert.deepEqual(d.life, s.life, "… lapins compris");

  // Un chunk rangé est encodé plus tard (`prepare()`) : relu encore brut ou
  // déjà encodé, il doit revenir pareil, chaleur comprise — sinon le monde
  // dépendrait de la cadence des images.
  const [brut, a] = partie(), [scellé, b] = partie();
  for (const [g, ex] of [[brut, a], [scellé, b]] as const) {
    for (let t = 0; t < 30; t++) g.step();
    téléporte(g, 1100);
    ex.slide(g);
  }
  assert.equal(typeof a.kept.get(-2), "object", "au glissement, le chunk sortant est rangé brut");
  téléporte(scellé, 640);
  b.prepare(scellé);
  assert.equal(typeof b.kept.get(-2), "string", "une image plus tard, `prepare()` l'a encodé");
  for (const [g, ex] of [[brut, a], [scellé, b]] as const) {
    téléporte(g, 100);
    ex.slide(g);
  }
  assert.deepEqual(scellé.cells, brut.cells, "relu brut ou encodé : la même grille");
  assert.deepEqual(scellé.life, brut.life, "… le même `life`");
  assert.deepEqual(scellé.temp, brut.temp, "… la même chaleur, arrondie au pas du codec dans les deux cas");

  // Côté protocole : la page fait glisser son miroir (`glide()`) et n'en reçoit
  // que la bande neuve et ce qu'ont changé les ticks, grain compris pour ces
  // bandes. Un miroir refait comme world.ts, frame après frame, doit rester
  // la grille du bac — sinon la page montre un monde qui n'est pas celui qui
  // tourne. Avant, chaque glissement renvoyait toute la grille : 11 Mo.
  // Frames de 20 ms : à ×1, un tick dure 16,7 ms, et une frame de 16 n'en joue parfois aucun.
  const news: News[] = [];
  const sim = new Sandbox(WINDOW_W, WINDOW_H, (n) => news.push(n));
  const n = WINDOW_W * WINDOW_H;
  const miroir: Mirror = {
    width: WINDOW_W, height: WINDOW_H, ambient: 20,
    cells: new Uint8Array(n), life: new Uint8Array(n), frozen: new Uint8Array(n),
    noise: new Int8Array(n), temp: new Float32Array(n), press: new Float32Array(n),
  };
  let vu: number | null = null;
  const reçoit = (): Extract<News, { t: "frame" }> => {
    const f = last(news, "frame")!;
    if (f.origin !== null && vu !== null) glide(miroir, f.origin - vu);
    vu = f.origin;
    for (const p of f.patches) land(miroir, p);
    return f;
  };
  sim.frame(20);
  reçoit();
  sim.order({ t: "explore", seed: G });
  await sim.arrival;
  sim.frame(20);
  reçoit();
  assert.deepEqual(miroir.noise, sim.engine.noise, "au départ de l'exploration, la page reçoit le grain du monde infini");
  for (const [x, attendu] of [[1100, -STRIP], [1100, 0], [100, -STRIP], [100, -2 * STRIP]] as const) {
    téléporte(sim.engine, x);
    sim.frame(20);
    const f = reçoit();
    assert.equal(f.origin, attendu, `héros en ${x} : la fenêtre glisse jusqu'à ${attendu}`);
    const envoyé = f.patches.reduce((s, p) => s + p.w * p.h, 0);
    // Ce qu'ont changé les ticks, plus la bande neuve : pas toute la grille. Une frame
    // ordinaire de ce monde, où l'eau coule, en envoie déjà un tiers.
    assert.ok(envoyé < n, `le glissement n'envoie pas toute la grille (${envoyé} cellules sur ${n})`);
    sim.frame(20);
    reçoit();
    assert.deepEqual(miroir.cells, sim.engine.cells, `après le glissement vers ${attendu}, le miroir est la grille du bac`);
    assert.deepEqual(miroir.life, sim.engine.life, "… `life` compris");
    assert.deepEqual(miroir.noise, sim.engine.noise, "… grain compris");
    assert.deepEqual(miroir.temp, sim.engine.temp, "… chaleur comprise");
  }

  // Sauvegarder (étape 5) : une partie rangée par `save()` puis reprise par
  // `resume()` redonne la fenêtre (chaleur au pas du codec), le grain, le
  // héros piloté, et chaque chunk rangé — même ceux encore bruts au moment
  // de ranger.
  const [loin, va] = partie();
  for (let t = 0; t < 30; t++) loin.step();
  téléporte(loin, 1100);
  va.slide(loin);
  téléporte(loin, 1100);
  va.slide(loin);
  assert.equal(va.x0, 0, "deux glissements vers la droite");
  assert.equal(typeof va.kept.get(-1), "object", "le dernier chunk sorti est encore brut");
  const fenêtre = encode(loin.cells, loin.frozen, loin.life, loin.temp, loin.names);
  const rangée = va.save(loin, fenêtre);
  assert.match(rangée, /^\{"seed":4217,/, "la graine en tête : la page la lit sans tout relire");
  const log = parse(rangée)!;
  assert.deepEqual(log.kept.map(([c]) => c), [-1, -2], "les chunks rangés, les plus proches d'abord");
  const reprise = (l: Log): [Engine, Explore] => {
    const g = new Engine(WINDOW_W, WINDOW_H, 1);
    put(g, l.grid, null, g.ambient);
    const x = new Explore(l.seed, EXPLORE_SCALE);
    x.resume(g, l);
    return [g, x];
  };
  const [là, revu] = reprise(log);
  assert.equal(revu.x0, 0, "reprise à la même origine");
  assert.deepEqual(là.cells, loin.cells, "la même fenêtre");
  assert.deepEqual(là.life, loin.life, "… le même `life`");
  assert.deepEqual(là.frozen, loin.frozen, "… le même figé");
  assert.deepEqual(là.noise, loin.noise, "… le même grain, refait par la position");
  assert.ok(là.temp.every((t, i) => Math.abs(t - loin.temp[i]) <= 4), "… la chaleur au pas du codec (8 °C)");
  assert.equal(là.chosen, loin.chosen, "… le même héros piloté");
  là.step();
  assert.equal(là.cells[là.hero], HERO, "… retrouvé dès le premier tick");
  for (const [g, x] of [[loin, va], [là, revu]] as const) {
    téléporte(g, 100);
    x.slide(g);
  }
  assert.deepEqual(bande(là, 0), bande(loin, 0), "le chunk rangé revient d'une partie reprise comme de la partie d'origine");
  assert.deepEqual(là.copy(0, 0, STRIP - 1, WINDOW_H - 1).life, loin.copy(0, 0, STRIP - 1, WINDOW_H - 1).life, "… `life` compris");
  assert.equal(parse("{\"seed\":1}"), null, "une partie incomplète est refusée");
  assert.equal(parse("pas du JSON"), null, "… et ce qui n'est pas du JSON");

  // Un chunk rangé abîmé dans le stockage local est rebâti par la graine,
  // au lieu de jeter au tick du glissement.
  const [abîmé, x2] = reprise({ ...log, kept: [[-1, "%%%"]] });
  téléporte(abîmé, 100);
  x2.slide(abîmé);
  const neuf = new Engine(WINDOW_W, WINDOW_H, 1);
  neuf.clear();
  build(neuf, G, EXPLORE_SCALE, -STRIP, 0, WINDOW_W);
  assert.deepEqual(bande(abîmé, 0), bande(neuf, 0), "un chunk rangé illisible revient tel que la graine le bâtit");

  // Côté protocole : en exploration, la copie de secours `grid` porte la
  // partie, et l'ordre `explore` avec `saved` la reprend.
  const rangé = (): Extract<News, { t: "grid" }> | undefined => last(news, "grid");
  for (let k = 0; k < 200 && !rangé()?.voyage; k++) sim.frame(20);
  const copie = rangé()!;
  assert.ok(copie.voyage, "en exploration, la copie de secours est la partie");
  assert.equal(parse(copie.full)?.x0, -2 * STRIP, "… avec l'origine de la fenêtre");
  const suite: News[] = [];
  const repris = new Sandbox(WINDOW_W, WINDOW_H, (m) => suite.push(m));
  repris.order({ t: "explore", seed: G, saved: copie.full });
  await repris.arrival;
  repris.frame(20);
  assert.equal(last(suite, "frame")!.origin, -2 * STRIP, "la partie reprend à son origine");
  assert.ok(last(suite, "frame")!.hero, "… avec son héros");
  assert.equal(last(suite, "say"), undefined, "… sans message");
  const gâché = new Sandbox(WINDOW_W, WINDOW_H, (m) => suite.push(m));
  gâché.order({ t: "explore", seed: G, saved: "{abîmé" });
  await gâché.arrival;
  gâché.frame(20);
  assert.match(last(suite, "say")!.text, /illisible/, "une partie illisible est dite");
  assert.ok(last(suite, "frame")!.hero, "… et le monde neuf part quand même");
}

/** La frame dit où est le héros — la caméra le suit — et se tait quand il n'y en a pas. */
{
  const { sim, news } = bac();
  sim.frame(16);
  assert.equal(last(news, "frame")!.hero, null, "pas de héros, pas de position");
  sim.order({ t: "do", g: { t: "paint", x: 40, y: 3, r: 1, id: HERO, d: 1, over: true } });
  sim.frame(16);
  const [x] = last(news, "frame")!.hero!;
  sim.order({ t: "do", g: { t: "pilot", keys: PILOT.right } });
  run(sim, 60);
  assert.ok(last(news, "frame")!.hero![0] > x, "piloté par un geste, il avance, et la frame le suit");
}

// Charger une grille : la réponse dit si elle était lisible.
{
  const { sim, news } = bac();
  const grille = "AQI"; // du base64 valide, mais tronqué : le RLE ne remplit pas tout
  sim.order({ t: "load", data: grille, ask: 7 });
  assert.deepEqual(last(news, "reply"), { t: "reply", ask: 7, value: true }, "une grille lisible passe");

  sim.order({ t: "load", data: "!!! pas du base64 !!!", ask: 8 });
  assert.deepEqual(last(news, "reply"), { t: "reply", ask: 8, value: false }, "une grille illisible est refusée");
  assert.equal(last(news, "say")!.text, "Grille illisible.", "et la page l'apprend");
  assert.ok(count(sim.engine, STONE) > 0, "le bac d'avant est retrouvé, pas à moitié écrasé");
}

// Copier renvoie de quoi recoller : la réponse est déjà un geste « clip ».
{
  const { sim, news } = bac();
  sim.order({ t: "do", g: { t: "rect", x: 0, y: 0, x2: 4, y2: 4, id: SAND, over: true } });
  sim.order({ t: "clip", ask: 1, x: 0, y: 0, x2: 4, y2: 4 });
  const clip = last(news, "reply")!.value as { w: number; h: number; cells: string; life: string };
  assert.deepEqual([clip.w, clip.h], [5, 5], "le morceau fait la taille du rectangle");

  sim.order({ t: "do", g: { t: "rect", x: 0, y: 0, x2: 4, y2: 4, id: EMPTY, over: true } });
  assert.equal(count(sim.engine, SAND), 0, "on efface l'original");
  sim.order({ t: "do", g: { t: "clip", x: 40, y: 20, w: clip.w, h: clip.h, cells: clip.cells, life: clip.life } });
  assert.equal(count(sim.engine, SAND), 25, "et le morceau se repose ailleurs, tel quel");
}

// Un objectif de monde-défi : le bac surveille, la page apprend la victoire.
{
  const { sim, news } = bac();
  sim.order({ t: "goal", goal: `ge:${SAND}:10` });
  run(sim, 40); // plus d'une demi-seconde : la victoire se vérifie deux fois par seconde
  assert.equal(last(news, "won"), undefined, "sans sable, rien n'est gagné");
  sim.order({ t: "do", g: { t: "rect", x: 2, y: 2, x2: 20, y2: 4, id: SAND, over: true } });
  run(sim, 40);
  assert.ok(last(news, "won"), "l'objectif atteint remonte");
}

// Redimensionner : le bac change de moteur, les frames changent de taille.
{
  const { sim, news } = bac();
  sim.order({ t: "size", w: 40, h: 30, keep: true });
  sim.frame(16);
  const frame = last(news, "frame")!;
  assert.deepEqual([frame.w, frame.h], [40, 30], "la frame suit la nouvelle grille");
  assert.equal(area(frame), 40 * 30, "et la première frame du nouveau moteur est entière");
  assert.equal(count(sim.engine, STONE), 0, "« keep » ne regraîne pas");
}

// Les réglages passent au moteur ; la copie de secours de la grille part quand le bac change.
{
  const { sim, news } = bac();
  sim.order({ t: "set", k: { wind: 0.5, ambient: -30, gravity: -1 } });
  assert.equal(sim.engine.wind, 0.5, "le vent est arrivé au moteur");
  assert.equal(sim.engine.ambient, -30, "l'ambiante aussi");
  assert.equal(sim.engine.gravity, -1, "et la gravité");
  run(sim, 20);
  assert.ok(last(news, "grid")!.full.length > 0, "la copie de secours part quand le bac a changé");
  assert.equal(last(news, "grid")!.w, W, "avec la largeur du bac qui l'a faite : rangée sous une autre, elle revenait cisaillée");
}

/** Sauvegarde et lien demandent une grille fraîche : l'ordre `grid` rend celle de l'instant, décodable en la même matière. */
{
  const { sim, news } = bac();
  sim.order({ t: "do", g: { t: "rect", x: 2, y: 2, x2: 9, y2: 4, id: WATER, over: true } });
  sim.order({ t: "grid", ask: 42 });
  const reply = last(news, "reply")!;
  assert.equal(reply.ask, 42, "la réponse porte la question");
  assert.deepEqual(decode(reply.value as string, W * H), sim.engine.cells, "la grille de l'instant, geste compris");
}

/**
 * Un salon en lockstep : l'hôte et un invité, reliés comme le ferait room.ts
 * (départ et suite vers l'invité, gestes et demandes de départ vers l'hôte),
 * le réseau en moins. L'invité suit à son rythme : on ne le compare qu'au
 * tick où il est.
 */
function salon(): { hôte: Sandbox; invité: Sandbox; relayer(): void; desyncs: () => number } {
  const versInvité: News[] = [];
  const hôte = new Sandbox(W, H, (n) => { if (n.t === "start" || n.t === "turn") versInvité.push(n); });
  let desyncs = 0;
  const invité = new Sandbox(W, H, (n) => { if (n.t === "desync") desyncs++; });
  invité.order({ t: "do", g: { t: "rect", x: 0, y: 0, x2: W - 1, y2: 10, id: SAND, over: true } });
  hôte.order({ t: "host", on: true });
  const relayer = (): void => {
    for (const n of versInvité.splice(0)) {
      if (n.t === "start") invité.order({ t: "follow", rec: structuredClone(n.rec) });
      if (n.t === "turn") invité.order(structuredClone(n));
    }
  };
  relayer();
  return { hôte, invité, relayer, desyncs: () => desyncs };
}

/** Fait tourner les deux bacs, frame par frame, le relais entre les deux. */
function jouer(s: ReturnType<typeof salon>, frames: number): void {
  for (let n = 0; n < frames; n++) {
    s.hôte.frame(16);
    s.relayer();
    s.invité.frame(16);
  }
}

// Gestes, réglages, vider, décor : l'invité retombe sur la grille de l'hôte, au
// tick près, sans jamais recevoir de grille après le départ (sauf pour vider).
{
  const s = salon();
  assert.equal(count(s.invité.engine, SAND), count(s.hôte.engine, SAND), "le départ pose la grille de l'hôte");
  jouer(s, 30);
  s.hôte.order({ t: "do", g: { t: "paint", x: 40, y: 4, r: 5, id: WATER, d: 1, over: true } });
  jouer(s, 30);
  s.hôte.order({ t: "set", k: { wind: 0.8, gravity: -1, weather: 3 } });
  jouer(s, 60);
  s.hôte.order({ t: "edit", do: "clear" });
  s.hôte.order({ t: "do", g: { t: "rect", x: 10, y: 10, x2: 30, y2: 14, id: SAND, over: true } });
  s.hôte.order({ t: "set", k: { wind: 0, gravity: 1, weather: 0 } });
  jouer(s, 120);
  s.hôte.order({ t: "set", k: { running: false } });
  jouer(s, 40);
  assert.deepEqual(s.invité.engine.cells, s.hôte.engine.cells, "même matière, cellule pour cellule");
  assert.deepEqual(s.invité.engine.temp, s.hôte.engine.temp, "mêmes températures");
  assert.equal(s.invité.engine.seed, s.hôte.engine.seed, "même tirage au sort");
  assert.equal(s.desyncs(), 0, "et les empreintes n'ont jamais divergé");
}

// L'invité ne touche pas à son bac : ses ordres le feraient diverger pour de bon.
{
  const s = salon();
  jouer(s, 10);
  const avant = count(s.invité.engine, WATER);
  s.invité.order({ t: "do", g: { t: "rect", x: 0, y: 0, x2: 20, y2: 20, id: WATER, over: true } });
  s.invité.order({ t: "edit", do: "clear" });
  s.invité.order({ t: "set", k: { gravity: -1 } });
  assert.equal(count(s.invité.engine, WATER), avant, "ni pinceau ni vidage en direct");
  assert.equal(s.invité.engine.gravity, 1, "ni ses réglages : ce sont ceux de l'hôte");
  s.invité.order({ t: "follow", rec: null });
  assert.equal(s.invité.engine.gravity, -1, "rendus au panneau quand il quitte le salon");
}

// Un pair envoie ce qu'il veut : un geste d'invité illisible est écarté par
// l'hôte avant d'être relayé, et une suite de partie mal formée par l'invité.
{
  const s = salon();
  jouer(s, 10);
  const bruts: unknown[] = [
    { t: "clip", x: 1, y: 1, w: 2, h: 2, cells: "!!", life: "AAA" },
    { t: "clip", x: 1, y: 1, w: 2, h: 2, cells: null, life: 5 },
    { t: "paint", x: "3", y: 4, r: 2, id: SAND, d: 1, over: true },
    { t: "inconnu" },
    null,
  ];
  for (const g of bruts) assert.doesNotThrow(() => s.hôte.order({ t: "do", g: g as never }), `l'hôte encaisse ${JSON.stringify(g)}`);
  const junk = [
    { ticks: 5, beats: [{ at: 0, grid: 5, clock: null }], sums: [] },
    { ticks: 5, beats: [], sums: 7 },
    { ticks: 5, beats: [], sums: [3] },
    { ticks: 5, beats: [{ at: 0, g: { t: "clip", x: 0, y: 0, w: 1, h: 1, cells: "!!", life: "" } }], sums: [] },
    { ticks: NaN, beats: "x", sums: [] },
  ];
  for (const t of junk) assert.doesNotThrow(() => { s.invité.order({ t: "turn", ...t } as never); s.invité.frame(16); }, `l'invité encaisse ${JSON.stringify(t)}`);
  assert.doesNotThrow(() => s.invité.order({ t: "follow", rec: { v: 1, w: W, h: H, grid: 5 } as never }), "un départ illisible aussi");
  const s2 = salon();
  jouer(s2, 10);
  for (const g of bruts) s2.hôte.order({ t: "do", g: g as never });
  s2.hôte.order({ t: "do", g: { t: "rect", x: 10, y: 10, x2: 30, y2: 14, id: WATER, over: true } });
  jouer(s2, 60);
  s2.hôte.order({ t: "set", k: { running: false } });
  jouer(s2, 40);
  assert.deepEqual(s2.invité.engine.cells, s2.hôte.engine.cells, "les gestes écartés ne font pas diverger le salon");
  assert.equal(s2.desyncs(), 0, "ni rejeter la suite de partie");
}

// Un invité qui a divergé le voit à l'empreinte suivante, et le dit une fois.
{
  const s = salon();
  jouer(s, 5);
  s.invité.engine.cells[0] = s.invité.engine.cells[0] === SAND ? WATER : SAND;
  jouer(s, 140);
  assert.equal(s.desyncs(), 1, "la divergence est signalée, une seule fois");
}

// Enregistrer puis rejouer : le bac retombe sur la même grille.
{
  const { sim, news } = bac();
  sim.order({ t: "rec", on: true });
  run(sim, 10);
  sim.order({ t: "do", g: { t: "paint", x: 40, y: 4, r: 5, id: WATER, d: 1, over: true } });
  run(sim, 30);
  sim.order({ t: "rec", on: false });
  const film = last(news, "rec")!;
  assert.ok(film.ticks > 0 && film.beats > 0, "la partie a des ticks et des événements");
  assert.deepEqual([film.w, film.h], [W, H], "et sa taille, pour que la page puisse s'y remettre");

  const empreinte = count(sim.engine, WATER);
  sim.order({ t: "edit", do: "clear" });
  assert.equal(count(sim.engine, WATER), 0, "on vide le bac");
  sim.order({ t: "play", on: true });
  assert.equal(last(news, "play")!.on, true, "le rejeu démarre");
  run(sim, 200); // largement de quoi le finir
  assert.equal(last(news, "play")!.on, false, "et s'arrête tout seul à la fin");
  assert.equal(count(sim.engine, WATER), empreinte, "avec la même eau qu'à l'enregistrement");
}

// Pendant un rejeu, le pinceau ne touche plus au bac.
{
  const { sim } = bac();
  sim.order({ t: "rec", on: true });
  run(sim, 5);
  sim.order({ t: "rec", on: false });
  sim.order({ t: "play", on: true });
  sim.order({ t: "do", g: { t: "rect", x: 0, y: 0, x2: 10, y2: 10, id: SAND, over: true } });
  assert.equal(count(sim.engine, SAND), 0, "le geste est ignoré, sinon le rejeu divergerait");
}

/** Un bac avec une partie enregistrée, prête à rejouer. */
function filmé(): { sim: Sandbox; news: News[] } {
  const b = bac();
  b.sim.order({ t: "rec", on: true });
  run(b.sim, 20);
  b.sim.order({ t: "rec", on: false });
  return b;
}

// La pause arrête aussi un rejeu, et « Pas à pas » l'avance d'un tick.
{
  const { sim, news } = filmé();
  sim.order({ t: "set", k: { running: false } });
  sim.order({ t: "play", on: true });
  run(sim, 200);
  assert.equal(last(news, "play")!.on, true, "en pause, le rejeu attend au lieu de filer jusqu'au bout");
  for (let n = 0; n < 25; n++) sim.order({ t: "edit", do: "step" });
  assert.equal(last(news, "play")!.on, false, "pas à pas, il avance, jusqu'à sa fin");
}

// Vider pendant un rejeu l'arrête d'abord : il continuait sinon sur une grille
// qu'il n'avait pas enregistrée.
{
  const { sim, news } = filmé();
  sim.order({ t: "play", on: true });
  sim.order({ t: "edit", do: "clear" });
  assert.equal(last(news, "play")!.on, false, "le rejeu s'arrête");
  assert.equal(count(sim.engine, STONE), 0, "et le bac est bien vidé");
}

// Après un rejeu, le moteur reprend les réglages du panneau, pas ceux de
// l'enregistrement : sinon le bouton Gravité disait l'inverse du bac.
{
  const { sim } = filmé();
  sim.order({ t: "set", k: { gravity: -1, wind: 0.3 } });
  sim.order({ t: "play", on: true });
  assert.equal(sim.engine.gravity, 1, "le rejeu joue avec la gravité enregistrée");
  sim.order({ t: "play", on: false });
  assert.equal(sim.engine.gravity, -1, "puis rend celle du panneau");
  assert.equal(sim.engine.wind, 0.3, "et son vent");
}

// Vider abandonne le défi en cours : Débâcle vidé n'a plus de glace, il était
// gagné d'avance. Charger un autre monde aussi.
{
  const { sim, news } = bac();
  sim.order({ t: "size", w: 320, h: 180, keep: true }); // les défis sont écrits pour 320×180
  sim.order({ t: "scene", name: "Débâcle" });
  sim.order({ t: "edit", do: "clear" });
  run(sim, 40);
  assert.equal(last(news, "won"), undefined, "un bac vidé ne gagne pas le défi");

  sim.order({ t: "goal", goal: `ge:${SAND}:10` });
  sim.order({ t: "load", data: "AQI", ask: 1 });
  sim.order({ t: "do", g: { t: "rect", x: 2, y: 2, x2: 20, y2: 4, id: SAND, over: true } });
  run(sim, 40);
  assert.equal(last(news, "won"), undefined, "l'objectif d'un monde ne suit pas dans le suivant");
}

// Un défi se bâtit à 20 °C : l'ambiante baissée avant de lancer « Grand froid »
// bâtissait le lac déjà gelé, gagné au premier tick.
{
  const { sim } = bac();
  sim.order({ t: "size", w: 320, h: 180, keep: true });
  sim.order({ t: "set", k: { ambient: -60 } });
  sim.order({ t: "scene", name: "Grand froid" });
  assert.ok(count(sim.engine, WATER) > 0, "le lac est bâti liquide");
  assert.equal(sim.engine.temp[sim.engine.index(160, 150)], 20, "à 20 °C");
  assert.equal(sim.engine.ambient, -60, "et l'ambiante du panneau revient aussitôt");
}

// Le classement des défis : la victoire d'un défi livré remonte avec la
// partie depuis sa construction, et le juge (sim/verdict.ts) la rejoue dans
// un moteur neuf — autre graine, autre fil — pour y croire.
{
  const gagne = (ambient: number, avant?: (sim: Sandbox) => void): Extract<News, { t: "won" }> | undefined => {
    const { sim, news } = bac();
    sim.order({ t: "size", w: 320, h: 180, keep: true });
    sim.order({ t: "set", k: { ambient } });
    sim.order({ t: "scene", name: "Débâcle" });
    run(sim, 10);
    avant?.(sim);
    // La glace et la neige effacées d'un geste : Débâcle gagné.
    sim.order({ t: "do", g: { t: "rect", x: 90, y: 90, x2: 230, y2: 150, id: EMPTY, over: true } });
    run(sim, 40);
    return last(news, "won");
  };
  const won = gagne(-10);
  assert.ok(won?.film, "la victoire remonte avec sa partie");
  const film = won.film;
  assert.ok(fair(film) && film.ticks > 10, `une partie recevable, depuis la construction (${film.ticks} ticks)`);
  assert.equal(film.scene.ambient, -10, "l'ambiante du panneau est dans la partie, le défi bâti à 20 °C");
  assert.ok(verdict("Débâcle", film, film.ticks), "le juge la rejoue et la trouve gagnante");
  assert.ok(!verdict("Débâcle", film, film.ticks - 1), "pas en moins de ticks qu'annoncé");
  assert.ok(!verdict("Grand froid", film, film.ticks), "ni pour un autre défi");
  assert.ok(!verdict("Débâcle", { ...film, beats: [] }, film.ticks), "sans le geste, elle ne gagne pas");
  const ailleurs = bac();
  ailleurs.sim.order({ t: "size", w: 320, h: 180, keep: true });
  ailleurs.sim.order({ t: "scene", name: "Grand froid" });
  const autre = ailleurs.sim.engine;
  const triche = { ...film, grid: encode(autre.cells, autre.frozen, autre.life, autre.temp, autre.names) };
  assert.ok(!verdict("Débâcle", triche, film.ticks), "une partie qui part d'une autre grille ne compte pas");
  assert.ok(!fair({ ...film, ticks: TRIAL_TICKS + 1 }), "ni une partie de plus de cinq minutes");
  assert.ok(!fair({ ...film, beats: [...film.beats, { at: 1, g: { t: "clip", x: 0, y: 0, w: 1, h: 1, cells: "", life: "" } }] }), "ni un morceau collé");

  // Annuler pendant le défi pose une grille d'un coup : la victoire reste, hors classement.
  const annulé = gagne(20, (sim) => {
    sim.order({ t: "do", g: { t: "rect", x: 0, y: 0, x2: 3, y2: 3, id: SAND, over: true } });
    sim.order({ t: "edit", do: "snapshot" });
    sim.order({ t: "edit", do: "undo" });
  });
  assert.ok(annulé, "annuler n'empêche pas de gagner");
  assert.equal(annulé.film, null, "mais la partie n'est pas recevable au classement");
}

console.log("ok — protocole du bac conforme");
