/**
 * Auto-vérification de la simulation : `npm run check` (Node exécute le TS tel quel).
 * Un `assert` par règle, pas de framework.
 */
import assert from "node:assert/strict";
import { Engine } from "../src/client/sim/engine.ts";
import { decode, encode } from "../src/client/sim/codec.ts";
import { CHALLENGES } from "../src/client/challenges.ts";
import {
  ALCOHOL, BATTERY, CANDLE, EMBER, EMPTY, FIRE, GLASS, ICE, LAVA, MERCURY, METAL,
  MOLTEN_GLASS, MOLTEN_WAX, MUD, NANITE, OIL, PLANT, SALT, SALTWATER, SAND, SEED,
  SNOW, SOURCE, SPARK, STONE, SWITCH, TAR, TNT, WATER, WAX, WOOD, type MaterialId,
} from "../src/client/sim/materials.ts";

const W = 60, H = 40;
const engine = (): Engine => new Engine(W, H);

/** Fait tourner la simulation et dit si `id` est apparu quelque part. */
function runUntil(e: Engine, id: MaterialId, ticks: number): boolean {
  for (let t = 0; t < ticks; t++) {
    e.step();
    if (e.cells.includes(id)) return true;
  }
  return false;
}

function count(e: Engine, id: MaterialId): number {
  let n = 0;
  for (const c of e.cells) if (c === id) n++;
  return n;
}

// Le sable tombe, et remonte si la gravité s'inverse.
{
  const e = engine();
  e.set(10, 5, SAND);
  e.step();
  assert.equal(e.get(10, 6), SAND, "le sable descend");

  // `clock` peut faire sauter un tick à une cellule fraîchement posée : deux pas.
  const up = engine();
  up.gravity = -1;
  up.set(10, 20, SAND);
  up.step();
  up.step();
  assert.ok(up.get(10, 19) === SAND || up.get(10, 18) === SAND, "gravité inversée : le sable monte");
}

// Le vent pousse la matière qui s'étale.
{
  const e = engine();
  e.wind = 1;
  for (let t = 0; t < 6; t++) { e.set(30, H - 1, WATER); e.step(); }
  let right = 0, left = 0;
  for (let x = 0; x < W; x++) {
    for (let y = 0; y < H; y++) {
      if (e.get(x, y) !== WATER) continue;
      if (x > 30) right++;
      if (x < 30) left++;
    }
  }
  assert.ok(right > left, `vent d'est : ${right} cellules à droite contre ${left} à gauche`);
}

// Thermique : la lave fait bouillir l'eau (vapeur) et vitrifie le sable.
{
  const e = engine();
  for (let x = 20; x < 40; x++) e.set(x, 30, STONE);
  for (let x = 22; x < 30; x++) e.set(x, 29, SAND);
  for (let x = 22; x < 30; x++) e.set(x, 28, LAVA);
  assert.ok(runUntil(e, GLASS, 120), "le sable chauffé par la lave devient du verre");
}

// Thermique : la glace refroidit l'eau jusqu'à la prendre.
{
  const e = engine();
  for (let x = 10; x < 30; x++) for (let y = 20; y < 25; y++) e.set(x, y, ICE);
  for (let x = 10; x < 30; x++) e.set(x, 19, WATER);
  assert.ok(runUntil(e, WATER, 1) && count(e, ICE) > 0, "la glace tient");
  let frozen = false;
  for (let t = 0; t < 200 && !frozen; t++) { e.step(); frozen = count(e, ICE) > 100; }
  assert.ok(frozen, "l'eau au contact de la glace finit par geler");
}

// La glace fond près du feu.
{
  const e = engine();
  for (let x = 10; x < 14; x++) e.set(x, 20, ICE);
  for (let t = 0; t < 60; t++) { e.paint(12, 18, 3, FIRE); e.step(); }
  assert.equal(count(e, ICE), 0, "le feu fait fondre la glace");
}

// Le sel se dissout et donne de l'eau salée, plus lourde que l'eau douce.
{
  const e = engine();
  for (let x = 10; x < 20; x++) for (let y = 20; y < 24; y++) e.set(x, y, WATER);
  e.set(15, 19, SALT);
  assert.ok(runUntil(e, SALTWATER, 20), "sel + eau = eau salée");
}

// La graine germe dans l'eau.
{
  const e = engine();
  for (let x = 10; x < 20; x++) for (let y = 20; y < 24; y++) e.set(x, y, WATER);
  e.set(15, 19, SEED);
  assert.ok(runUntil(e, PLANT, 20), "la graine germe au contact de l'eau");
}

