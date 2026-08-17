/**
 * Registre des matériaux.
 * Ajouter une activité au bac à sable = ajouter une entrée ici (+ une règle
 * dans engine.ts si le comportement n'est pas déjà couvert par son `kind`).
 */

export const EMPTY = 0;
export const SAND = 1;
export const WATER = 2;
export const STONE = 3;
export const WOOD = 4;
export const FIRE = 5;
export const SMOKE = 6;
export const STEAM = 7;
export const OIL = 8;
export const ACID = 9;
export const PLANT = 10;
export const LAVA = 11;

export type MaterialId = number;

/** Comment la cellule bouge. Le reste (feu, acide…) est une règle spécifique. */
export type Kind = "empty" | "static" | "powder" | "liquid" | "gas";

export interface Material {
  id: MaterialId;
  name: string;
  kind: Kind;
  /** Plus dense coule sous moins dense (0 = vide/air). */
  density: number;
  color: readonly [number, number, number];
  /** Amplitude du bruit par cellule, pour la texture. */
  noise: number;
  /** Probabilité de prendre feu au contact d'une flamme (0 = ininflammable). */
  flammable?: number;
  /** Durée de vie en ticks (feu, fumée, vapeur). 0 = éternel. */
  life?: number;
  /** Étalement horizontal des liquides, en cellules par tick. */
  spread?: number;
  /** Description affichée dans l'UI. */
  hint: string;
}

export const MATERIALS: Record<MaterialId, Material> = {
  [EMPTY]: { id: EMPTY, name: "Gomme", kind: "empty", density: 0, color: [12, 14, 20], noise: 0, hint: "Efface" },
  [SAND]: { id: SAND, name: "Sable", kind: "powder", density: 6, color: [214, 180, 106], noise: 18, hint: "Coule en tas, s'enfonce dans l'eau" },
  [STONE]: { id: STONE, name: "Pierre", kind: "static", density: 9, color: [122, 124, 132], noise: 14, hint: "Immobile, fond dans la lave" },
  [WOOD]: { id: WOOD, name: "Bois", kind: "static", density: 8, color: [110, 74, 43], noise: 12, flammable: 0.14, hint: "Immobile et inflammable" },
  [WATER]: { id: WATER, name: "Eau", kind: "liquid", density: 4, color: [56, 108, 176], noise: 10, spread: 4, hint: "S'étale, éteint le feu" },
  [OIL]: { id: OIL, name: "Huile", kind: "liquid", density: 3, color: [78, 62, 38], noise: 8, spread: 3, flammable: 0.5, hint: "Flotte sur l'eau, brûle très bien" },
  [ACID]: { id: ACID, name: "Acide", kind: "liquid", density: 4, color: [126, 224, 58], noise: 12, spread: 3, hint: "Dissout les solides" },
  [LAVA]: { id: LAVA, name: "Lave", kind: "liquid", density: 7, color: [226, 88, 24], noise: 22, spread: 1, hint: "Brûle tout, se fige au contact de l'eau" },
  [FIRE]: { id: FIRE, name: "Feu", kind: "gas", density: 1, color: [244, 132, 32], noise: 40, life: 60, hint: "Se propage, laisse de la fumée" },
  [SMOKE]: { id: SMOKE, name: "Fumée", kind: "gas", density: 1, color: [70, 70, 78], noise: 16, life: 140, hint: "Monte puis se dissipe" },
  [STEAM]: { id: STEAM, name: "Vapeur", kind: "gas", density: 1, color: [190, 208, 220], noise: 14, life: 200, hint: "Eau + feu" },
  [PLANT]: { id: PLANT, name: "Plante", kind: "static", density: 5, color: [58, 150, 74], noise: 20, flammable: 0.25, hint: "Pousse en buvant l'eau" },
};

/** Ordre d'affichage dans la barre d'outils. */
export const PALETTE: MaterialId[] = [SAND, WATER, STONE, WOOD, OIL, ACID, LAVA, PLANT, FIRE, SMOKE, EMPTY];
