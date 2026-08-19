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
export const MERCURY = 21;
export const WAX = 22;
export const MOLTEN_WAX = 23;
export const CANDLE = 24;
export const SNOW = 25;
export const MUD = 26;
export const EMBER = 27;
export const METAL = 28;
export const SPARK = 29;
export const TAR = 30;
export const ALCOHOL = 31;
export const MOLTEN_GLASS = 32;
export const BATTERY = 33;
export const SWITCH = 34;
export const NITROGEN = 35;
export const NITRO = 36;
export const C4 = 37;
export const FIREDAMP = 38;
export const MINE = 39;
export const THERMITE = 40;
export const PETROLEUM = 41;
export const URANIUM = 42;
export const FALLOUT = 43;
export const CEMENT = 44;
export const FILINGS = 45;
export const MAGNET = 46;

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
  /**
   * Probabilité, **par tick et par flamme voisine**, de prendre feu.
   * C'est le seul réglage de la vitesse de propagation : 1 = instantané
   * (poudre), 0,02 = une bûche qui met une seconde à s'embraser.
   */
  flammable?: number;
  /** Durée de vie en ticks (feu, fumée, vapeur), 250 au maximum (`life` est un octet). 0 = éternel. */
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
  [STONE]: { id: STONE, name: "Pierre", kind: "static", density: 9, color: [122, 124, 132], noise: 14, boil: { at: 1400, into: LAVA }, hint: "Immobile ; il faut passer 1400 °C pour la liquéfier" },
  [WOOD]: { id: WOOD, name: "Bois", kind: "static", density: 8, color: [110, 74, 43], noise: 12, flammable: 0.02, hint: "Immobile, brûle lentement" },
  [WATER]: { id: WATER, name: "Eau", kind: "liquid", density: 4, color: [56, 108, 176], noise: 10, spread: 4, boil: { at: 100, into: STEAM }, freeze: { at: 0, into: ICE }, hint: "S'étale, éteint le feu, gèle à 0 °C" },
  [OIL]: { id: OIL, name: "Huile", kind: "liquid", density: 3, color: [78, 62, 38], noise: 8, spread: 3, flammable: 0.6, boil: { at: 250, into: FIRE }, hint: "Flotte sur l'eau, s'enflamme toute seule si ça chauffe" },
  [ACID]: { id: ACID, name: "Acide", kind: "liquid", density: 4, color: [126, 224, 58], noise: 12, spread: 3, hint: "Dissout les solides" },
  [LAVA]: { id: LAVA, name: "Lave", kind: "liquid", density: 7, color: [226, 88, 24], noise: 22, spread: 1, heat: 1200, hint: "Brûle tout, se fige au contact de l'eau, vitrifie le sable" },
  [FIRE]: { id: FIRE, name: "Feu", kind: "gas", density: 1, color: [244, 132, 32], noise: 40, life: 60, heat: 800, hint: "Se propage, laisse de la fumée" },
  [SMOKE]: { id: SMOKE, name: "Fumée", kind: "gas", density: 1, color: [70, 70, 78], noise: 16, life: 140, hint: "Monte puis se dissipe" },
  [STEAM]: { id: STEAM, name: "Vapeur", kind: "gas", density: 1, color: [190, 208, 220], noise: 14, life: 200, spawn: 110, hint: "Eau + feu" },
  [PLANT]: { id: PLANT, name: "Plante", kind: "static", density: 5, color: [58, 150, 74], noise: 20, flammable: 0.08, hint: "Pousse en buvant l'eau, s'enflamme vite une fois sèche" },
  [ICE]: { id: ICE, name: "Glace", kind: "static", density: 5, color: [168, 214, 232], noise: 10, heat: -20, boil: { at: 2, into: WATER }, hint: "Refroidit tout autour, fond près d'une flamme" },
  [GUNPOWDER]: { id: GUNPOWDER, name: "Poudre", kind: "powder", density: 6, color: [64, 62, 58], noise: 20, flammable: 1, hint: "Coule et s'enflamme en chaîne" },
  [SALT]: { id: SALT, name: "Sel", kind: "powder", density: 6, color: [230, 232, 238], noise: 10, hint: "Se dissout dans l'eau, fait fondre la glace" },
  [SALTWATER]: { id: SALTWATER, name: "Eau salée", kind: "liquid", density: 5, color: [50, 92, 150], noise: 10, spread: 4, boil: { at: 100, into: STEAM }, freeze: { at: -18, into: ICE }, hint: "Plus lourde que l'eau douce, gèle à -18 °C" },
  [TNT]: { id: TNT, name: "TNT", kind: "static", density: 8, color: [178, 52, 44], noise: 8, hint: "Explose au contact du feu, en chaîne" },
  [SEED]: { id: SEED, name: "Graine", kind: "powder", density: 5, color: [150, 120, 60], noise: 16, flammable: 0.05, hint: "Tombe, germe en plante dans l'eau" },
  [NANITE]: { id: NANITE, name: "Nanites", kind: "powder", density: 6, color: [190, 190, 200], noise: 30, life: 200, hint: "Dévore la matière et se répand ; seul le verre l'arrête" },
  [SOURCE]: { id: SOURCE, name: "Source", kind: "static", density: 10, color: [130, 96, 190], noise: 10, hint: "Émet en continu la dernière matière choisie" },
  [GLASS]: { id: GLASS, name: "Verre", kind: "static", density: 9, color: [178, 206, 214], noise: 6, boil: { at: 700, into: MOLTEN_GLASS }, hint: "Sable vitrifié : résiste aux nanites, refond à 700 °C" },
  [MERCURY]: { id: MERCURY, name: "Mercure", kind: "liquid", density: 13, color: [198, 204, 216], noise: 24, spread: 2, freeze: { at: -39, into: METAL }, boil: { at: 357, into: SMOKE }, hint: "Le plus lourd : passe sous tout, gèle en métal à -39 °C" },
  [WAX]: { id: WAX, name: "Cire", kind: "static", density: 5, color: [236, 224, 188], noise: 8, flammable: 0.01, boil: { at: 60, into: MOLTEN_WAX }, hint: "Fond dès 60 °C" },
  [MOLTEN_WAX]: { id: MOLTEN_WAX, name: "Cire fondue", kind: "liquid", density: 5, color: [240, 212, 140], noise: 10, spread: 2, freeze: { at: 55, into: WAX }, hint: "Coule, puis durcit en refroidissant" },
  [CANDLE]: { id: CANDLE, name: "Bougie", kind: "static", density: 5, color: [206, 176, 120], noise: 8, hint: "S'allume au contact d'une flamme et brûle sans fin ; l'eau la souffle" },
  [SNOW]: { id: SNOW, name: "Neige", kind: "powder", density: 2, color: [228, 240, 250], noise: 12, heat: -12, boil: { at: 2, into: WATER }, hint: "S'amoncelle, flotte sur l'eau, fond à la moindre chaleur" },
  [MUD]: { id: MUD, name: "Boue", kind: "liquid", density: 7, color: [92, 68, 46], noise: 18, spread: 1, boil: { at: 60, into: SAND }, hint: "Coule lentement, engloutit, sèche en sable" },
  [EMBER]: { id: EMBER, name: "Braise", kind: "powder", density: 6, color: [188, 62, 22], noise: 40, life: 250, heat: 350, hint: "Ce que laisse le bois brûlé : chauffe longtemps après la flamme" },
  [METAL]: { id: METAL, name: "Métal", kind: "static", density: 9, color: [158, 168, 184], noise: 8, hint: "Conduit l'étincelle, et rien d'autre" },
  [SPARK]: { id: SPARK, name: "Étincelle", kind: "static", density: 1, color: [255, 240, 120], noise: 30, life: 3, hint: "Court dans le métal, enflamme et fait sauter ce qu'elle touche" },
  [TAR]: { id: TAR, name: "Goudron", kind: "liquid", density: 5, color: [42, 38, 36], noise: 6, spread: 0, flammable: 0.35, hint: "Huile lourde : coule à peine, colle et brûle longtemps" },
  [ALCOHOL]: { id: ALCOHOL, name: "Alcool", kind: "liquid", density: 2, color: [156, 196, 216], noise: 8, spread: 4, flammable: 0.9, boil: { at: 40, into: SMOKE }, hint: "Flotte sur tout, s'enflamme d'un rien, s'évapore dès 40 °C" },
  [MOLTEN_GLASS]: { id: MOLTEN_GLASS, name: "Verre fondu", kind: "liquid", density: 8, color: [255, 170, 84], noise: 20, spread: 1, spawn: 900, freeze: { at: 600, into: GLASS }, hint: "Coule brûlant, puis se fige en verre sous 600 °C" },
  [BATTERY]: { id: BATTERY, name: "Pile", kind: "static", density: 9, color: [86, 196, 132], noise: 8, hint: "Envoie une étincelle dans le métal voisin, sans fin" },
  [SWITCH]: { id: SWITCH, name: "Interrupteur", kind: "static", density: 9, color: [176, 132, 60], noise: 8, hint: "Cliquez dessus pour ouvrir ou fermer le circuit" },
  [NITROGEN]: { id: NITROGEN, name: "Azote liquide", kind: "liquid", density: 1, color: [214, 240, 250], noise: 10, spread: 2, heat: -190, boil: { at: -60, into: STEAM }, hint: "À -190 °C : gèle tout ce qu'il touche et s'évapore en buée" },
  [NITRO]: { id: NITRO, name: "Nitroglycérine", kind: "liquid", density: 4, color: [208, 196, 116], noise: 8, spread: 1, hint: "Huile instable : la poser ne risque rien, la faire tomber tout casser" },
  [C4]: { id: C4, name: "C4", kind: "static", density: 8, color: [232, 228, 212], noise: 6, hint: "Insensible au feu : ne saute que sous l'étincelle, et entraîne ses voisins" },
  [FIREDAMP]: { id: FIREDAMP, name: "Grisou", kind: "gas", density: 1, color: [128, 172, 126], noise: 14, life: 250, flammable: 1, hint: "Gaz de mine : s'accumule au plafond et part d'un seul coup" },
  [MINE]: { id: MINE, name: "Mine", kind: "static", density: 8, color: [104, 116, 96], noise: 8, hint: "Saute sous le poids de ce qui coule ; on peut la murer sans risque" },
  [PETROLEUM]: { id: PETROLEUM, name: "Pétrole", kind: "liquid", density: 3, color: [30, 28, 40], noise: 10, spread: 2, boil: { at: 200, into: FIREDAMP }, hint: "Ne brûle pas : chauffé, il dégage du grisou — c'est le gaz qui explose" },
  [URANIUM]: { id: URANIUM, name: "Uranium", kind: "powder", density: 12, color: [96, 132, 88], noise: 14, heat: 60, hint: "Un grain tiédit ; un tas s'emballe, chauffe et finit par sauter — l'éparpiller le calme" },
  [FALLOUT]: { id: FALLOUT, name: "Retombées", kind: "gas", density: 1, color: [176, 208, 96], noise: 22, life: 250, hint: "Nuage radioactif : rien ne pousse dedans, et il traîne longtemps" },
  [CEMENT]: { id: CEMENT, name: "Ciment", kind: "liquid", density: 8, color: [148, 148, 140], noise: 10, spread: 1, boil: { at: 60, into: STONE }, hint: "Se coule dans un moule et prend en pierre dès 60 °C" },
  [FILINGS]: { id: FILINGS, name: "Limaille", kind: "powder", density: 8, color: [96, 98, 104], noise: 26, hint: "Poudre de fer : un aimant la fait venir, même vers le haut" },
  [MAGNET]: { id: MAGNET, name: "Aimant", kind: "static", density: 9, color: [204, 84, 96], noise: 8, hint: "Attire la limaille alentour, gravité ou pas" },
  [THERMITE]: { id: THERMITE, name: "Thermite", kind: "powder", density: 8, color: [124, 112, 102], noise: 20, hint: "Ne souffle rien : brûle à 2800 °C et perce la pierre" },
};