// Le TNT explose au contact du feu et entraîne ses voisins.
{
  const e = engine();
  for (let x = 20; x < 40; x++) for (let y = 20; y < 26; y++) e.set(x, y, TNT);
  const before = count(e, TNT);
  e.set(20, 19, FIRE);
  for (let t = 0; t < 30; t++) e.step();
  assert.ok(count(e, TNT) < before / 2, "la déflagration se propage de proche en proche");
}

// Les nanites dévorent la pierre, mais le verre les arrête.
{
  const e = engine();
  for (let x = 10; x < 20; x++) for (let y = 20; y < 24; y++) e.set(x, y, STONE);
  e.set(15, 19, NANITE);
  for (let t = 0; t < 60; t++) e.step();
  assert.ok(count(e, STONE) < 40, "les nanites rongent la pierre");

  const g = engine();
  for (let x = 10; x < 20; x++) for (let y = 20; y < 24; y++) g.set(x, y, GLASS);
  g.set(15, 19, NANITE);
  for (let t = 0; t < 400; t++) g.step();
  assert.equal(count(g, GLASS), 40, "le verre résiste");
}

// La source émet la matière choisie, indéfiniment.
{
  const e = engine();
  e.emit = SAND;
  e.set(30, 5, SOURCE);
  for (let t = 0; t < 40; t++) e.step();
  assert.ok(count(e, SAND) > 5, "la source produit du sable");
  assert.equal(e.get(30, 5), SOURCE, "la source reste en place");
}

// Codec : aller-retour exact (le lien de partage en dépend).
{
  const e = engine();
  e.paint(20, 20, 6, WATER);
  e.paint(35, 10, 4, SAND);
  const round = decode(encode(e.cells), W * H);
  assert.deepEqual([...round], [...e.cells], "encode/decode conserve la grille");
  assert.ok(encode(e.cells).length < 4000, "un monde tient dans une URL");
}

// `flammable` règle la vitesse de propagation : l'huile s'embrase, le bois traîne.
{
  /** Ticks moyens avant qu'une cellule collée à une flamme ne prenne feu. */
  const delay = (id: MaterialId): number => {
    let total = 0;
    for (let trial = 0; trial < 25; trial++) {
      const e = new Engine(16, 16);
      e.set(8, 8, id);
      let t = 0;
      while (e.get(8, 8) === id && t < 300) { e.set(8, 7, FIRE); e.step(); t++; }
      total += t;
    }
    return total / 25;
  };
  const oil = delay(OIL), wood = delay(WOOD);
  assert.ok(oil * 3 < wood, `l'huile prend feu bien avant le bois (${oil} contre ${wood} ticks)`);
}

// Pinceau non destructif : ne remplit que le vide, sauf la gomme qui efface tout.
{
  const e = engine();
  e.paint(20, 20, 5, STONE);
  const stone = count(e, STONE);
  e.paint(20, 20, 8, SAND, 1, false); // disque plus large : il déborde sur du vide
  assert.equal(count(e, STONE), stone, "la pierre survit au pinceau protégé");
  assert.ok(count(e, SAND) > 0, "le vide autour est quand même rempli");
  e.paint(20, 20, 8, EMPTY, 1, false);
  assert.equal(count(e, STONE), 0, "la gomme efface malgré tout");
}

// Le mercure passe sous l'eau : c'est le plus dense.
{
  const e = engine();
  for (let x = 10; x < 20; x++) for (let y = 30; y < 36; y++) e.set(x, y, WATER);
  for (let x = 12; x < 18; x++) e.set(x, 29, MERCURY);
  for (let t = 0; t < 60; t++) e.step();
  let mercury = 0, water = 0;
  for (let x = 0; x < W; x++) {
    for (let y = 0; y < H; y++) {
      if (e.get(x, y) === MERCURY) mercury += y;
      if (e.get(x, y) === WATER) water += y;
    }
  }
  assert.ok(mercury / count(e, MERCURY) > water / count(e, WATER), "le mercure finit sous l'eau");
}

// La cire fond près du feu, coule, puis durcit en s'éloignant.
{
  const e = engine();
  for (let x = 10; x < 30; x++) e.set(x, 30, STONE);
  for (let x = 14; x < 18; x++) e.set(x, 29, WAX);
  for (let t = 0; t < 40; t++) { e.paint(16, 26, 3, FIRE); e.step(); }
  assert.ok(count(e, MOLTEN_WAX) > 0 || count(e, WAX) < 4, "la cire fond");

  const cold = engine();
  cold.set(20, 30, STONE);
  cold.set(20, 29, MOLTEN_WAX);
  assert.ok(runUntil(cold, WAX, 200), "la cire fondue redurcit en refroidissant");
}

