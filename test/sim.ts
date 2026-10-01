/**
 * Auto-vérification de la simulation : `npm run check` (Node exécute le TS tel quel).
 * Un `assert` par règle, pas de framework.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Engine } from "../src/client/sim/engine.ts";
import { decode, decodeFrozen, decodeLife, decodeNames, decodeTemp, encode } from "../src/client/sim/codec.ts";
import { CLOCK, DAY, HOURS, clockAt, Renderer, hourTint, lighting, thumbnail } from "../src/client/sim/render.ts";
import { FlatLight } from "../src/client/sim/flatlight.ts";
import { CHALLENGES, SCENES } from "../src/client/challenges.ts";
import { applyGesture, heroName, weather, type Gesture } from "../src/client/gestures.ts";
import { FILM_MAX, Player, Recorder, pack, parse, put, unpack, vet, type Recording } from "../src/client/replay.ts";
import { terrain } from "../src/client/terrain.ts";
import {
  MATERIALS, CATEGORIES, PALETTE, SHORTCUTS,
  ALCOHOL, BATTERY, C4, CANDLE, EMBER, EMPTY, FIRE, FIREDAMP, GLASS, ICE, LAVA, MERCURY, METAL, MINE, NITRO, THERMITE,
  MOLTEN_GLASS, MOLTEN_WAX, MUD, NANITE, NITROGEN, OIL, PLANT, SALT, SALTWATER, SAND, SEED, SMOKE,
  ACID, STEAM, HERO_HEAD, HERO_BODY, HERO_LEGS,
  CEMENT, FILINGS, RUST, SODIUM, HERO, HERO_HARM, HERO_SLOTS, MAGNET, PILOT, RABBIT, RABBIT_BODY, RABBIT_EYE, RABBIT_TAIL, SNOW, SOURCE, SPARK, PETROLEUM, URANIUM, FALLOUT, STONE, SWITCH, TAR, TNT, WATER, WAX, WOOD, type MaterialId,
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

// Le TNT explose au contact du feu et entraîne ses voisins. Graine fixe : au
// hasard, une fois sur 4 000 la flamme s'envolait sans toucher la charge.
{
  const e = new Engine(W, H, 1234);
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
  const plain = encode(e.cells);
  assert.equal(encodeURIComponent(plain).length, plain.length, "base64url : rien à échapper dans une URL");

  // Une grande étendue vide passe par l'échappe 16 bits, pas par une paire
  // tous les 255 pixels.
  assert.ok(encode(new Uint8Array(W * H)).length < 12, "un monde vide tient en une poignée d'octets");
  // Format d'avant l'échappe (paires id/longueur, longueurs 1..255) : toujours lisible.
  assert.deepEqual(
    [...decode(btoa(String.fromCharCode(2, 3, 1, 2)), 5)],
    [2, 2, 2, 1, 1],
    "les mondes enregistrés avant l'échappe se relisent",
  );

  // Le figé voyage dans un second bloc, et un monde d'avant reste lisible.
  e.setFrozen(20, 20, 4, true);
  const data = encode(e.cells, e.frozen);
  assert.deepEqual([...decode(data, W * H)], [...e.cells], "le second bloc ne casse pas la grille");
  assert.deepEqual([...decodeFrozen(data, W * H)], [...e.frozen], "le figé fait l'aller-retour");
  assert.ok(!decodeFrozen(encode(e.cells), W * H).some(Boolean), "sans figé, grille vide");

  // État vivant : un incendie enregistré doit repartir chaud.
  assert.equal(decodeLife(data, W * H), null, "deux blocs : pas d'état vivant");
  e.paint(30, 10, 3, FIRE);
  for (let t = 0; t < 5; t++) e.step();
  const full = encode(e.cells, e.frozen, e.life, e.temp);
  assert.deepEqual([...decode(full, W * H)], [...e.cells], "la matière survit aux quatre blocs");
  assert.deepEqual([...decodeFrozen(full, W * H)], [...e.frozen], "le figé aussi");
  assert.deepEqual([...decodeLife(full, W * H)!], [...e.life], "les vies font l'aller-retour");
  const temp = decodeTemp(full, W * H)!;
  let worst = 0;
  for (let i = 0; i < temp.length; i++) worst = Math.max(worst, Math.abs(temp[i] - e.temp[i]));
  assert.ok(worst <= 4, `la température revient à 4 °C près (${worst.toFixed(1)})`);
  assert.ok(Math.max(...temp) > 300, "et le feu est toujours chaud");
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

// Un rayon délirant coûte la grille, pas le rayon : sans ça un pair de salon
// figeait l'onglet de l'hôte (`applyGesture` relaie le rayon tel quel).
{
  const e = engine();
  const debut = Date.now();
  e.paint(30, 20, 1e9, SAND);
  e.setFrozen(30, 20, 1e9, true);
  assert.ok(Date.now() - debut < 500, "un rayon d'un milliard ne fait pas boucler le moteur");
  assert.equal(count(e, SAND), W * H, "et il peint quand même toute la grille");
  e.paint(30, 20, NaN, WATER);
  e.paint(30, 20, -5, WATER);
  assert.equal(count(e, SAND), W * H, "un rayon NaN ou négatif ne peint rien");
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

// Une colonne de sable qui tombe reste pleine en passant les frontières de blocs du damier (y = 32, 96…), au lieu d'une rangée sur deux.
{
  const e = new Engine(40, 130, 1);
  e.rect(17, 2, 23, 12, SAND);
  for (let t = 0; t < 90; t++) e.step();
  const rangées = new Set<number>();
  for (let y = 0; y < 130; y++) for (let x = 0; x < 40; x++) if (e.get(x, y) === SAND) rangées.add(y);
  assert.equal(rangées.size, 11, `onze rangées pleines après la chute (${rangées.size})`);
  assert.equal(count(e, SAND), 77, "aucun grain perdu");
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

// Orage : l'éclair descend en feu à travers la pluie et électrise le métal qu'il frappe ; la pluie seule n'en lance pas.
{
  const e = engine();
  for (let x = 0; x < e.width; x++) e.set(x, e.height - 1, METAL);
  for (let t = 0; t < 1000; t++) weather(e, 1);
  assert.equal(count(e, FIRE) + count(e, SPARK), 0, "pas d'éclair sous la simple pluie");
  for (let t = 0; t < 5000 && count(e, SPARK) === 0; t++) weather(e, 3);
  assert.equal(count(e, SPARK), 1, "l'éclair frappe le métal");
  assert.ok(count(e, FIRE) >= e.height - 2, "et laisse un trait de feu du ciel au sol");
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

// Les décors surprises se posent et tiennent quelques secondes sans exploser
// la grille (une scène qui se vide toute seule n'est pas une scène).
{
  for (const scene of SCENES) {
    const e = new Engine(320, 180);
    scene.build(e);
    const posed = 320 * 180 - count(e, EMPTY);
    assert.ok(posed > 2000, `« ${scene.name} » pose quelque chose (${posed})`);
    for (let t = 0; t < 120; t++) e.step();
    assert.ok(320 * 180 - count(e, EMPTY) > posed / 3, `« ${scene.name} » tient la route`);
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

// L'azote liquide gèle l'eau qu'il touche, puis s'évapore.
{
  const e = engine();
  for (let x = 0; x < W; x++) e.set(x, 30, STONE);
  for (let x = 10; x < 30; x++) for (let y = 27; y < 30; y++) e.set(x, y, WATER);
  for (let x = 12; x < 28; x++) e.set(x, 26, NITROGEN);

  for (let t = 0; t < 40; t++) e.step();
  assert.ok(count(e, ICE) > 20, "l'azote gèle la flaque");

  // Il ne tient pas : dès qu'il touche plus chaud que -60 °C il part en buée.
  // Quelques cellules peuvent survivre, piégées dans le froid qu'elles ont créé.
  for (let t = 0; t < 400; t++) e.step();
  assert.ok(count(e, NITROGEN) < 8, "puis il s'évapore presque entièrement");
}

// Le souffle projette au lieu d'effacer : quand la matière a où aller, elle est
// déplacée, pas supprimée. Enterrée au même endroit, elle n'a plus le choix.
{
  const loss = (depth: number): number => {
    const e = engine();
    for (let x = 0; x < W; x++) for (let y = 20; y < H; y++) e.set(x, y, SAND);
    const before = count(e, SAND);
    e.explode(30, 20 + depth, 7);
    return before - count(e, SAND);
  };
  assert.ok(loss(0) < loss(12) * 0.7, "à l'air libre, le souffle déplace plus qu'il ne détruit");
}

// Mais un mur plein est toujours percé : sans ce repli, une charge ne servirait plus à rien.
{
  const e = engine();
  for (let x = 0; x < W; x++) for (let y = 20; y < H; y++) e.set(x, y, STONE);
  const before = count(e, STONE);
  e.explode(30, 30, 7);
  assert.ok(before - count(e, STONE) > 80, "ce qui n'a nulle part où aller est pulvérisé");
}

// Nitroglycérine : posée elle dort, lâchée de trois cellules elle détonne.
{
  const e = engine();
  for (let x = 0; x < W; x++) e.set(x, 30, STONE);
  for (let x = 20; x < 26; x++) e.set(x, 29, WOOD);
  for (let x = 20; x < 26; x++) e.set(x, 28, NITRO); // déposée à même le bois
  for (let t = 0; t < 60; t++) e.step();
  assert.equal(count(e, WOOD), 6, "posée, la nitro ne fait rien");

  const drop = engine();
  for (let x = 0; x < W; x++) drop.set(x, 30, STONE);
  for (let x = 20; x < 26; x++) drop.set(x, 29, WOOD);
  for (let x = 21; x < 25; x++) drop.set(x, 10, NITRO); // vingt cellules plus haut
  for (let t = 0; t < 60; t++) drop.step();
  // Sur la planche, pas dans la grille : le souffle en projette parfois un éclat plus loin.
  let intact = 0;
  for (let x = 20; x < 26; x++) if (drop.get(x, 29) === WOOD) intact++;
  assert.equal(intact, 0, "lâchée, elle emporte la planche à l'impact");
}

// C4 : insensible au feu, il n'obéit qu'à l'étincelle — et le mur part en entier.
{
  const e = engine();
  for (let x = 20; x < 30; x++) e.set(x, 20, C4);
  for (let x = 20; x < 30; x++) e.set(x, 19, FIRE);
  for (let t = 0; t < 60; t++) e.step();
  assert.equal(count(e, C4), 10, "le feu ne déclenche pas le C4");

  e.set(19, 20, METAL);
  e.set(18, 20, SPARK);
  for (let t = 0; t < 60; t++) e.step();
  // Une seule charge reçoit l'étincelle : les autres sont amorcées de proche en proche.
  assert.equal(count(e, C4), 0, "l'étincelle fait sauter le mur entier");
}

// Sodium : l'eau le fait sauter, pas le feu ; sous l'huile, il ne risque rien.
{
  const sec = engine();
  sec.rect(0, H - 2, W - 1, H - 1, STONE);
  sec.rect(20, H - 5, 30, H - 3, SODIUM);
  for (let x = 20; x <= 30; x++) sec.set(x, H - 6, FIRE);
  for (let t = 0; t < 60; t++) sec.step();
  assert.equal(count(sec, SODIUM), 33, "à sec, le feu ne le déclenche pas");
  assert.equal(sec.heard.booms, 0, "et rien n'a sauté");

  const huile = engine();
  huile.rect(0, H - 2, W - 1, H - 1, STONE);
  huile.rect(10, H - 12, 50, H - 3, OIL);
  huile.rect(28, H - 4, 32, H - 3, SODIUM);
  for (let t = 0; t < 120; t++) huile.step();
  assert.equal(count(huile, SODIUM), 10, "gardé sous l'huile, il ne bouge pas");

  const lac = engine();
  lac.rect(0, H - 2, W - 1, H - 1, STONE);
  lac.rect(0, H - 10, W - 1, H - 3, WATER);
  lac.rect(28, 5, 32, 7, SODIUM);
  for (let t = 0; t < 120 && count(lac, SODIUM) === 15; t++) lac.step();
  assert.ok(count(lac, SODIUM) < 15, "jeté dans l'eau, il saute");
  assert.ok(count(lac, WATER) < W * 8, "et emporte de l'eau avec lui");
  assert.ok(MATERIALS[SODIUM].density < MATERIALS[WATER].density, "plus léger que l'eau : il flotte, donc la touche toujours");
}

// Rouille : le métal mouillé rouille, plus vite dans l'eau salée, et la rouille ne conduit pas.
{
  /** Un fil de métal posé au fond d'un bac rempli de `liquid` (ou à sec) ; rend la rouille après `ticks`. */
  const trempé = (liquid: MaterialId | null, ticks: number): number => {
    const e = engine();
    e.rect(0, H - 2, W - 1, H - 1, STONE);
    e.rect(5, H - 3, 54, H - 3, METAL);
    if (liquid !== null) e.rect(0, H - 12, W - 1, H - 4, liquid);
    for (let t = 0; t < ticks; t++) e.step();
    return count(e, RUST);
  };
  assert.equal(trempé(null, 600), 0, "à sec, le métal ne rouille pas");
  const douce = trempé(WATER, 600), salée = trempé(SALTWATER, 600);
  assert.ok(douce > 0, `dans l'eau, il rouille (${douce} cellules en 600 ticks)`);
  assert.ok(salée > douce * 2, `l'eau salée le ronge bien plus vite (${salée} contre ${douce})`);

  // Un fil rouillé au milieu ne laisse plus passer l'étincelle.
  const e = engine();
  for (let x = 10; x < 40; x++) e.set(x, 20, METAL);
  e.set(25, 20, RUST);
  e.set(45, 20, TNT);
  for (let x = 40; x < 45; x++) e.set(x, 20, METAL);
  e.set(9, 20, BATTERY);
  for (let t = 0; t < 120; t++) e.step();
  assert.equal(e.get(45, 20), TNT, "la rouille coupe le circuit : le TNT au bout ne saute pas");
  e.set(25, 20, METAL);
  for (let t = 0; t < 120; t++) e.step();
  assert.notEqual(e.get(45, 20), TNT, "réparé, le fil conduit de nouveau");
}

