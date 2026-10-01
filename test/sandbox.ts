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
import { Renderer, land } from "../src/client/sim/render.ts";
import { decode } from "../src/client/sim/codec.ts";
import { count } from "../src/client/challenges.ts";
import { EMPTY, FIRE, HERO, PILOT, SAND, STONE, TNT, WATER } from "../src/client/sim/materials.ts";

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

console.log("ok — protocole du bac conforme");