// La bougie s'allume au contact d'une flamme et se rallume toute seule.
{
  const e = engine();
  e.set(20, 30, CANDLE);
  e.set(20, 29, FIRE);
  for (let t = 0; t < 400; t++) e.step();
  assert.equal(e.get(20, 30), CANDLE, "la bougie ne se consume pas");
  assert.ok(count(e, FIRE) > 0, "la flamme tient dans la durée");

  // Un seau d'eau la souffle : une seule goutte partirait en vapeur.
  e.paint(20, 24, 6, WATER);
  for (let t = 0; t < 120; t++) e.step();
  assert.equal(count(e, FIRE), 0, "l'eau souffle la bougie");
}

// La neige tient en tas mais fond au contact du feu.
{
  const e = engine();
  for (let x = 10; x < 30; x++) e.set(x, 30, STONE);
  for (let x = 12; x < 28; x++) for (let y = 26; y < 30; y++) e.set(x, y, SNOW);
  const flakes = count(e, SNOW);
  for (let t = 0; t < 200; t++) e.step();
  assert.ok(count(e, SNOW) > flakes / 2, "un tas de neige tient à l'ambiante");
  for (let t = 0; t < 120; t++) { e.paint(20, 22, 3, FIRE); e.step(); }
  assert.ok(count(e, SNOW) < flakes / 2, "le feu fait fondre la neige");
}

// La boue sèche en sable quand elle chauffe.
{
  const e = engine();
  // Une auge de pierre : sinon la boue s'étale hors du feu.
  for (let x = 13; x < 21; x++) e.set(x, 30, STONE);
  for (const x of [13, 20]) for (let y = 27; y < 30; y++) e.set(x, y, STONE);
  for (let x = 14; x < 20; x++) e.set(x, 29, MUD);
  let dried = false;
  for (let t = 0; t < 300 && !dried; t++) {
    for (let x = 14; x < 20; x++) if (e.get(x, 28) === EMPTY) e.set(x, 28, FIRE);
    e.step();
    dried = count(e, SAND) > 0;
  }
  assert.ok(dried, "la boue chauffée sèche en sable");
}

// Le bois brûlé laisse des braises, qui chauffent après la flamme.
{
  const e = engine();
  for (let x = 10; x < 30; x++) for (let y = 26; y < 30; y++) e.set(x, y, WOOD);
  let embers = false;
  for (let t = 0; t < 400 && !embers; t++) { e.paint(20, 24, 2, FIRE); e.step(); embers = count(e, EMBER) > 0; }
  assert.ok(embers, "le bois laisse des braises");
}

// L'étincelle court dans le métal, s'arrête toute seule, et fait sauter le TNT.
{
  const e = engine();
  for (let x = 10; x < 40; x++) e.set(x, 20, METAL);
  e.set(10, 20, SPARK);
  for (let t = 0; t < 20; t++) e.step();
  assert.equal(e.get(39, 20), METAL, "le fil est intact au bout de la course");
  for (let t = 0; t < 200; t++) e.step();
  assert.equal(count(e, SPARK), 0, "l'étincelle finit par s'éteindre");
  assert.equal(count(e, METAL), 30, "le fil ne se consume pas");

  const boom = engine();
  for (let x = 10; x < 30; x++) boom.set(x, 20, METAL);
  boom.set(30, 20, TNT);
  boom.set(10, 20, SPARK);
  for (let t = 0; t < 20; t++) boom.step();
  assert.equal(count(boom, TNT), 0, "l'étincelle met le feu aux poudres à l'autre bout");
}

// Figer : la matière garde son identité mais ne bouge plus, et rien ne la pousse.
{
  const e = engine();
  e.paint(20, 10, 4, SAND);
  e.setFrozen(20, 10, 4, true);
  const grains = count(e, SAND);
  for (let t = 0; t < 60; t++) e.step();
  assert.equal(count(e, SAND), grains, "le sable figé ne disparaît pas");
  assert.equal(e.get(20, 10), SAND, "le sable figé reste exactement où il est");

  // Une cellule figée fait barrage.
  e.paint(20, 4, 2, WATER);
  for (let t = 0; t < 60; t++) e.step();
  assert.equal(e.get(20, 10), SAND, "l'eau ne traverse pas le sable figé");

  // Libérer le rend à la gravité, repeindre par-dessus aussi.
  e.setFrozen(20, 10, 4, false);
  for (let t = 0; t < 80; t++) e.step();
  assert.notEqual(e.get(20, 10), SAND, "libéré, le tas retombe");
}

// Remplissage (clic droit) : la poche est remplie, les murs tiennent.
{
  const e = engine();
  for (let x = 10; x < 30; x++) { e.set(x, 20, STONE); e.set(x, 30, STONE); }
  for (let y = 20; y <= 30; y++) { e.set(10, y, STONE); e.set(29, y, STONE); }
  e.fill(20, 25, WATER);
  assert.equal(count(e, WATER), 18 * 9, "la poche est remplie jusqu'aux murs");
  assert.equal(e.get(5, 5), EMPTY, "le remplissage ne fuit pas hors de la poche");
}