// Grisou : la nappe entière s'enflamme, pas seulement la cellule touchée.
{
  const e = engine();
  for (let x = 10; x < 50; x++) for (let y = 10; y < 14; y++) e.set(x, y, FIREDAMP);
  assert.equal(count(e, FIREDAMP), 160, "la nappe est posée");
  e.set(30, 13, FIRE); // dans la nappe : une flamme posée à côté peut s'éteindre avant
  for (let t = 0; t < 40; t++) e.step();
  assert.ok(count(e, FIREDAMP) < 5, "elle part d'un seul coup");
}

// Mine : seul ce qui coule appuie dessus.
{
  const e = engine();
  for (let x = 0; x < W; x++) e.set(x, 30, STONE);
  e.set(20, 29, MINE);
  e.set(20, 28, STONE); // murée : la pierre ne pèse pas
  for (let t = 0; t < 40; t++) e.step();
  assert.equal(count(e, MINE), 1, "on peut murer une mine");

  for (let y = 5; y < 8; y++) e.set(40, y, SAND);
  e.set(40, 29, MINE);
  for (let t = 0; t < 80; t++) e.step();
  assert.equal(count(e, MINE), 1, "le sable qui tombe la fait sauter");
}

// Thermite : elle ne souffle pas, elle perce — et elle seule fond la pierre.
{
  const e = engine();
  for (let x = 0; x < W; x++) for (let y = 20; y < H; y++) e.set(x, y, STONE);
  for (let x = 28; x < 33; x++) e.set(x, 19, THERMITE);
  e.set(30, 18, FIRE);
  for (let t = 0; t < 400; t++) e.step();
  let deepest = 0;
  for (let y = 20; y < H; y++) for (let x = 0; x < W; x++) if (e.get(x, y) !== STONE) deepest = y - 19;
  assert.ok(deepest > 10, "elle s'enfonce dans ce qu'elle liquéfie");
  assert.ok(count(e, LAVA) > 20, "et laisse un puits de lave");
}

// Contrôle : la lave, elle, ne fond pas la pierre (1400 °C est hors de sa portée).
{
  const e = engine();
  for (let x = 0; x < W; x++) for (let y = 20; y < H; y++) e.set(x, y, STONE);
  const before = count(e, STONE);
  for (let x = 10; x < 50; x++) for (let y = 14; y < 20; y++) e.set(x, y, LAVA);
  for (let t = 0; t < 400; t++) e.step();
  assert.equal(count(e, STONE), before, "une nappe de lave ne creuse pas");
}

// Le pétrole ne brûle pas : il gaze. Une flamme ne suffit pas, la lave si.
{
  const e = engine();
  for (let x = 10; x < 40; x++) for (let y = 30; y < 34; y++) e.set(x, y, PETROLEUM);
  for (let x = 20; x < 26; x++) e.set(x, 29, FIRE);
  for (let t = 0; t < 120; t++) e.step();
  assert.equal(count(e, FIREDAMP), 0, "une flamme ne fait pas gazer le pétrole");
  assert.ok(count(e, PETROLEUM) > 100, "et ne le consomme pas non plus");
}

// Poche scellée chauffée par la lave : elle se remplit de grisou.
{
  const e = engine();
  for (let x = 10; x < 40; x++) for (let y = 20; y < 32; y++) e.set(x, y, STONE);
  for (let x = 12; x < 38; x++) for (let y = 22; y < 30; y++) e.set(x, y, EMPTY);
  for (let x = 12; x < 38; x++) for (let y = 26; y < 30; y++) e.set(x, y, PETROLEUM);
  for (let x = 0; x < W; x++) for (let y = 32; y < H; y++) e.set(x, y, LAVA);
  for (let t = 0; t < 120; t++) e.step();
  assert.ok(count(e, FIREDAMP) > 60, `le pétrole chauffé remplit la poche (${count(e, FIREDAMP)})`);
}

// Uranium : le déclencheur, c'est la masse. Un tas s'emballe et saute.
{
  const e = engine();
  for (let x = 0; x < W; x++) for (let y = 30; y < H; y++) e.set(x, y, STONE);
  for (let x = 26; x < 34; x++) for (let y = 22; y < 30; y++) e.set(x, y, URANIUM);
  const stone = count(e, STONE);
  let hot = 0;
  for (let t = 0; t < 200 && count(e, URANIUM) > 8; t++) {
    e.step();
    hot = Math.max(hot, e.temp[e.index(30, 26)]);
  }
  assert.ok(hot > 300, `le tas chauffe avant de sauter (${hot | 0} °C)`);
  assert.ok(count(e, URANIUM) <= 8, `le tas a sauté (${count(e, URANIUM)} grains projetés restent, isolés : ils ne s'emballent plus)`);
  assert.ok(count(e, STONE) < stone - 50, `le souffle creuse (${stone - count(e, STONE)})`);
  assert.ok(count(e, FALLOUT) > 20, `il reste des retombées (${count(e, FALLOUT)})`);
}

// … mais un grain isolé ne fait que tiédir : c'est la parade, éparpiller le tas.
{
  const e = engine();
  for (let x = 10; x < 40; x += 3) e.set(x, 38, URANIUM);
  for (let t = 0; t < 400; t++) e.step();
  assert.ok(count(e, URANIUM) > 0, "un grain isolé ne s'emballe pas");
}

// Les retombées stérilisent : rien ne pousse dedans.
{
  const e = engine();
  for (let x = 20; x < 30; x++) e.set(x, 20, PLANT);
  for (let x = 20; x < 30; x++) e.set(x, 19, FALLOUT);
  for (let t = 0; t < 30; t++) e.step();
  assert.equal(count(e, PLANT), 0, "les retombées tuent la plante");
}

