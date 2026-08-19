/**
 * Petits scénarios prêts à jouer. Un défi = une scène construite en code
 * (moins lourd qu'un monde encodé en base64) + une condition de victoire lue
 * dans la grille.
 */
import type { Engine } from "./sim/engine.ts";
import {
  CANDLE, FIREDAMP, GLASS, ICE, METAL, OIL, PETROLEUM, PLANT, SEED, SNOW, STEAM, STONE, TNT,
  URANIUM, WATER, WOOD, type MaterialId,
} from "./sim/materials.ts";

export interface Challenge {
  name: string;
  goal: string;
  build(e: Engine): void;
  won(e: Engine): boolean;
}

function count(e: Engine, id: MaterialId): number {
  let n = 0;
  for (const c of e.cells) if (c === id) n++;
  return n;
}

/** Sol de pierre sur toute la largeur. */
function floor(e: Engine, y: number): void {
  for (let x = 0; x < e.width; x++) for (let d = 0; d < 4; d++) e.set(x, y + d, STONE);
}

/** Cellules d'`id` ayant au moins `least` voisines identiques (les huit alentour). */
function clumped(e: Engine, id: MaterialId, least: number): number {
  let n = 0;
  for (let y = 0; y < e.height; y++) {
    for (let x = 0; x < e.width; x++) {
      if (e.get(x, y) !== id) continue;
      let mass = 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if ((dx || dy) && e.get(x + dx, y + dy) === id) mass++;
        }
      }
      if (mass >= least) n++;
    }
  }
  return n;
}

function block(e: Engine, x0: number, y0: number, x1: number, y1: number, id: MaterialId): void {
  for (let x = x0; x < x1; x++) for (let y = y0; y < y1; y++) e.set(x, y, id);
}

export const CHALLENGES: Challenge[] = [
  {
    name: "Débâcle",
    goal: "Faire disparaître toute la glace et toute la neige. Attention : elles se refroidissent l'une l'autre.",
    build(e) {
      floor(e, 150);
      block(e, 100, 110, 220, 150, ICE);
      block(e, 100, 100, 220, 110, SNOW);
    },
    won: (e) => count(e, ICE) === 0 && count(e, SNOW) === 0,
  },
  {
    name: "Mèche lente",
    goal: "Faire sauter les trois charges avec une seule flamme, sans toucher au TNT.",
    build(e) {
      floor(e, 150);
      for (const x of [40, 160, 280]) block(e, x, 138, x + 14, 150, TNT);
      block(e, 54, 146, 160, 150, WOOD);
      block(e, 174, 146, 280, 150, WOOD);
      block(e, 100, 142, 116, 146, OIL);
    },
    won: (e) => count(e, TNT) === 0,
  },
  {
    name: "Court-circuit",
    goal: "Allumer la bougie sans l'approcher : l'étincelle ne voyage que dans le métal.",
    build(e) {
      floor(e, 150);
      for (let x = 60; x < 250; x++) e.set(x, 120, METAL);
      for (let y = 120; y < 147; y++) e.set(249, y, METAL);
      e.set(250, 146, CANDLE);
      // Abri de verre : pas moyen de laisser tomber une flamme sur la mèche.
      block(e, 252, 138, 254, 150, GLASS);
      block(e, 250, 138, 254, 140, GLASS);
    },
    won: (e) => e.cells[e.index(250, 146)] === CANDLE && e.life[e.index(250, 146)] === 1,
  },
  {
    name: "Puits",
    goal: "Percer douze mètres de roche jusqu'à la nappe d'eau : seule la thermite monte assez haut (la lave plafonne à 800 °C dans la pierre).",
    build(e) {
      block(e, 0, 108, e.width, 178, STONE);
      block(e, 120, 156, 200, 172, WATER);
    },
    won: (e) => count(e, STEAM) >= 20,
  },
  {
    name: "Désamorçage",
    goal: "Éparpiller le tas d'uranium — plus aucun grain avec trois voisins — en en gardant au moins 80. Il chauffe déjà.",
    build(e) {
      floor(e, 150);
      block(e, 136, 126, 184, 150, URANIUM);
    },
    won: (e) => count(e, URANIUM) >= 80 && clumped(e, URANIUM, 3) === 0,
  },
  {
    name: "Coup de grisou",
    goal: "Tirer 60 cellules de grisou du pétrole (il bout à 200 °C) sans que le gaz prenne feu : il s'enflamme au moindre contact d'une flamme.",
    build(e) {
      floor(e, 170);
      block(e, 60, 120, 70, 170, STONE);
      block(e, 250, 120, 260, 170, STONE);
      block(e, 70, 140, 250, 170, PETROLEUM);
    },
    won: (e) => count(e, FIREDAMP) >= 60,
  },
  {
    name: "Jardin",
    goal: "Faire pousser 400 cellules de plante, puis tout brûler si le cœur vous en dit.",
    build(e) {
      floor(e, 150);
      block(e, 60, 140, 260, 146, WATER);
      for (let x = 70; x < 250; x += 6) e.set(x, 130, SEED);
    },
    won: (e) => count(e, PLANT) >= 400,
  },
];
