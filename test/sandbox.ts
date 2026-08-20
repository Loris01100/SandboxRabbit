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
import { count } from "../src/client/challenges.ts";
import { EMPTY, SAND, STONE, WATER } from "../src/client/sim/materials.ts";

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

// Une frame par appel, aux dimensions de la grille.
{
  const { sim, news } = bac();
  assert.ok(count(sim.engine, STONE) > 0, "le bac démarre graîné, pas devant du vide");
  sim.frame(16);
  const frame = last(news, "frame")!;
  assert.deepEqual([frame.w, frame.h], [W, H], "la frame porte la taille de la grille");
  assert.equal(frame.pixels.length, W * H * 4, "un pixel RGBA par cellule");
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
  assert.equal(frame.pixels.length, 40 * 30 * 4, "et le tampon de pixels avec");
  assert.equal(count(sim.engine, STONE), 0, "« keep » ne regraîne pas");
}

// Les réglages passent au moteur, la grille encodée revient quatre fois par seconde.
{
  const { sim, news } = bac();
  sim.order({ t: "set", k: { wind: 0.5, ambient: -30, gravity: -1, room: true } });
  assert.equal(sim.engine.wind, 0.5, "le vent est arrivé au moteur");
  assert.equal(sim.engine.ambient, -30, "l'ambiante aussi");
  assert.equal(sim.engine.gravity, -1, "et la gravité");
  run(sim, 20);
  const grid = last(news, "grid")!;
  assert.ok(grid.full.length > 0, "la grille complète part pour la sauvegarde");
  assert.ok(grid.room !== undefined && grid.room.length < grid.full.length,
    "et le salon reçoit la version courte, sans les vies ni les températures");
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

console.log("ok — protocole du bac conforme");