// Le lapin. Graines fixes : ses règles tirent beaucoup au sort, et un test qui
// échoue une fois sur mille ne dirait rien.
{
  /** Un sol de pierre en y = 38, et rien d'autre. */
  const pré = (seed: number): Engine => {
    const e = new Engine(W, H, seed);
    for (let x = 0; x < W; x++) e.set(x, 38, STONE);
    return e;
  };
  /** Colonne du cœur du (premier) lapin. */
  const où = (e: Engine): number => e.cells.indexOf(RABBIT) % W;
  /** Toutes les cellules de lapin : neuf par lapin entier. */
  const corps = (e: Engine): number =>
    count(e, RABBIT) + count(e, RABBIT_BODY) + count(e, RABBIT_EYE) + count(e, RABBIT_TAIL);
  // Posé au sol (y = 38), le cœur est en y = 36 : les pattes sont une rangée plus bas.
  const SOL = 36;

  // Taille fixe : un coup de pinceau pose un lapin entier, quel que soit le rayon.
  const pose = pré(10);
  pose.paint(30, SOL, 12, RABBIT);
  assert.equal(count(pose, RABBIT), 1, "un coup de pinceau, un lapin");
  assert.equal(corps(pose), 9, "de neuf cellules");
  assert.equal(count(pose, RABBIT_EYE), 1, "avec un œil");
  pose.paint(30, SOL, 12, RABBIT);
  assert.equal(count(pose, RABBIT), 1, "pas de second lapin là où il n'y a pas la place");
  pose.rect(0, 0, 20, 20, RABBIT);
  assert.equal(count(pose, RABBIT), 2, "un rectangle de lapin en pose un seul, au milieu");

  // Il tombe d'un bloc et atterrit entier.
  const chute = pré(11);
  chute.paint(30, 5, 1, RABBIT);
  for (let t = 0; t < 60; t++) chute.step();
  assert.equal(corps(chute), 9, "la chute ne le démembre pas");
  assert.equal((chute.cells.indexOf(RABBIT) / W) | 0, SOL, "il est posé sur le sol");

  // Il broute la prairie sous ses pattes.
  const repas = pré(12);
  for (let x = 10; x < 51; x++) repas.set(x, 37, PLANT);
  repas.paint(30, SOL - 1, 1, RABBIT);
  for (let t = 0; t < 400; t++) repas.step();
  assert.ok(count(repas, PLANT) < 41, `le lapin mange les plantes (${count(repas, PLANT)} restent sur 41)`);
  assert.equal(count(repas, RABBIT), 1, "et il est toujours là");

  // Sans rien à manger, il meurt de faim (~1000 ticks en moyenne).
  const disette = pré(13);
  disette.paint(30, SOL, 1, RABBIT);
  for (let t = 0; t < 400; t++) disette.step();
  assert.equal(corps(disette), 9, "il tient un moment le ventre vide");
  for (let t = 0; t < 2600; t++) disette.step();
  assert.equal(corps(disette), 0, "puis il meurt de faim, et tout son corps avec lui");

  // Il fuit la chaleur vers le côté le plus frais, et s'arrête dès qu'il est
  // au frais : il ne court pas jusqu'au bord. La source est à quatre cellules
  // du cœur, assez près pour que sa case de départ passe au-dessus de 45 °C.
  const brasier = pré(14);
  brasier.paint(30, SOL, 1, RABBIT);
  for (let t = 0; t < 150; t++) {
    for (let x = 24; x < 27; x++) brasier.temp[brasier.index(x, SOL)] = 400;
    brasier.step();
  }
  const refuge = brasier.cells.indexOf(RABBIT);
  assert.equal(corps(brasier), 9, "il n'a pas cuit");
  assert.ok(brasier.temp[brasier.index(30, SOL)] > 45, "sa case de départ est devenue trop chaude");
  assert.ok(où(brasier) >= 32, `il s'est éloigné de la chaleur (x = ${où(brasier)}, parti de 30)`);
  assert.ok(brasier.temp[refuge] < 45, `et il s'est posé au frais (${Math.round(brasier.temp[refuge])} °C)`);

  // Plus dense que l'eau, il coule d'un bloc — l'eau déplacée remonte — et il se noie.
  const mare = pré(15);
  for (let y = 26; y < 38; y++) { mare.set(18, y, STONE); mare.set(33, y, STONE); }
  for (let x = 19; x < 33; x++) for (let y = 29; y < 38; y++) mare.set(x, y, WATER);
  const eau = count(mare, WATER);
  mare.paint(25, 20, 1, RABBIT);
  let fond = false;
  for (let t = 0; t < 400; t++) {
    mare.step();
    if (mare.cells.indexOf(RABBIT) >= 0) fond ||= ((mare.cells.indexOf(RABBIT) / W) | 0) === SOL;
  }
  assert.ok(fond, "il a coulé jusqu'au fond");
  assert.equal(corps(mare), 0, "et il s'y est noyé");
  assert.ok(count(mare, WATER) >= eau - 2, `l'eau qu'il a traversée n'a pas disparu (${count(mare, WATER)} sur ${eau})`);

  // Empilés, chacun n'a au-dessus des oreilles que le corps du voisin : sans
  // les côtés de la tête, seul celui du haut se noyait, et celui du dessous
  // respirait au fond de l'eau tant que l'autre lui servait de couvercle. Un
  // puits juste à sa largeur (de x - 2 à x + 1) : il ne peut pas se décaler,
  // et celui du haut dépasse de l'eau, donc il survit pour faire le couvercle.
  const pile = pré(15);
  for (let y = 24; y < 38; y++) { pile.set(18, y, STONE); pile.set(23, y, STONE); }
  for (let x = 19; x < 23; x++) for (let y = 31; y < 38; y++) pile.set(x, y, WATER);
  pile.paint(21, SOL, 1, RABBIT, 1, true);
  pile.paint(21, SOL - 4, 1, RABBIT, 1, true);
  assert.equal(count(pile, RABBIT), 2, "deux lapins empilés dans un puits noyé");
  for (let t = 0; t < 60; t++) pile.step();
  assert.equal(corps(pile), 9, "celui du dessous se noie sans attendre que l'autre lui libère la tête");

  // Le sable par-dessus les oreilles étouffe comme l'eau : enseveli, il meurt.
  const enseveli = pré(21);
  enseveli.paint(25, SOL, 1, RABBIT);
  for (let t = 0; t < 10; t++) enseveli.step();
  enseveli.rect(20, 28, 30, 33, SAND);
  let étouffé = 400;
  for (let t = 0; t < 400; t++) { enseveli.step(); if (corps(enseveli) === 0) { étouffé = t; break; } }
  assert.ok(étouffé < 400, "un lapin enseveli sous le sable s'étouffe");

  // Deux lapins repus dans un enclos : un petit, de la même taille qu'eux.
  const enclos = pré(16);
  for (let y = 26; y < 38; y++) { enclos.set(14, y, STONE); enclos.set(45, y, STONE); }
  enclos.paint(24, SOL, 1, RABBIT);
  enclos.paint(30, SOL, 1, RABBIT);
  for (let t = 0; t < 200; t++) enclos.step();
  assert.ok(count(enclos, RABBIT) >= 3, `deux lapins repus se reproduisent (${count(enclos, RABBIT)})`);
  assert.equal(corps(enclos), 9 * count(enclos, RABBIT), "et chaque petit a un corps entier");

  // Seul, il ne se reproduit pas.
  const seul = pré(17);
  seul.paint(30, SOL, 1, RABBIT);
  for (let t = 0; t < 200; t++) seul.step();
  assert.equal(count(seul, RABBIT), 1, "un lapin seul reste seul");

  // Une patte arrachée : il n'y survit pas, et rien ne traîne derrière lui.
  const blessé = pré(18);
  blessé.paint(30, SOL, 1, RABBIT);
  blessé.set(28, SOL + 1, EMPTY);
  for (let t = 0; t < 3; t++) blessé.step();
  assert.equal(corps(blessé), 0, "un corps incomplet disparaît en entier");

  // Un cœur posé seul (`set()`) se refait un corps s'il a la place.
  const cœur = pré(19);
  cœur.set(30, SOL, RABBIT);
  cœur.step();
  assert.equal(corps(cœur), 9, "le cœur seul se refait un corps");

  // Grille sans état vivant (monde ancien, invité promu hôte d'un salon) : les
  // lapins n'en dépendent pas, ni pour leur corps ni pour leur satiété.
  const ancien = pré(20);
  ancien.paint(20, SOL, 1, RABBIT);
  ancien.paint(40, SOL, 1, RABBIT);
  ancien.life.fill(0);
  for (let t = 0; t < 20; t++) ancien.step();
  assert.equal(corps(ancien), 18, "sans `life`, les lapins restent entiers");

  // Le froid le fige d'un bloc : un lapin de glace, pas un glaçon et huit trous.
  const hiver = pré(21);
  hiver.ambient = -40;
  hiver.paint(30, SOL, 1, RABBIT);
  for (let t = 0; t < 300; t++) hiver.step();
  assert.equal(corps(hiver), 0, "à -40 °C il ne tient pas");
  assert.equal(count(hiver, ICE), 9, "il est pris dans la glace, en entier");
}

/** Ligne la plus haute où l'on trouve `id` (H si absent). */
function top(e: Engine, id: MaterialId): number {
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (e.get(x, y) === id) return y;
  return H;
}

// L'ambiante est le climat de la scène : à -10 °C, le lac gèle tout seul.
{
  const e = engine();
  e.ambient = -10;
  for (let x = 10; x < 50; x++) for (let y = 30; y < 38; y++) e.set(x, y, WATER);
  for (let t = 0; t < 200; t++) e.step();
  assert.ok(count(e, ICE) > 200, `l'eau gèle sous une ambiante négative (${count(e, ICE)})`);

  // …et à 90 °C rien ne gèle : le réglage marche dans les deux sens.
  const warm = engine();
  warm.ambient = 90;
  for (let x = 10; x < 50; x++) for (let y = 30; y < 38; y++) warm.set(x, y, WATER);
  for (let t = 0; t < 200; t++) warm.step();
  assert.equal(count(warm, ICE), 0, "pas de glace dans un bac à 90 °C");
}

// Le ciment coule dans son moule, puis prend en pierre une fois chauffé.
{
  const e = engine();
  for (let y = 30; y < 38; y++) { e.set(20, y, STONE); e.set(31, y, STONE); }
  for (let x = 20; x < 32; x++) e.set(x, 38, STONE);
  for (let x = 22; x < 30; x++) for (let y = 30; y < 34; y++) e.set(x, y, CEMENT);
  for (let t = 0; t < 40; t++) e.step();
  assert.ok(count(e, CEMENT) > 20, "le ciment reste liquide à froid");
  const stone = count(e, STONE);
  e.ambient = 80;
  for (let t = 0; t < 200; t++) e.step();
  assert.equal(count(e, CEMENT), 0, "chauffé, il a entièrement pris");
  assert.ok(count(e, STONE) >= stone + 30, "et il est devenu de la pierre");
}

// L'aimant fait remonter la limaille : le seul mouvement qui ignore la gravité.
{
  const e = engine();
  for (let x = 0; x < W; x++) e.set(x, 38, STONE);
  for (let x = 28; x < 32; x++) e.set(x, 37, FILINGS);
  e.set(30, 33, MAGNET); // à portée (PULL = 5)
  for (let t = 0; t < 60; t++) e.step();
  assert.ok(top(e, FILINGS) <= 35, `la limaille a grimpé vers l'aimant (jusqu'en ${top(e, FILINGS)})`);

  // Pôle inversé : le même aimant repousse. Le champ est radial, donc on le
  // met au sol, à côté du tas — sous l'aimant, les grains seraient poussés
  // dans le plancher et ne bougeraient pas.
  const push = engine();
  for (let x = 0; x < W; x++) push.set(x, 38, STONE);
  push.set(30, 37, MAGNET);
  push.toggleMagnet(30, 37);
  for (let x = 32; x < 35; x++) push.set(x, 37, FILINGS);
  for (let t = 0; t < 60; t++) push.step();
  assert.equal(push.get(32, 37), EMPTY, "le grain le plus proche a été chassé");
  assert.ok(push.get(35, 37) === FILINGS, "et le tas est parti vers l'écart");

  // Sans aimant, elle reste au sol.
  const free = engine();
  for (let x = 0; x < W; x++) free.set(x, 38, STONE);
  for (let x = 28; x < 32; x++) free.set(x, 37, FILINGS);
  for (let t = 0; t < 60; t++) free.step();
  assert.equal(top(free, FILINGS), 37, "sans aimant, elle reste au sol");
}