/**
 * Familles affichées dans la barre d'outils : un `<details>` repliable chacune.
 * Une matière peut n'y figurer nulle part (elle n'est alors obtenue qu'en jeu).
 */
export const CATEGORIES: { name: string; ids: MaterialId[] }[] = [
  { name: "Terrain", ids: [SAND, STONE, WOOD, GLASS, MUD, SALT, FILINGS] },
  { name: "Liquides", ids: [WATER, SALTWATER, OIL, PETROLEUM, TAR, ALCOHOL, ACID, MERCURY, MOLTEN_WAX, MOLTEN_GLASS, CEMENT] },
  { name: "Inflammable", ids: [FIRE, EMBER, LAVA, WAX, CANDLE] },
  { name: "Explosifs", ids: [GUNPOWDER, TNT, NITRO, C4, MINE, THERMITE, URANIUM] },
  { name: "Froid", ids: [ICE, SNOW, NITROGEN] },
  { name: "Vivant", ids: [SEED, PLANT, NANITE] },
  { name: "Électricité", ids: [METAL, BATTERY, SWITCH, SPARK, MAGNET] },
  { name: "Gaz", ids: [SMOKE, STEAM, FIREDAMP, FALLOUT] },
  { name: "Outils", ids: [SOURCE, EMPTY] },
];

/** Toutes les matières de la barre d'outils, familles mises bout à bout. */
export const PALETTE: MaterialId[] = CATEGORIES.flatMap((c) => c.ids);

/** Raccourcis clavier 1..9 puis 0 : les classiques, quel que soit l'ordre des familles. */
export const SHORTCUTS: MaterialId[] = [SAND, WATER, STONE, WOOD, OIL, FIRE, ICE, PLANT, TNT, EMPTY];
