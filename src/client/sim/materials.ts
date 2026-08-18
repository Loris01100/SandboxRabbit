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
export const ICE = 12;
export const GUNPOWDER = 13;
export const SALT = 14;
export const SALTWATER = 15;
export const TNT = 16;
export const SEED = 17;
export const NANITE = 18;
export const SOURCE = 19;
export const GLASS = 20;

export type MaterialId = number;

/** Comment la cellule bouge. Le reste (feu, acide…) est une règle spécifique. */
export type Kind = "empty" | "static" | "powder" | "liquid" | "gas";

/** Changement d'état déclenché par la température. */
export interface Phase {
  at: number;
  into: MaterialId;
}

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
  /** Température vers laquelle la cellule tire en continu (source chaude ou froide). */
  heat?: number;
  /** Température de la cellule au moment où elle est déposée. */
  spawn?: number;
  /** Au-dessus de `at` °C, devient `into`. */
  boil?: Phase;
  /** En dessous de `at` °C, devient `into`. */
  freeze?: Phase;
  /** Description affichée dans l'UI. */
  hint: string;
}

export const MATERIALS: Record<MaterialId, Material> = {
  [EMPTY]: { id: EMPTY, name: "Gomme", kind: "empty", density: 0, color: [12, 14, 20], noise: 0, hint: "Efface" },
  [SAND]: { id: SAND, name: "Sable", kind: "powder", density: 6, color: [214, 180, 106], noise: 18, boil: { at: 450, into: GLASS }, hint: "Coule en tas, vitrifie au contact de la lave" },
  [STONE]: { id: STONE, name: "Pierre", kind: "static", density: 9, color: [122, 124, 132], noise: 14, hint: "Immobile, fond dans la lave" },
  [WOOD]: { id: WOOD, name: "Bois", kind: "static", density: 8, color: [110, 74, 43], noise: 12, flammable: 0.14, hint: "Immobile et inflammable" },
  [WATER]: { id: WATER, name: "Eau", kind: "liquid", density: 4, color: [56, 108, 176], noise: 10, spread: 4, boil: { at: 100, into: STEAM }, freeze: { at: 0, into: ICE }, hint: "S'étale, éteint le feu, gèle à 0 °C" },
  [OIL]: { id: OIL, name: "Huile", kind: "liquid", density: 3, color: [78, 62, 38], noise: 8, spread: 3, flammable: 0.5, boil: { at: 250, into: FIRE }, hint: "Flotte sur l'eau, s'enflamme toute seule si ça chauffe" },
  [ACID]: { id: ACID, name: "Acide", kind: "liquid", density: 4, color: [126, 224, 58], noise: 12, spread: 3, hint: "Dissout les solides" },
  [LAVA]: { id: LAVA, name: "Lave", kind: "liquid", density: 7, color: [226, 88, 24], noise: 22, spread: 1, heat: 1200, hint: "Brûle tout, se fige au contact de l'eau, vitrifie le sable" },
  [FIRE]: { id: FIRE, name: "Feu", kind: "gas", density: 1, color: [244, 132, 32], noise: 40, life: 60, heat: 800, hint: "Se propage, laisse de la fumée" },
  [SMOKE]: { id: SMOKE, name: "Fumée", kind: "gas", density: 1, color: [70, 70, 78], noise: 16, life: 140, hint: "Monte puis se dissipe" },
  [STEAM]: { id: STEAM, name: "Vapeur", kind: "gas", density: 1, color: [190, 208, 220], noise: 14, life: 200, spawn: 110, hint: "Eau + feu" },
  [PLANT]: { id: PLANT, name: "Plante", kind: "static", density: 5, color: [58, 150, 74], noise: 20, flammable: 0.25, hint: "Pousse en buvant l'eau" },
  [ICE]: { id: ICE, name: "Glace", kind: "static", density: 5, color: [168, 214, 232], noise: 10, heat: -20, boil: { at: 2, into: WATER }, hint: "Refroidit tout autour, fond près d'une flamme" },
  [GUNPOWDER]: { id: GUNPOWDER, name: "Poudre", kind: "powder", density: 6, color: [64, 62, 58], noise: 20, flammable: 1, hint: "Coule et s'enflamme en chaîne" },
  [SALT]: { id: SALT, name: "Sel", kind: "powder", density: 6, color: [230, 232, 238], noise: 10, hint: "Se dissout dans l'eau, fait fondre la glace" },
  [SALTWATER]: { id: SALTWATER, name: "Eau salée", kind: "liquid", density: 5, color: [50, 92, 150], noise: 10, spread: 4, boil: { at: 100, into: STEAM }, freeze: { at: -18, into: ICE }, hint: "Plus lourde que l'eau douce, gèle à -18 °C" },
  [TNT]: { id: TNT, name: "TNT", kind: "static", density: 8, color: [178, 52, 44], noise: 8, hint: "Explose au contact du feu, en chaîne" },
  [SEED]: { id: SEED, name: "Graine", kind: "powder", density: 5, color: [150, 120, 60], noise: 16, flammable: 0.2, hint: "Tombe, germe en plante dans l'eau" },
  [NANITE]: { id: NANITE, name: "Nanites", kind: "powder", density: 6, color: [190, 190, 200], noise: 30, life: 200, hint: "Dévore la matière et se répand ; seul le verre l'arrête" },
  [SOURCE]: { id: SOURCE, name: "Source", kind: "static", density: 10, color: [130, 96, 190], noise: 10, hint: "Émet en continu la dernière matière choisie" },
  [GLASS]: { id: GLASS, name: "Verre", kind: "static", density: 9, color: [178, 206, 214], noise: 6, hint: "Sable vitrifié : résiste aux nanites" },
};

/** Ordre d'affichage dans la barre d'outils (les 9 premiers = raccourcis 1..9). */
export const PALETTE: MaterialId[] = [
  SAND, WATER, STONE, WOOD, OIL, ACID, LAVA, PLANT, FIRE,
  ICE, SALT, SALTWATER, GUNPOWDER, TNT, SEED, NANITE, GLASS, SOURCE, SMOKE, EMPTY,
];