// Copier / coller : un morceau de grille se repose à l'identique, état compris.
{
  const e = engine();
  for (let x = 10; x < 16; x++) e.set(x, 20, METAL);
  e.set(13, 20, SWITCH);
  e.toggleSwitch(13, 20); // fermé : son état vit dans `life`
  e.setFrozen(10, 20, 0, true);

  const clip = e.copy(15, 20, 10, 20); // bornes à l'envers : remises dans l'ordre
  assert.equal(clip.width, 6, "le morceau fait six cellules de large");
  e.paste(clip, 30, 35);
  assert.equal(e.get(33, 35), SWITCH, "l'interrupteur est bien tombé au bon endroit");
  assert.equal(e.life[e.index(33, 35)], 1, "et il est toujours fermé");
  assert.equal(e.frozen[e.index(30, 35)], 1, "le figé voyage aussi");

  // Ce qui dépasse est ignoré, sans exception ni repli.
  e.paste(clip, W - 2, 0);
  assert.equal(e.get(W - 1, 0), METAL, "le bord est servi");
}

// Une cellule figée est aussi intouchable par ses voisins : c'est ce que promet
// l'invariant, et cinq règles la repeignaient quand même (feu, acide, sel…).
// Deux blocs de bois cerclés de feu, un figé et un témoin.
{
  const e = engine();
  const cercle = (x: number, y: number) => {
    for (const [dx, dy] of [[0, -1], [0, 1], [-1, 0], [1, 0]] as const) e.set(x + dx, y + dy, FIRE);
  };
  e.set(10, 10, WOOD);
  e.set(30, 10, WOOD);
  e.setFrozen(10, 10, 0, true);
  for (let t = 0; t < 300; t++) {
    // Le bois n'a que 2 % de chance de prendre par tick et par flamme : on
    // rallume à chaque tour, sinon le témoin survit une fois sur dix.
    cercle(10, 10);
    cercle(30, 10);
    e.step();
  }
  assert.equal(e.get(10, 10), WOOD, "le bois figé ne brûle pas");
  assert.notEqual(e.get(30, 10), WOOD, "…alors que le même bois libre y passe");
}

// Une grille venue d'ailleurs peut porter un id disparu : `MATERIALS[id].heat`
// jetterait à chaque tick et arrêterait le bac pour de bon.
{
  const e = engine();
  const venue = new Uint8Array(W * H);
  venue[e.index(5, 5)] = 200; // aucune matière ne porte cet id
  venue[e.index(6, 5)] = SAND;
  e.adopt(venue);
  assert.equal(e.get(5, 5), EMPTY, "l'id inconnu retombe sur le vide");
  assert.equal(e.get(6, 5), SAND, "le reste passe tel quel");
  e.step(); // ne doit pas jeter
}

// Une source porte dans `life` la matière qu'elle crache, et ce `life` vient
// aussi d'ailleurs, que `adopt()` ne filtre pas : un id inconnu faisait jeter
// `MATERIALS[id].kind` au premier tick, et le bac ne repartait plus.
{
  const e = engine();
  const n = W * H, cells = new Uint8Array(n), life = new Uint8Array(n);
  cells[e.index(30, 5)] = SOURCE;
  life[e.index(30, 5)] = 200; // aucune matière ne porte cet id
  put(e, encode(cells, new Uint8Array(n), life, new Float32Array(n).fill(20)), null, 20);
  for (let t = 0; t < 40; t++) e.step(); // ne doit pas jeter
  assert.ok(count(e, WATER) > 0, "une source à l'id inconnu crache de l'eau, comme une source vide");
}

// Un pair de salon envoie ce qu'il veut : un remplissage en x = 1,5 ne
// remplissait jamais rien, sa pile ne se vidait plus, et l'onglet de l'hôte
// gelait. Un test qui régresse ici ne finit pas : c'est ce qu'il garde.
{
  const e = engine();
  for (let x = 0; x < W; x++) e.set(x, 30, SAND);
  const before = e.cells.slice();
  applyGesture(e, { t: "fill", x: 1.5, y: 3, id: SAND });
  applyGesture(e, { t: "rect", x: 0, y: 0, x2: 0.5, y2: 4, id: STONE, over: true });
  applyGesture(e, { t: "paint", x: Number.NaN, y: 3, r: 3, id: STONE, d: 1, over: true });
  assert.deepEqual(e.cells, before, "un geste aux coordonnées non entières est ignoré");
  e.fill(1.5, 3, SAND); // le moteur se garde aussi, pour ce qui ne passe pas par un geste
  assert.deepEqual(e.cells, before, "et fill() ne boucle pas");
}

// Un rectangle entièrement hors grille : les bornes sont ramenées, pas niées.
{
  const e = engine();
  const clip = e.copy(W + 5, H + 5, W + 9, H + 9);
  assert.ok(clip.width >= 1 && clip.height >= 1, "pas de longueur négative");
}

// Outil Rectangle : bornes dans n'importe quel ordre, débordement ramené.
{
  const e = engine();
  e.rect(10, 5, 6, 2, STONE); // tracé du bas-droite vers le haut-gauche
  assert.equal(count(e, STONE), 5 * 4, "plein, bornes comprises");
  assert.equal(e.get(6, 2), STONE, "un coin");
  assert.equal(e.get(10, 5), STONE, "l'autre");

  e.rect(6, 2, 10, 5, SAND, false);
  assert.equal(count(e, SAND), 0, "« ne pas écraser » préserve ce qui est là");

  e.rect(-5, -5, 2, 2, WATER);
  assert.equal(count(e, WATER), 9, "ce qui sort de la grille est ramené, pas jeté");
  e.rect(W - 2, H - 2, W + 99, H + 99, WATER);
  assert.equal(e.get(W - 1, H - 1), WATER, "le coin opposé aussi");
}

// Vignettes de la galerie. `render.ts` se charge enfin sous Node (plus de
// paramètre-propriété, plus d'import sans extension) : on peut vérifier ce
// qu'il peint, et surtout qu'un grand monde est sous-échantillonné — une carte
// fait 170 px, pas 640.
{
  let peint: { w: number; h: number; data: Uint8ClampedArray } | null = null;
  const faux = {
    width: 0, height: 0,
    getContext: () => ({
      createImageData: (w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4) }),
      putImageData: (image: { data: Uint8ClampedArray }) => {
        peint = { w: faux.width, h: faux.height, data: image.data };
      },
    }),
  };
  (globalThis as { document?: unknown }).document = { createElement: () => faux };

  const pixel = (x: number) => [...(peint!.data.slice(x * 4, x * 4 + 3))];

  const petit = new Uint8Array(320 * 180);
  petit[0] = FIRE;
  thumbnail(petit, 320, 180);
  assert.deepEqual([peint!.w, peint!.h], [320, 180], "320 de large : rendu tel quel");
  assert.deepEqual(pixel(0), MATERIALS[FIRE].color, "et la couleur est celle du registre, canaux dans l'ordre");

  const grand = new Uint8Array(640 * 360);
  grand[0] = FIRE;
  grand[2] = WATER; // une cellule sur deux est échantillonnée : celle-ci est la seconde
  thumbnail(grand, 640, 360);
  assert.deepEqual([peint!.w, peint!.h], [320, 180], "640 de large : moitié moins de pixels dans chaque sens");
  assert.deepEqual(pixel(0), MATERIALS[FIRE].color, "le pas part bien de la première cellule");
  assert.deepEqual(pixel(1), MATERIALS[WATER].color, "et avance de deux en deux");
}

// Le vide reste du vide.
{
  const e = engine();
  for (let t = 0; t < 10; t++) e.step();
  assert.equal(count(e, EMPTY), W * H, "rien ne se crée tout seul");
}

// Le registre est la seule source : ces asserts sont ce qui accueille la
// prochaine matière ajoutée. Un `life` à 300 déborderait l'octet, un `boil.into`
// inconnu ferait jeter `MATERIALS[id]` à chaque tick.
{
  for (const [key, m] of Object.entries(MATERIALS)) {
    const où = `${m.name} (${key})`;
    assert.equal(Number(key), m.id, `${où} : la clé du registre est son id`);
    assert.ok((m.life ?? 0) <= 250, `${où} : \`life\` tient dans un octet`);
    assert.equal(m.color.length, 3, `${où} : trois canaux`);
    for (const c of m.color) {
      assert.ok(Number.isInteger(c) && c >= 0 && c <= 255, `${où} : canal hors de 0..255`);
    }
    for (const [quoi, phase] of [["boil", m.boil], ["freeze", m.freeze]] as const) {
      if (!phase) continue;
      assert.ok(MATERIALS[phase.into], `${où} : \`${quoi}.into\` est une matière connue`);
      assert.notEqual(phase.into, m.id, `${où} : \`${quoi}\` ne boucle pas sur elle-même`);
    }
  }

  const vues = new Set<MaterialId>();
  for (const cat of CATEGORIES) {
    for (const id of cat.ids) {
      assert.ok(MATERIALS[id], `${cat.name} : une matière inconnue dans la barre d'outils`);
      assert.ok(!vues.has(id), `${MATERIALS[id]?.name} figure dans deux familles`);
      vues.add(id);
    }
  }
  assert.equal(PALETTE.length, vues.size, "la palette est la mise bout à bout des familles");
  assert.equal(SHORTCUTS.length, 10, "les raccourcis vont de 1 à 9 puis 0");
  for (const id of SHORTCUTS) assert.ok(MATERIALS[id], "un raccourci pointe une matière inconnue");
}

// `thermal()` échange ses tampons : `engine.temp` est un autre tableau après le
// tick. Garder la référence d'un tick sur l'autre donnerait la grille d'avant.
{
  const e = engine();
  const avant = e.temp;
  e.step();
  assert.ok(e.temp !== avant, "`temp` est réassigné, pas recopié");
  assert.equal(e.temp.length, avant.length, "et les deux tampons ont la même taille");
}

// `clock` empêche une cellule de bouger deux fois dans le même tick : un grain
// tombe d'exactement une case par tick, quelle que soit la hauteur de chute.
{
  const e = engine();
  e.set(10, 0, SAND);
  for (let t = 1; t <= 8; t++) {
    e.step();
    assert.equal(e.get(10, t), SAND, `au tick ${t} le grain est à la ligne ${t}, pas plus bas`);
  }
}

// Hors grille, `get()` répond `STONE` : c'est ce mur implicite qui dispense
// une quinzaine de règles de tester les bords.
{
  const e = engine();
  for (const [x, y] of [[-1, 0], [0, -1], [W, 0], [0, H]] as const) {
    assert.equal(e.get(x, y), STONE, `hors grille en (${x},${y}) : un mur`);
  }
}

