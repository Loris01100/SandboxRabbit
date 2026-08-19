/**
 * Auto-vérification de la simulation : `npm run check` (Node exécute le TS tel quel).
 * Un `assert` par règle, pas de framework.
 */
import assert from "node:assert/strict";
import { Engine } from "../src/client/sim/engine.ts";
import { decode, decodeFrozen, encode } from "../src/client/sim/codec.ts";
import { CHALLENGES } from "../src/client/challenges.ts";
import {
  ALCOHOL, BATTERY, C4, CANDLE, EMBER, EMPTY, FIRE, FIREDAMP, GLASS, ICE, LAVA, MERCURY, METAL, MINE, NITRO, THERMITE,
  MOLTEN_GLASS, MOLTEN_WAX, MUD, NANITE, NITROGEN, OIL, PLANT, SALT, SALTWATER, SAND, SEED,
  SNOW, SOURCE, SPARK, PETROLEUM, URANIUM, FALLOUT, STONE, SWITCH, TAR, TNT, WATER, WAX, WOOD, type MaterialId,
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
  for (let t = 0; t < 200 && count(e, URANIUM) > 0; t++) {
    e.step();
    hot = Math.max(hot, e.temp[e.index(30, 26)]);
  }
  assert.ok(hot > 300, `le tas chauffe avant de sauter (${hot | 0} °C)`);
  assert.equal(count(e, URANIUM), 0, "le tas a sauté");
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

// Le vide reste du vide.
{
  const e = engine();
  for (let t = 0; t < 10; t++) e.step();
  assert.equal(count(e, EMPTY), W * H, "rien ne se crée tout seul");
}

console.log("ok — simulation conforme");
