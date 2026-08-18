/**
 * Auto-vérification de la simulation : `npm run check` (Node exécute le TS tel quel).
 * Un `assert` par règle, pas de framework.
 */
import assert from "node:assert/strict";
import { Engine } from "../src/client/sim/engine.ts";
import { decode, encode } from "../src/client/sim/codec.ts";
import {
  EMPTY, FIRE, GLASS, ICE, LAVA, NANITE, OIL, PLANT, SALT, SALTWATER, SAND,
  SEED, SOURCE, STONE, TNT, WATER, WOOD, type MaterialId,
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

// Le vide reste du vide.
{
  const e = engine();
  for (let t = 0; t < 10; t++) e.step();
  assert.equal(count(e, EMPTY), W * H, "rien ne se crée tout seul");
}

console.log("ok — simulation conforme");