// L'emballement de l'uranium doit rester réversible : un tas déjà chaud qu'on
// éparpille se calme. C'est la seule parade du joueur — la rendre définitive
// ferait du nucléaire une bombe à retardement qu'on ne peut que regarder.
{
  const e = engine();
  for (let x = 0; x < W; x++) for (let y = 30; y < H; y++) e.set(x, y, STONE);
  for (let x = 26; x < 34; x++) for (let y = 22; y < 30; y++) e.set(x, y, URANIUM);
  for (let t = 0; t < 60; t++) e.step(); // le tas s'emballe (MELTDOWN en vaut 120)
  assert.ok(count(e, URANIUM) > 0, "le tas est encore là, mais compte ses ticks");

  // On casse le tas : il n'en reste qu'une rangée posée au sol, un grain sur
  // trois. Les gardés ne sont pas repeints (`set` remettrait `life` à zéro) —
  // ce sont bien des grains déjà emballés. Une rangée, parce qu'une pile de
  // colonnes s'éboule et se reconstitue en tas.
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (e.get(x, y) === URANIUM && (y !== 29 || x % 3)) e.set(x, y, EMPTY);
    }
  }
  const chaud = e.life.some((v, i) => e.cells[i] === URANIUM && v > 0);
  assert.ok(chaud, "les grains gardés sont bien ceux qui s'étaient emballés");

  const reste = count(e, URANIUM);
  for (let t = 0; t < 400; t++) e.step();
  assert.equal(count(e, URANIUM), reste, "éparpillé, il ne saute plus");
  assert.ok(
    !e.life.some((v, i) => e.cells[i] === URANIUM && v > 0),
    "et l'emballement est redescendu à zéro : la parade est réversible",
  );
}

/**
 * Pression et vent : un souffle laisse de la pression dans l'air, qui chasse
 * les gaz vers l'extérieur, puis retombe à zéro — et le bac se rendort.
 */
{
  /** Distance moyenne des cellules de fumée au point (80, 45). */
  const spread = (e: Engine): number => {
    let n = 0, sum = 0;
    for (let i = 0; i < e.cells.length; i++) {
      if (e.cells[i] !== SMOKE) continue;
      const x = (i % e.width) - 80, y = ((i / e.width) | 0) - 45;
      n++;
      sum += Math.sqrt(x * x + y * y);
    }
    return sum / n;
  };
  const cloud = (boom: boolean): Engine => {
    const e = new Engine(160, 90, 3);
    e.paint(80, 45, 25, SMOKE, 0.3);
    if (boom) e.explode(80, 45, 7);
    for (let t = 0; t < 8; t++) e.step();
    return e;
  };
  const calm = cloud(false), blown = cloud(true);
  assert.ok(!calm.press.some((p) => p !== 0), "sans souffle, pas un souffle d'air");
  assert.ok(blown.press.some((p) => p > 1), "un souffle laisse de la pression autour de lui");
  assert.ok(spread(blown) > spread(calm) + 2, `et chasse la fumée : ${spread(blown).toFixed(1)} contre ${spread(calm).toFixed(1)} cellules du centre`);

  // La pression n'entre pas dans la pierre, et retombe à zéro : le bac se rendort.
  const e = new Engine(96, 64, 5);
  e.rect(0, 40, 95, 63, STONE);
  e.explode(48, 30, 5);
  e.step();
  for (let i = 0; i < e.cells.length; i++) {
    if (e.cells[i] === STONE) assert.equal(e.press[i], 0, "aucune pression dans la pierre");
  }
  for (let t = 0; t < 600 && e.busy > 0; t++) e.step();
  assert.ok(!e.press.some((p) => p !== 0), "la pression retombe à zéro exactement");
  for (let t = 0; t < 400 && e.busy > 0; t++) e.step();
  assert.equal(e.busy, 0, "puis le bac se rendort : la pression ne tient rien éveillé pour toujours");

  // L'onde se répand par l'air : rien derrière un mur plein.
  const mur = new Engine(96, 64, 5);
  mur.rect(60, 0, 63, 63, STONE);
  mur.explode(48, 32, 5);
  let derrière = 0;
  for (let y = 0; y < 64; y++) for (let x = 64; x < 96; x++) derrière += mur.press[y * 96 + x];
  assert.equal(derrière, 0, "l'onde ne traverse pas un mur");

  /** Cellules de verre éclatées par un TNT à `d` cellules de la vitre, à l'air libre ou dans une pièce close. */
  const vitre = (d: number, close: boolean): number => {
    const e = new Engine(160, 90, 3);
    e.rect(0, 70, 159, 89, STONE);
    e.rect(80 + d, 56, 80 + d, 69, GLASS);
    if (close) { e.rect(80 - d, 56, 80 + d, 56, STONE); e.rect(80 - d, 56, 80 - d, 69, STONE); }
    e.step();
    e.explode(80, 63, 5);
    for (let t = 0; t < 60; t++) e.step();
    return 14 - count(e, GLASS) - (close ? 1 : 0); // la pièce prend une cellule de la vitre à son plafond
  };
  assert.ok(vitre(9, false) > 0, "une vitre proche d'un souffle éclate");
  assert.equal(vitre(20, false), 0, "une vitre lointaine tient");
  assert.ok(vitre(9, true) > vitre(9, false), `dans une pièce close, la même charge en casse plus (${vitre(9, true)} contre ${vitre(9, false)})`);
  const éclats = new Engine(160, 90, 3);
  éclats.rect(89, 60, 89, 69, GLASS);
  éclats.explode(80, 65, 5);
  for (let t = 0; t < 5; t++) éclats.step();
  assert.ok(count(éclats, SAND) > 0, "le verre éclaté devient du sable");

  // Le sable est soufflé par l'onde, pas par un bac calme.
  const tas = (boom: boolean): number => {
    const e = new Engine(160, 90, 3);
    e.rect(0, 70, 159, 89, STONE);
    e.rect(45, 60, 65, 69, SAND);
    for (let t = 0; t < 30; t++) e.step();
    const avant = e.cells.slice();
    if (boom) e.explode(80, 66, 7);
    let bougé = 0;
    for (let t = 0; t < 10; t++) {
      e.step();
      for (let i = 0; i < avant.length; i++) if (avant[i] === SAND && e.cells[i] !== SAND) bougé++;
    }
    return bougé;
  };
  assert.equal(tas(false), 0, "un tas posé ne bouge pas");
  assert.ok(tas(true) > 10, "l'onde arrache le sable du tas qui lui fait face");

  // Une grille posée (monde, rejeu, salon, annulation) repart sans pression, chez chacun.
  const f = new Engine(96, 64, 5);
  f.explode(48, 30, 5);
  f.wakeAll();
  assert.ok(!f.press.some((p) => p !== 0), "`wakeAll()` remet la pression à zéro");
}

/**
 * Contrat d'équivalence du moteur : à graine égale, la même scène donne la même
 * grille au tick près. C'est ce test — et non les règles prises une à une — qui
 * dira qu'un moteur réécrit (Rust/WASM) fait bien la même chose que celui-ci :
 * il suffit qu'il sorte la même empreinte.
 *
 * Il échoue aussi dès qu'une règle change l'ordre de ses tirages, même sans
 * changer son comportement visible. C'est voulu : le jour où c'est légitime,
 * relancer le test affiche l'empreinte à recopier ci-dessous.
 */
{
  /** FNV-1a sur la matière, les vies et l'arrondi des températures. */
  function fingerprint(e: Engine): string {
    let h = 0x811c9dc5;
    const eat = (b: number) => {
      h = Math.imul(h ^ (b & 255), 0x01000193);
    };
    for (let i = 0; i < e.cells.length; i++) {
      eat(e.cells[i]);
      eat(e.life[i]);
      eat(Math.round(e.temp[i]));
    }
    return (h >>> 0).toString(16);
  }

  /** Une scène qui réveille le plus de règles possible : chute, feu, eau, souffle, circuit. */
  function scene(seed: number): Engine {
    const e = new Engine(W, H, seed);
    e.rect(0, H - 3, W - 1, H - 1, STONE);
    e.rect(4, 10, 14, 20, SAND);
    e.rect(20, 4, 30, 12, WATER);
    e.rect(36, 24, 44, 30, WOOD);
    e.rect(48, 8, 52, 12, TNT);
    e.rect(2, 30, 30, 30, METAL);
    e.set(2, 29, BATTERY);
    e.set(40, 20, LAVA);
    e.set(50, 20, ICE);
    e.set(10, 2, THERMITE);
    return e;
  }

  const run = (seed: number) => {
    const e = scene(seed);
    for (let t = 0; t < 300; t++) e.step();
    return e;
  };

  const empreinte = fingerprint(run(1234));
  assert.equal(empreinte, "ba5208ad", `300 ticks depuis la graine 1234 — empreinte obtenue : ${empreinte}`);
  assert.equal(fingerprint(run(1234)), empreinte, "et rejouable : deux fois la même graine, la même grille");
  assert.notEqual(fingerprint(run(9876)), empreinte, "une autre graine donne une autre partie");
}