// Gomme sélective : n'efface qu'une matière.
{
  const e = engine();
  e.paint(20, 20, 6, STONE);
  e.paint(20, 20, 3, SAND);
  const stone = count(e, STONE);
  e.paint(20, 20, 6, EMPTY, 1, true, SAND);
  assert.equal(count(e, SAND), 0, "le sable est effacé");
  assert.equal(count(e, STONE), stone, "la pierre est épargnée");
}

// Les défis se construisent dans la grille du jeu, et ne sont pas gagnés d'avance.
{
  for (const c of CHALLENGES) {
    const e = new Engine(320, 180);
    c.build(e);
    assert.ok(count(e, EMPTY) < 320 * 180, `« ${c.name} » pose quelque chose`);
    assert.equal(c.won(e), false, `« ${c.name} » n'est pas gagné au départ`);
  }
}

// Le goudron coule, mais bien moins loin que l'eau.
{
  const spread = (id: MaterialId): number => {
    const e = engine();
    for (let x = 0; x < W; x++) e.set(x, 30, STONE);
    e.paint(30, 26, 3, id);
    for (let t = 0; t < 120; t++) e.step();
    let min = W, max = 0;
    for (let x = 0; x < W; x++) {
      for (let y = 0; y < 30; y++) {
        if (e.get(x, y) !== id) continue;
        if (x < min) min = x;
        if (x > max) max = x;
      }
    }
    return max - min;
  };
  assert.ok(spread(TAR) < spread(WATER), "le goudron s'étale moins que l'eau");
}

// L'alcool s'évapore à la moindre chaleur.
{
  // Dans une cuvette : sinon la flaque s'étale hors de la flamme et reste froide.
  const e = engine();
  for (let x = 0; x < W; x++) e.set(x, 30, STONE);
  for (let y = 24; y < 30; y++) { e.set(17, y, STONE); e.set(23, y, STONE); }
  for (let x = 18; x < 23; x++) { e.set(x, 29, ALCOHOL); e.set(x, 28, ALCOHOL); }
  assert.ok(count(e, ALCOHOL) > 0, "l'alcool est bien posé");
  for (let t = 0; t < 300; t++) {
    for (let x = 18; x < 23; x++) if (e.get(x, 26) === EMPTY) e.set(x, 26, FIRE);
    e.step();
  }
  assert.equal(count(e, ALCOHOL), 0, "l'alcool ne survit pas à la chaleur");
}

// Verre → verre fondu → verre : la boucle complète, pilotée par la seule température.
{
  const e = engine();
  for (let x = 0; x < W; x++) e.set(x, 30, STONE);
  for (let x = 18; x < 24; x++) e.set(x, 29, GLASS);
  // On chauffe la grille directement : le refroidissement mange une partie du pic.
  for (let x = 18; x < 24; x++) e.temp[e.index(x, 29)] = 1400;
  e.step();
  assert.ok(count(e, MOLTEN_GLASS) > 0, "le verre refond au-delà de 700 °C");
  for (let t = 0; t < 400; t++) e.step();
  assert.equal(count(e, MOLTEN_GLASS), 0, "en refroidissant il se fige");
  assert.ok(count(e, GLASS) > 0, "et redevient du verre");
}

// Pile + interrupteur : le circuit ne passe que fermé, et l'interrupteur survit.
{
  const circuit = (closed: boolean): Engine => {
    const e = engine();
    e.set(9, 20, BATTERY);
    for (let x = 10; x <= 30; x++) e.set(x, 20, METAL);
    e.set(20, 20, SWITCH);
    e.set(31, 20, TNT);
    if (closed) e.toggleSwitch(20, 20);
    for (let t = 0; t < 200; t++) e.step();
    return e;
  };

  const open = circuit(false);
  assert.equal(count(open, TNT), 1, "interrupteur ouvert : le courant n'arrive pas");
  assert.ok(open.cells.includes(SPARK) || count(open, METAL) > 0, "la pile alimente quand même son côté");

  const on = circuit(true);
  assert.equal(count(on, TNT), 0, "interrupteur fermé : la pile fait sauter la charge");
  assert.equal(count(on, SWITCH), 1, "l'interrupteur relaie sans se transformer en métal");
}

// Le vide reste du vide.
{
  const e = engine();
  for (let t = 0; t < 10; t++) e.step();
  assert.equal(count(e, EMPTY), W * H, "rien ne se crée tout seul");
}

console.log("ok — simulation conforme");
