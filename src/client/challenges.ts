/**
 * Petits scénarios prêts à jouer. Un défi = une scène construite en code
 * (moins lourd qu'un monde encodé en base64) + une condition de victoire lue
 * dans la grille.
 */
import type { Engine } from "./sim/engine.ts";
import {
  CANDLE, FILINGS, FIREDAMP, GLASS, ICE, METAL, OIL, PETROLEUM, PLANT, SEED, SNOW, STEAM, STONE, TNT,
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

/** Cellules d'`id` dans un rectangle. */
function countIn(e: Engine, x0: number, y0: number, x1: number, y1: number, id: MaterialId): number {
  let n = 0;
  for (let x = x0; x < x1; x++) for (let y = y0; y < y1; y++) if (e.get(x, y) === id) n++;
  return n;
}

/** Le rectangle est-il entièrement fait d'`id` ? */
function full(e: Engine, x0: number, y0: number, x1: number, y1: number, id: MaterialId): boolean {
  return countIn(e, x0, y0, x1, y1, id) === (x1 - x0) * (y1 - y0);
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
  {
    name: "Coffrage",
    goal: "Remplir le moule de ciment et le faire prendre : il durcit en pierre à 60 °C — par le feu, ou en montant la température ambiante.",
    build(e) {
      floor(e, 150);
      block(e, 120, 144, 124, 150, STONE);
      block(e, 148, 144, 152, 150, STONE);
    },
    won: (e) => full(e, 124, 144, 148, 150, STONE),
  },
  {
    name: "Ferraille",
    goal: "Faire passer 200 cellules de limaille par-dessus le mur, jusqu'au bac de droite. Un aimant l'attire, gravité ou pas.",
    build(e) {
      floor(e, 170);
      block(e, 150, 145, 156, 170, STONE);
      block(e, 40, 160, 100, 170, FILINGS);
      block(e, 210, 150, 214, 170, STONE);
      block(e, 280, 150, 284, 170, STONE);
    },
    won: (e) => countIn(e, 214, 150, 280, 170, FILINGS) >= 200,
  },
  {
    name: "Grand froid",
    goal: "Prendre le lac en glace sans y toucher : c'est la température ambiante qu'il faut faire descendre.",
    build(e) {
      floor(e, 170);
      block(e, 56, 120, 60, 170, STONE);
      block(e, 260, 120, 264, 170, STONE);
      block(e, 60, 130, 260, 170, WATER);
    },
    won: (e) => count(e, ICE) >= 6000,
  },
];