/**
 * Le rejeu (replay.ts) : une partie enregistrée doit retomber sur la même
 * grille, dans un moteur neuf semé autrement. C'est le pendant de l'empreinte
 * ci-dessus — elle vérifie qu'un moteur est reproductible, celui-ci qu'on garde
 * bien **tout** ce qu'il faut pour repartir en cours de partie : le tirage, le
 * sens du balayage, la grille vivante, les réglages de scène et la pluie.
 */
{
  function hash(e: Engine): string {
    let h = 0x811c9dc5;
    for (let i = 0; i < e.cells.length; i++) {
      for (const b of [e.cells[i], e.life[i], e.frozen[i], Math.round(e.temp[i]) & 255]) {
        h = Math.imul(h ^ (b & 255), 0x01000193);
      }
    }
    return (h >>> 0).toString(16);
  }

  const gestures: [number, Gesture][] = [
    [3, { t: "paint", x: 20, y: 5, r: 4, id: WATER, d: 1, over: true }],
    [11, { t: "rect", x: 4, y: 20, x2: 30, y2: 22, id: STONE, over: true }],
    [11, { t: "paint", x: 40, y: 2, r: 3, id: SAND, d: 0.35, over: true }],
    [25, { t: "frozen", x: 10, y: 21, r: 3, on: true }],
    [40, { t: "fill", x: 50, y: 5, id: OIL }],
    [60, { t: "paint", x: 50, y: 8, r: 2, id: FIRE, d: 1, over: false }],
  ];

  const e = new Engine(W, H, 4321);
  e.rect(0, H - 2, W - 1, H - 1, STONE);
  // Quelques ticks avant l'enregistrement : la parité du balayage et l'état du
  // tirage ne sont plus ceux du constructeur, c'est tout l'intérêt.
  for (let t = 0; t < 7; t++) e.step();

  const rec = new Recorder(e, 0);
  let rain = 0;
  for (let t = 0; t < 150; t++) {
    for (const [at, g] of gestures) {
      if (at !== t) continue;
      applyGesture(e, g);
      rec.gesture(g);
    }
    // Réglages changés en cours de route : ils partent dans l'enregistrement
    // sans que personne ne les lui signale (il les compare à chaque tick).
    if (t === 30) { e.wind = 0.6; rain = 3; }
    if (t === 70) { e.gravity = -1; e.ambient = -20; }
    // Une grille posée d'un coup (annulation, monde chargé) : là il faut le dire.
    if (t === 90) { e.clear(); e.rect(0, 0, W - 1, 4, SAND); rec.stamp(); }
    rec.tick(rain);
    weather(e, rain);
    e.step();
  }
  assert.equal(rec.rec.ticks, 150, "un tick enregistré par pas de simulation");

  const empreinte = hash(e);
  const neuf = new Engine(W, H, 9999); // graine différente exprès : le rejeu impose la sienne
  const player = new Player(rec.rec, neuf);
  let joues = 0;
  while (player.step()) joues++;
  assert.equal(joues, 150, "le rejeu joue exactement les ticks enregistrés");
  assert.equal(hash(neuf), empreinte, "et retombe sur la même grille, au pixel près");

  // Le même enregistrement rejoué deux fois : même résultat (rien ne fuit d'un rejeu à l'autre).
  const bis = new Engine(W, H, 1);
  const p2 = new Player(rec.rec, bis);
  while (p2.step()) { /* jusqu'au bout */ }
  assert.equal(hash(bis), empreinte, "rejouable autant de fois qu'on veut");

  assert.throws(() => new Player(rec.rec, new Engine(W + 10, H, 1)), "un bac d'une autre taille est refusé, pas décalé");

  // Exporté puis réimporté — en fichier (JSON) comme en lien (compressé) —, il
  // rejoue la même partie. Un rejeu venu d'ailleurs passe par `vet()` : tout
  // ce qui ferait lever le lecteur en plein tick est refusé à l'entrée.
  const fichier = parse(JSON.stringify(rec.rec));
  assert.ok(fichier, "un rejeu exporté en fichier se relit");
  const lien = await unpack(await pack(rec.rec));
  assert.ok(lien, "un rejeu exporté en lien se relit");
  assert.deepEqual(lien, rec.rec, "le lien rend l'enregistrement à l'identique");
  const relu = new Player(fichier, new Engine(W, H, 7));
  while (relu.step()) { /* jusqu'au bout */ }
  assert.equal(hash(relu.engine), empreinte, "un rejeu importé retombe sur la même grille");

  const abîmé = (patch: object): Recording | null => vet({ ...structuredClone(rec.rec), ...patch });
  assert.equal(parse("{pas du json"), null, "un fichier qui n'est pas du JSON est refusé");
  assert.equal(abîmé({ v: 2 }), null, "une autre version du format est refusée");
  assert.equal(abîmé({ grid: "!!!" }), null, "une grille illisible est refusée (atob lèverait au départ)");
  assert.equal(abîmé({ w: 1e6, h: 1e6 }), null, "une grille démesurée est refusée");
  assert.equal(abîmé({ scene: { ...rec.rec.scene, gravity: 3 } }), null, "une gravité inventée est refusée");
  assert.equal(abîmé({ scene: { ...rec.rec.scene, emit: 250 } }), null, "une matière de source inconnue est refusée");
  assert.equal(abîmé({ beats: [{ at: 5, g: { t: "pilot", keys: 1 } }, { at: 2, g: { t: "pilot", keys: 0 } }] }), null,
    "des beats dans le désordre sont refusés (le lecteur les sauterait)");
  assert.equal(abîmé({ beats: [{ at: 1, g: { t: "boum", x: 1, y: 1 } }] }), null, "un geste inconnu est refusé");
  assert.equal(abîmé({ beats: [{ at: 1, g: { t: "clip", x: 0, y: 0, w: 2, h: 2, cells: "@@", life: "" } }] }), null,
    "un morceau collé illisible est refusé");
  assert.equal(abîmé({ beats: [{ at: 1, g: { t: "fill", x: "0", y: 0, id: SAND } }] }), null, "un champ mal typé est refusé");
  assert.equal(await unpack("pas-un-lien"), null, "un lien abîmé est refusé, sans lever");
  // Une bombe : quelques kilo-octets de lien qui se décompressent au-delà du plafond.
  const bombe = await pack({ ...rec.rec, grid: rec.rec.grid + ".".repeat(FILM_MAX) });
  assert.ok(bombe.length < 100_000, "la bombe est petite une fois compressée");
  assert.equal(await unpack(bombe), null, "et refusée dès qu'elle passe le plafond en se décompressant");
}

/**
 * Une mer de lave à l'équilibre s'endort. Une source endormie ne fait pas le
 * tirage vers sa `heat` : lue telle quelle par un bloc éveillé voisin, elle
 * montrait 23 °C d'écart à chaque frontière, et aucun bloc ne se calmait —
 * en 1920×1080, 70 % du bac restait éveillé et le tick passait 150 ms sans
 * qu'une cellule ne bouge. `pulled()` lui applique ce tirage à la lecture.
 */
{
  const w = 128, h = 72;
  const e = new Engine(w, h, 21);
  e.rect(0, 24, w - 1, h - 1, LAVA);
  for (let t = 0; t < 800; t++) e.step();
  assert.equal(e.busy, 0, "une mer de lave à l'équilibre dort entièrement (surface à mi-bloc : avant, ses 40 blocs restaient éveillés)");
  assert.ok(Math.abs(e.temp[(h - 5) * w + w / 2] - 1153.7) < 0.1, "à sa température d'équilibre");
}

/**
 * Blocs de veille : un bloc où rien ne bouge n'est plus balayé — `busy`, le
 * nombre de blocs éveillés, tombe à zéro au repos. Tout ce qui écrit ou
 * change la scène doit le réveiller, et un rejeu
 * lancé sur un bac à moitié endormi doit retomber sur la même grille : quels
 * blocs dorment dépend de toute la partie, que le lecteur ne connaît pas.
 */
{
  const tas = (): Engine => {
    const e = new Engine(W, H, 55);
    e.rect(0, H - 2, W - 1, H - 1, STONE);
    e.rect(8, 10, 20, 20, SAND);
    e.rect(34, 28, 46, 37, STONE);
    e.rect(35, 30, 45, 37, WATER);
    for (let t = 0; t < 400; t++) e.step();
    return e;
  };

  const repos = tas();
  const avant = repos.cells.slice();
  for (let t = 0; t < 10; t++) repos.step();
  assert.equal(repos.busy, 0, "au repos, tous les blocs dorment");
  assert.deepEqual(repos.cells, avant, "et rien n'a bougé");

  const trou = tas();
  const sable = count(trou, SAND);
  trou.rect(0, H - 2, W - 1, H - 1, EMPTY);
  for (let t = 0; t < 40; t++) trou.step();
  assert.equal(count(trou, SAND), sable, "le sable est toujours là");
  assert.ok(trou.cells.subarray((H - 1) * W).includes(SAND), "mais le sol retiré, le sable endormi est tombé jusqu'au fond");

  const renverse = tas();
  renverse.gravity = -1;
  for (let t = 0; t < 60; t++) renverse.step();
  assert.ok(renverse.cells.indexOf(SAND) < W, "retourner la gravité réveille tout : le sable monte au plafond");

  const gel = tas();
  gel.ambient = -30;
  assert.ok(runUntil(gel, ICE, 600), "une ambiante sous zéro gèle le lac endormi");

  const e = tas();
  const rec = new Recorder(e, 0);
  const gestes: [number, Gesture][] = [
    [5, { t: "paint", x: 14, y: H - 2, r: 2, id: EMPTY, d: 1, over: true }],
    [30, { t: "paint", x: 40, y: 5, r: 2, id: FIRE, d: 1, over: true }],
  ];
  for (let t = 0; t < 120; t++) {
    for (const [at, g] of gestes) if (at === t) { applyGesture(e, g); rec.gesture(g); }
    rec.tick(0);
    e.step();
  }
  const suivi = new Player(rec.rec, new Engine(W, H, 3));
  while (suivi.step()) { /* jusqu'au bout */ }
  assert.deepEqual(suivi.engine.cells, e.cells, "rejoué depuis un bac à moitié endormi, même grille");
  assert.equal(suivi.engine.seed, e.seed, "et mêmes tirages");
}

/**
 * Mondes générés (terrain.ts) : une graine redonne le même monde, sans rien
 * tirer au bac, et le monde naît au repos — sinon une grande grille
 * s'effondrait en entier à la première seconde.
 */
{
  const monde = (graine: number, bac = 1): Engine => {
    const e = new Engine(640, 360, bac);
    e.clear();
    terrain(e, graine);
    return e;
  };
  const a = monde(4217, 1);
  assert.deepEqual(a.cells, monde(4217, 99).cells, "même graine, même monde, quel que soit le tirage du bac");
  assert.notDeepEqual(a.cells, monde(4218).cells, "une autre graine, un autre monde");

  const e = new Engine(640, 360, 7);
  const tirage = e.seed;
  terrain(e, 4217);
  assert.equal(e.seed, tirage, "bâtir le monde ne consomme aucun tirage du bac");

  for (const id of [STONE, SAND, WATER, WOOD, PLANT, PETROLEUM, LAVA, METAL, RABBIT, HERO]) {
    assert.ok(count(a, id) > 0, `le monde 4217 contient du ${MATERIALS[id].name.toLowerCase()}`);
  }
  let grotte = 0;
  for (let i = a.cells.length / 2; i < a.cells.length; i++) if (a.cells[i] === EMPTY) grotte++;
  assert.ok(grotte > 1000, "des grottes creusent le sous-sol");

  const bord = (x: number, y: number, id: MaterialId) => [a.get(x - 1, y), a.get(x + 1, y), a.get(x, y - 1), a.get(x, y + 1)]
    .every((n) => n === id || n === STONE || n === METAL || n === URANIUM);
  let ouvertes = 0, amas = 0;
  for (let y = 0; y < a.height; y++) {
    for (let x = 0; x < a.width; x++) {
      const id = a.get(x, y);
      if ((id === PETROLEUM || id === LAVA) && !bord(x, y, id)) ouvertes++;
      if (id === URANIUM && [a.get(x - 1, y), a.get(x + 1, y), a.get(x, y - 1), a.get(x, y + 1)].includes(URANIUM)) amas++;
    }
  }
  assert.equal(ouvertes, 0, "pétrole et lave restent enfermés dans la roche");
  assert.equal(amas, 0, "l'uranium en grains isolés : pas de tas qui s'emballe");

  const avant = a.cells.slice();
  for (let t = 0; t < 200; t++) a.step();
  let bougé = 0;
  for (let i = 0; i < avant.length; i++) if (avant[i] !== a.cells[i]) bougé++;
  assert.ok(bougé < avant.length / 100, `le monde naît au repos (${bougé} cellules changées en 200 ticks)`);
}

/**
 * Le héros : il obéit à `pilot` (marcher, grimper une marche, sauter, nager,
 * creuser), meurt comme le lapin, et ses commandes passent par des gestes —
 * donc par le rejeu.
 */
{
  const SOL = 35;
  const plaine = (): Engine => {
    const e = new Engine(W, H, 31);
    e.rect(0, SOL, W - 1, H - 1, STONE);
    assert.ok(e.spawnHero(10, SOL - 2) >= 0, "un héros se pose sur le sol");
    return e;
  };
  const où = (e: Engine): [number, number] => {
    assert.equal(e.cells[e.hero], HERO, "le héros est vivant");
    return [e.hero % W, (e.hero / W) | 0];
  };
  const tenir = (e: Engine, keys: number, ticks: number) => {
    applyGesture(e, { t: "pilot", keys });
    for (let t = 0; t < ticks; t++) e.step();
  };

  const marche = plaine();
  tenir(marche, 0, 5);
  assert.deepEqual(où(marche), [10, SOL - 2], "sans commande, il reste debout où on l'a posé");
  tenir(marche, PILOT.right, 40);
  assert.ok(où(marche)[0] > 18, `il marche vers la droite (x = ${où(marche)[0]})`);

  const marche2 = plaine();
  marche2.rect(14, SOL - 1, W - 1, SOL - 1, STONE);
  tenir(marche2, PILOT.right, 40);
  assert.deepEqual([où(marche2)[0] > 14, où(marche2)[1]], [true, SOL - 3], "il grimpe une marche d'une cellule");

  const saut = plaine();
  applyGesture(saut, { t: "pilot", keys: PILOT.up });
  let haut = SOL - 2;
  for (let t = 0; t < 12; t++) { saut.step(); haut = Math.min(haut, où(saut)[1]); }
  assert.ok(haut <= SOL - 6, `il saute (jusqu'à y = ${haut})`);
  tenir(saut, 0, 20);
  assert.equal(où(saut)[1], SOL - 2, "et retombe sur ses pieds");

  const mur = plaine();
  mur.rect(14, SOL - 6, 15, SOL - 1, STONE);
  mur.rect(24, SOL - 6, 25, SOL - 1, METAL);
  tenir(mur, PILOT.right, 40);
  assert.equal(où(mur)[0], 12, "un mur de pierre l'arrête");
  tenir(mur, PILOT.right | PILOT.dig, 120);
  assert.equal(où(mur)[0], 22, "il le creuse en avançant — et le métal, lui, résiste");

  const puits = plaine();
  tenir(puits, PILOT.down, 60);
  assert.ok(où(puits)[1] > SOL - 2, `il creuse sous ses pieds et descend (y = ${où(puits)[1]})`);

  const bassin = new Engine(W, H, 32);
  bassin.rect(0, SOL, W - 1, H - 1, STONE);
  bassin.rect(0, 20, W - 1, SOL - 1, WATER);
  bassin.spawnHero(10, 10);
  tenir(bassin, 0, 80);
  const fond = où(bassin)[1];
  assert.ok(fond > 20, `il tombe dans l'eau et y coule (y = ${fond})`);
  tenir(bassin, PILOT.up, 30);
  assert.ok(où(bassin)[1] < fond - 5, "saut tenu, il nage vers la surface");

  const fiche = (e: Engine, s: readonly [number, number]): number => {
    const [x, y] = où(e);
    return e.life[e.index(x + s[0], y + s[1])];
  };
  const brûlé = plaine();
  tenir(brûlé, 0, 2);
  brûlé.temp[brûlé.hero] = 400;
  brûlé.step();
  assert.equal(count(brûlé, HERO), 1, "un coup de chaud le blesse sans le tuer");
  assert.ok(fiche(brûlé, HERO_SLOTS.harm) > 0, "ses dégâts sont notés dans son buste");
  for (let t = 0; t < 400; t++) brûlé.step();
  assert.equal(fiche(brûlé, HERO_SLOTS.harm), 0, "au calme, il guérit");
  for (let t = 0; t < HERO_HARM && count(brûlé, HERO) > 0; t++) {
    brûlé.temp[brûlé.hero] = 400;
    brûlé.step();
  }
  assert.equal(count(brûlé, HERO), 0, "trop longtemps trop chaud, il ne survit pas");

  const noyé = new Engine(W, H, 33);
  noyé.rect(0, SOL, W - 1, H - 1, STONE);
  noyé.rect(0, 5, W - 1, SOL - 1, WATER);
  noyé.paint(10, 20, 1, HERO, 1, true);
  assert.equal(count(noyé, HERO), 1, "posé en pleine eau");
  for (let t = 0; t < 120; t++) noyé.step();
  assert.equal(count(noyé, HERO), 1, "deux secondes d'apnée : il tient");
  for (let t = 0; t < HERO_HARM; t++) noyé.step();
  assert.equal(count(noyé, HERO), 0, "mais pas indéfiniment : il se noie");

  // Empilés, le héros du dessous n'a au-dessus de la tête que le corps de celui
  // du dessus : sans la remontée à travers les créatures, il respirait au fond
  // de l'eau pendant que l'autre se noyait.
  const pile = new Engine(W, H, 34);
  pile.rect(0, SOL, W - 1, H - 1, STONE);
  pile.rect(0, 5, W - 1, SOL - 1, WATER);
  pile.paint(10, 24, 1, HERO, 1, true);
  pile.paint(10, 20, 1, HERO, 1, true);
  assert.equal(count(pile, HERO), 2, "deux héros empilés en pleine eau");
  for (let t = 0; t < 60; t++) pile.step();
  const coeurs = [...pile.cells].flatMap((id, at) => (id === HERO ? [at] : []));
  assert.equal(coeurs.length, 2, "les deux tiennent encore après une seconde");
  for (const at of coeurs) {
    const dégâts = pile.life[at + HERO_SLOTS.harm[0] + HERO_SLOTS.harm[1] * W];
    assert.ok(dégâts > 40, "chacun des deux manque d'air, pas seulement celui du dessus");
  }

  // Le sable étouffe aussi, mais sans mouiller : enseveli, il perd de l'air
  // sans se mettre à nager pour autant.
  const sous = plaine();
  tenir(sous, 0, 5);
  const [hx, hy] = où(sous);
  sous.rect(hx - 5, hy - 7, hx + 5, hy - 3, SAND);
  tenir(sous, 0, 60);
  assert.ok(fiche(sous, HERO_SLOTS.harm) > 40, "enseveli sous le sable, il manque d'air");

  const nommé = plaine();
  tenir(nommé, 0, 1);
  const numéro = fiche(nommé, HERO_SLOTS.name);
  assert.ok(numéro > 0, "il tire son numéro au premier tick");
  assert.equal(fiche(nommé, HERO_SLOTS.age), 0, "et naît à 18 ans (0 an de plus)");
  nommé.rect(20, 5, 25, SOL - 1, STONE);
  tenir(nommé, PILOT.right | PILOT.dig, 120);
  assert.ok(où(nommé)[0] > 20, "il traverse le mur en creusant");
  assert.equal(fiche(nommé, HERO_SLOTS.name), numéro, "son corps emporte sa fiche quand il marche");
  assert.ok(fiche(nommé, HERO_SLOTS.dug) > 0, "il compte ce qu'il creuse");
  assert.ok(heroName(nommé, numéro).length > 0, "son nom d'origine vient de la liste");

  // Deux héros ne partagent pas de numéro : `chosen` en est un, ils obéiraient
  // ensemble. Le tirage d'avant le prenait de la place du cœur, et deux héros
  // dont les index sont distants de 250 — ici une marche de quatre rangées —
  // tombaient tous les deux sur le 1.
  const paire = new Engine(W, H, 31);
  paire.rect(0, SOL, W - 1, H - 1, STONE);
  paire.rect(5, SOL - 4, 15, SOL - 4, STONE);
  assert.equal(paire.spawnHero(20, SOL - 2), 2000, "un héros sur le sol");
  assert.equal(paire.spawnHero(10, SOL - 6), 1750, "un autre sur la marche, 250 cellules plus tôt");
  paire.step();
  const numéros = [...paire.cells].flatMap((id, at) =>
    id === HERO ? [paire.life[paire.index(at % W + HERO_SLOTS.name[0], ((at / W) | 0) + HERO_SLOTS.name[1])]] : []);
  assert.equal(new Set(numéros).size, 2, `deux numéros distincts (${numéros})`);
  assert.ok(!numéros.includes(0), "et aucun héros sans numéro");

  // Un monde chargé sans état vivant arrive sans numéros : le moteur les rend
  // au premier tick (`seek`), sinon plus personne n'obéit aux touches.
  paire.life.fill(0);
  paire.adopt(paire.cells.slice());
  paire.step();
  const rendus = [...paire.cells].flatMap((id, at) =>
    id === HERO ? [paire.life[paire.index(at % W + HERO_SLOTS.name[0], ((at / W) | 0) + HERO_SLOTS.name[1])]] : []);
  assert.ok(!rendus.includes(0) && new Set(rendus).size === 2, `renumérotés, toujours distincts (${rendus})`);
  applyGesture(nommé, { t: "name", id: numéro, name: "  Robert le Lapin des Bois  " });
  assert.equal(heroName(nommé, numéro), "Robert le Lapin des", "renommé, sans blancs autour, 20 caractères au plus");
  applyGesture(nommé, { t: "name", id: 999, name: "Pirate" });
  assert.equal(nommé.names.size, 1, "un numéro hors octet est refusé");
  const monde = encode(nommé.cells, nommé.frozen, nommé.life, nommé.temp, nommé.names);
  assert.equal(decodeNames(monde).get(numéro), "Robert le Lapin des", "le nom part avec le monde (5ᵉ bloc)");
  assert.equal(decodeNames(encode(nommé.cells, nommé.frozen, nommé.life, nommé.temp)).size, 0, "un monde d'avant n'a pas de noms");
  assert.equal(decodeNames(monde.split(".").slice(0, 4).join(".") + ".@@@").size, 0, "un bloc de noms illisible ne lève pas");
  applyGesture(nommé, { t: "name", id: numéro, name: "" });
  assert.equal(nommé.names.size, 0, "un nom vide rend celui d'origine");

  const duo = plaine();
  assert.ok(duo.spawnHero(40, SOL - 2) >= 0, "un second héros se pose");
  const second = duo.chosen;
  assert.equal(où(duo)[0], 40, "le dernier posé est le piloté");
  const [x1] = où(duo);
  tenir(duo, PILOT.right, 40);
  assert.ok(où(duo)[0] > x1 + 8, "le piloté marche");
  assert.equal(duo.get(10, SOL - 2), HERO, "l'autre reste où il est");
  for (let t = 0; t < 20; t++) { duo.step(); assert.equal(duo.cells[duo.hero], HERO); }
  assert.equal(duo.chosen, second, "la caméra ne saute plus d'un héros à l'autre");
  applyGesture(duo, { t: "hero" });
  assert.notEqual(duo.chosen, second, "le geste hero passe à l'autre");
  assert.equal(où(duo)[0], 10, "la caméra le rejoint");
  applyGesture(duo, { t: "hero" });
  assert.equal(duo.chosen, second, "et revient au premier : il n'y en a que deux");
  put(duo, encode(duo.cells, duo.frozen, duo.life, duo.temp), null, duo.ambient);
  duo.step();
  assert.equal(duo.chosen, second, "grille reposée (rejeu, salon) : retrouvé par son numéro");
  assert.ok(où(duo)[0] > 40, "au bout de sa marche, pas à une ancienne place");
  duo.rect(où(duo)[0] - 3, 0, où(duo)[0] + 3, SOL - 1, EMPTY);
  duo.step();
  assert.equal(où(duo)[0], 10, "le piloté disparu, on passe à l'autre");
  duo.rect(5, 0, 15, SOL - 1, EMPTY);
  duo.step();
  assert.equal(duo.chosen, 0, "plus de héros : plus de piloté");

  const pirate = plaine();
  applyGesture(pirate, { t: "pilot", keys: 999 | (NANITE << 8) | (1 << 20) });
  assert.equal(pirate.pilot, 999 & 63, "un pair ne pose que les six bits des commandes, et pas de nanites");
  applyGesture(pirate, { t: "pilot", keys: PILOT.place | (WATER << 8) });
  assert.equal(pirate.pilot, PILOT.place, "ni un liquide");
  applyGesture(pirate, { t: "pilot", keys: PILOT.place | (STONE << 8) });
  assert.equal(pirate.pilot >> 8, STONE, "mais de la pierre, oui");

  const escalier = plaine();
  tenir(escalier, PILOT.right | PILOT.place | (WOOD << 8), 60);
  assert.ok(où(escalier)[1] < SOL - 6, `il pose des marches de bois et les gravit (y = ${où(escalier)[1]})`);
  assert.ok(count(escalier, WOOD) > 5, "le bois est bien posé");

  const pilier = plaine();
  tenir(pilier, PILOT.up | PILOT.place | (STONE << 8), 120);
  assert.ok(où(pilier)[1] < SOL - 8, `saut tenu, il monte sur un pilier de pierre (y = ${où(pilier)[1]})`);
  assert.equal(où(pilier)[0], 10, "sans bouger de colonne");

  const e = plaine();
  e.rect(30, SOL - 1, 31, SOL - 1, SAND);
  const rec = new Recorder(e, 0);
  const commandes: [number, number][] = [[3, PILOT.right], [25, PILOT.right | PILOT.up], [40, PILOT.right | PILOT.dig], [70, 0]];
  for (let t = 0; t < 100; t++) {
    for (const [at, keys] of commandes) if (at === t) { const g: Gesture = { t: "pilot", keys }; applyGesture(e, g); rec.gesture(g); }
    rec.tick(0);
    e.step();
  }
  const rejoué = new Player(rec.rec, new Engine(W, H, 5));
  while (rejoué.step()) { /* jusqu'au bout */ }
  assert.deepEqual(rejoué.engine.cells, e.cells, "une partie pilotée se rejoue au pixel près");
}

/**
 * Les fonctions `Math` que la norme laisse « approchées selon
 * l'implémentation » (hypot, sin, exp…) peuvent différer d'un bit entre deux
 * navigateurs : dans le moteur, un salon Chrome + Firefox divergerait ; dans
 * le générateur, une graine ne redonnerait plus le même monde. Aucun test de
 * comportement ne le verrait, tous tournent sous le même V8 : on lit donc la
 * source. `Math.sqrt`, correctement arrondie, reste permise ; pour le reste,
 * sim/libm.ts (sin, cos, atan, atan2, exp, log), qui est lue elle aussi.
 */
for (const fichier of ["../src/client/sim/engine.ts", "../src/client/terrain.ts", "../src/client/sim/libm.ts"]) {
  const source = readFileSync(new URL(fichier, import.meta.url), "utf8");
  const approchées = source.match(/Math\.(hypot|sin|cos|tan|asin|acos|atan2?|sinh|cosh|tanh|exp|expm1|log|log1p|log2|log10|pow|cbrt)\b/g);
  assert.equal(approchées, null, `${fichier} n'emploie aucune fonction Math approchée (${approchées?.join(", ")})`);
}

/**
 * L'éclairage (screen.ts) compte l'émission d'une cellule au prorata de ce
 * qu'elle arrête : une matière qui émet sans rien arrêter n'éclairerait rien.
 */
const lumière = lighting();
for (let id = 0; id < 256; id++) {
  const émet = lumière[id * 4] + lumière[id * 4 + 1] + lumière[id * 4 + 2] > 0;
  if (émet) assert.ok(lumière[id * 4 + 3] > 0, `la matière ${id} émet de la lumière, elle doit en arrêter un peu`);
}

/**
 * L'éclairage du secours 2D (`FlatLight`) : il ne copie pas le shader, mais il
 * doit en garder les traits qu'on voit — la lave éclaire autour d'elle, un mur
 * fait de l'ombre, le noir reste noir, la pierre au bord de la lave prend sa
 * lumière, et ce qui brille ne se rajoute pas sa propre lumière.
 */
{
  const W2 = 160, H2 = 90;
  const e = new Engine(W2, H2);
  e.rect(20, 40, 30, 50, LAVA);
  e.rect(80, 0, 83, H2 - 1, STONE); // un mur du haut en bas
  const grid = { width: W2, height: H2, ambient: e.ambient, cells: e.cells, life: e.life, frozen: e.frozen, noise: e.noise, temp: e.temp, press: e.press };
  const l = new FlatLight();
  l.compute(grid);
  const at = (x: number, y: number): number => {
    const t = (Math.floor(y / l.scale) * l.width + Math.floor(x / l.scale)) * 3;
    return l.light[t] + l.light[t + 1] + l.light[t + 2];
  };
  assert.ok(at(40, 45) > 0.05, `à côté de la lave, de la lumière (${at(40, 45).toFixed(3)})`);
  assert.ok(at(40, 45) > at(70, 45), "plus loin, moins");
  assert.ok(at(70, 45) > at(95, 45) * 4, `derrière le mur, l'ombre (${at(70, 45).toFixed(3)} devant, ${at(95, 45).toFixed(3)} derrière)`);
  assert.ok(at(81, 45) > 0, "le mur, opaque, prend la lumière de son voisin éclairé");
  assert.equal(at(25, 45), 0, "la lave, qui brille, ne reçoit rien en plus");

  const noir = new Engine(W2, H2);
  noir.rect(0, 60, W2 - 1, H2 - 1, STONE);
  l.compute({ ...grid, cells: noir.cells, temp: noir.temp, life: noir.life, frozen: noir.frozen, noise: noir.noise, press: noir.press });
  assert.ok(l.light.every((v) => v === 0), "sans rien qui émette, pas de lumière");

  // Le mélange : la même cellule, plus claire éclairée, jamais plus sombre.
  l.compute(grid);
  const sans = new Renderer(grid), avec = new Renderer(grid);
  avec.lights = l;
  sans.draw(); avec.draw();
  let plusClair = 0;
  for (let i = 0; i < sans.pixels.length; i++) {
    assert.ok(avec.pixels[i] >= sans.pixels[i], "l'éclairage ajoute, il n'enlève rien");
    if (avec.pixels[i] > sans.pixels[i]) plusClair++;
  }
  assert.ok(plusClair > 1000, `l'air autour de la lave s'éclaire (${plusClair} canaux)`);
}

/** Le cycle des heures passe par chaque heure au quart de journée, en boucle, et ne sort pas de [0, 1]. */
assert.deepEqual(hourTint(0), HOURS.matin);
assert.deepEqual(hourTint(DAY * 0.75), HOURS.nuit);
assert.deepEqual(hourTint(DAY * 3), HOURS.matin);
assert.equal(clockAt(0), CLOCK.matin);
assert.equal(clockAt(DAY * 0.625), 23, "le soir passe minuit en allant vers la nuit");
assert.equal(clockAt(DAY * 0.75), CLOCK.nuit);
for (let s = 0; s < DAY; s += 7) assert.ok(hourTint(s).every((v) => v >= 0 && v <= 1), `teinte hors bornes à ${s} s`);

/** La nuit assombrit la pierre, pas la lave : c'est elle qui éclaire. */
{
  const e = new Engine(4, 1);
  e.set(0, 0, STONE); e.set(1, 0, LAVA);
  const r = new Renderer(e);
  r.draw(); const jour = r.pixels.slice();
  r.tint = HOURS.nuit; r.draw();
  assert.ok(r.pixels[2] < jour[2], "la nuit doit assombrir la pierre");
  assert.equal(r.pixels[6], jour[6], "la nuit ne doit pas assombrir la lave");
}

/**
 * Le pire cas de chaque matière : un bac **plein d'elle seule**. Il doit
 * s'endormir (`busy` = 0), sinon il coûte à chaque tick pour toujours — en
 * 1920×1080, un bac plein d'aimants coûtait 2 s par tick à chercher de la
 * limaille qui n'y était pas, plein de sel ou de sources 70 à 150 ms.
 *
 * Une matière inerte s'endort en quelques ticks (la lave et la glace le temps
 * de se mettre à l'ambiante). Celles de `WORKS` travaillent vraiment à chaque
 * tick — c'est leur règle, pas du gaspillage —, mais finissent par s'éteindre.
 * Une nouvelle matière qui reste éveillée sans rien faire casse ce test : la
 * faire appeler `wake(i)` quand elle a de quoi agir plutôt que la mettre dans
 * `ACTIVE` (docs/agents/simulation.md, « Blocs de veille »). Et si elle
 * travaille vraiment, l'ajouter à `WORKS` avec sa raison.
 */
{
  /** Ticks au plus pour qu'un bac plein d'une matière inerte s'endorme. */
  const INERT = 30;
  /** Ticks au plus pour une matière de `WORKS` (l'acide, le plus lent, met ~1500 ticks). */
  const LONG = 2000;
  const WORKS: Partial<Record<MaterialId, string>> = {
    [FIRE]: "brûle et vieillit, puis la chaleur retombe",
    [SMOKE]: "vieillit", [STEAM]: "vieillit et se condense", [FIREDAMP]: "vieillit", [FALLOUT]: "vieillit",
    [NANITE]: "vieillit", [EMBER]: "vieillit en fumée, et chauffe",
    [ACID]: "ronge le bord du bac (hors grille = pierre) et s'use en fumée",
    [MOLTEN_GLASS]: "refroidit jusqu'à se figer en verre",
    [URANIUM]: "s'emballe en masse et saute",
    [RABBIT]: "vit, puis meurt de faim", [RABBIT_BODY]: "sans cœur, le corps se défait", [RABBIT_EYE]: "idem", [RABBIT_TAIL]: "idem",
    [HERO_HEAD]: "sans cœur, le corps se défait", [HERO_BODY]: "idem", [HERO_LEGS]: "idem",
  };
  for (const key of Object.keys(MATERIALS)) {
    const id = Number(key) as MaterialId;
    // Le héros ne s'endort jamais : il attend les commandes du joueur (créature, donc `ACTIVE`).
    if (id === EMPTY || id === HERO) continue;
    const e = new Engine(64, 64, 1234);
    e.rect(0, 0, 63, 63, id);
    const limit = WORKS[id] ? LONG : INERT;
    let t = 0;
    while (t < limit && (t === 0 || e.busy > 0)) { e.step(); t++; }
    assert.equal(e.busy, 0, `un bac plein de ${MATERIALS[id].name} (${id}) doit s'endormir en ${limit} ticks : il reste ${e.busy} blocs éveillés`
      + (WORKS[id] ? ` (${WORKS[id]})` : " — une matière inerte ne doit pas tenir son bloc éveillé"));
  }
}

console.log("ok — simulation conforme");
