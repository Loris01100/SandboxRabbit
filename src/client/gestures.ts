/**
 * Les gestes qui modifient la grille, décrits comme des valeurs.
 *
 * C'est ce qui permet de les rejouer ailleurs : dans un salon partagé, l'invité
 * envoie le geste et l'hôte l'applique à l'identique ; dans un enregistrement,
 * c'est la liste des gestes qui **est** la partie (replay.ts). Rien ici ne
 * touche au DOM — ni au panneau, ni au pinceau — et le moteur visé est passé
 * en argument plutôt qu'importé de world.ts : sans ça un rejeu ne pourrait
 * s'appliquer qu'au bac affiché, et Node ne pourrait pas charger ce module.
 */
import { cleanName, decode, decodeFrozen } from "./sim/codec.ts";
import { type Engine } from "./sim/engine.ts";
import { EMPTY, FIRE, MATERIALS, METAL, placeable, SNOW, SPARK, WATER, type MaterialId } from "./sim/materials.ts";

export type Gesture =
  | { t: "paint"; x: number; y: number; r: number; id: MaterialId; d: number; over: boolean; only?: MaterialId }
  | { t: "fill"; x: number; y: number; id: MaterialId }
  | { t: "rect"; x: number; y: number; x2: number; y2: number; id: MaterialId; over: boolean }
  | { t: "frozen"; x: number; y: number; r: number; on: boolean }
  | { t: "toggle"; x: number; y: number }
  | { t: "clip"; x: number; y: number; w: number; h: number; cells: string; life: string }
  | { t: "pilot"; keys: number }
  | { t: "name"; id: number; name: string }
  | { t: "hero" };

/**
 * Les noms d'origine des héros : leur numéro (`HERO_SLOTS.name`, 1 à 250 —
 * tiré de sa place quand on le pose, au hasard s'il n'en a pas au premier
 * tick) en choisit un. Deux héros peuvent tomber sur le même nom (un sur
 * quarante), et sur le même numéro (un sur 250) : ils partagent alors aussi
 * celui qu'on leur donne, et obéissent ensemble quand l'un est piloté.
 * ponytail: numéro tiré au hasard, sans chercher s'il est pris — à revoir le
 * jour où un monde garde des dizaines de héros.
 */
export const NAMES = [
  "Alix", "Basile", "Camille", "Dany", "Élie", "Fanny", "Gaspard", "Hélène", "Inès", "Jules",
  "Karim", "Léa", "Maël", "Nina", "Oscar", "Paulette", "Quentin", "Rose", "Sacha", "Téo",
  "Ulysse", "Victor", "Wanda", "Yanis", "Zoé", "Anouk", "Bruno", "Céleste", "Diane", "Émile",
  "Firmin", "Gisèle", "Hugo", "Iris", "Jeanne", "Louison", "Margot", "Noé", "Odile", "Pablo",
];

/** Le nom du héros de numéro `id` : celui qu'on lui a donné, sinon celui d'origine. 0 (pas encore tiré) : pas de nom. */
export const heroName = (engine: Engine, id: number): string =>
  engine.names.get(id) ?? (id > 0 ? NAMES[id % NAMES.length] : "");

/** Un id de matière inventé ferait jeter `MATERIALS[id].life` chez l'hôte. */
const known = (id: MaterialId): MaterialId => (MATERIALS[id] ? id : EMPTY);

/**
 * Des coordonnées entières, ou rien. Un pair de salon envoie ce qu'il veut :
 * un remplissage en x = 1,5 ne remplissait jamais rien, sa pile ne se vidait
 * plus, et l'onglet de l'hôte gelait sur un seul message.
 */
const whole = (...v: number[]): boolean => v.every(Number.isSafeInteger);

/**
 * Applique un geste au moteur. Les commandes du héros (`pilot`) sont un geste
 * elles aussi : c'est ce qui les fait enregistrer par le rejeu et relayer à
 * l'hôte d'un salon, au tick près. Bornées à leurs six bits, plus la matière
 * à poser si le héros peut la tenir (`placeable`), sinon rien : un pair
 * envoie ce qu'il veut.
 */
export function applyGesture(engine: Engine, g: Gesture): void {
  // Passer au héros suivant : c'est le moteur qui sait lequel, dans l'ordre
  // de la grille — un geste, pour que le rejeu et le salon suivent.
  if (g.t === "hero") { engine.nextHero(); return; }
  if (g.t === "name") {
    // Un nom vide rend celui d'origine.
    const name = cleanName(g.name);
    if (!(Number.isSafeInteger(g.id) && g.id > 0 && g.id < 256)) return;
    if (name) engine.names.set(g.id, name);
    else engine.names.delete(g.id);
    return;
  }
  if (g.t === "pilot") {
    const id = (g.keys >> 8) & 255;
    engine.pilot = ((g.keys | 0) & 63) | (placeable(id) ? id << 8 : 0);
    return;
  }
  if (!whole(g.x, g.y)) return;
  switch (g.t) {
    case "paint": engine.paint(g.x, g.y, g.r, known(g.id), g.d, g.over, g.only); return;
    case "fill": engine.fill(g.x, g.y, known(g.id)); return;
    case "rect": if (whole(g.x2, g.y2)) engine.rect(g.x, g.y, g.x2, g.y2, known(g.id), g.over); return;
    case "frozen": engine.setFrozen(g.x, g.y, g.r, g.on); return;
    // Un seul message pour les deux bascules : la cellule dit laquelle c'est.
    case "toggle": engine.toggleSwitch(g.x, g.y); engine.toggleMagnet(g.x, g.y); return;
    case "clip": {
      const n = g.w * g.h;
      // Un morceau plus grand que le bac ne vient pas d'un pair honnête.
      if (!whole(g.w, g.h) || !(n > 0) || n > engine.cells.length) return;
      engine.paste({ width: g.w, height: g.h, cells: decode(g.cells, n), frozen: decodeFrozen(g.cells, n), life: decode(g.life, n) }, g.x, g.y);
      return;
    }
  }
}

/** Chance d'un éclair par tick, par niveau de météo : ~1 toutes les 5 s à l'orage, ~1 par seconde au gros orage. */
const BOLT = [0, 0, 1 / 300, 1 / 60];

/**
 * Météo : quelques gouttes par tick sur la ligne d'où vient la matière (donc en
 * bas si la gravité est inversée). L'ambiante décide de leur nature — c'est ce
 * qui donne enfin à voir le curseur de température. `level` : 0 sec, 1 pluie,
 * 2 orage, 3 gros orage. L'orage ne pleut pas plus fort, il ajoute des
 * éclairs : trois fois plus de gouttes noyaient le bac en une minute, et l'eau
 * qui s'étale coûtait jusqu'à 12 ms le tick en 640×360 — la vitesse ne tenait plus.
 *
 * Le tirage passe par `engine.rand()`, pas par `Math.random()` : la pluie fait
 * partie de la partie, un rejeu doit la retrouver goutte pour goutte. La simple
 * pluie ne tire rien de plus qu'avant l'orage : ses rejeus restent les mêmes.
 */
export function weather(engine: Engine, level: number): void {
  if (!(level > 0)) return;
  const id = engine.ambient <= 0 ? SNOW : WATER;
  const y = engine.gravity === 1 ? 0 : engine.height - 1;
  for (let n = Math.max(2, (engine.width / 160) | 0); n > 0; n--) {
    engine.set(Math.floor(engine.rand() * engine.width), y, id);
  }
  if (level > 1 && engine.rand() < BOLT[level]) bolt(engine, Math.floor(engine.rand() * engine.width), y);
}

/**
 * Un éclair : une ligne de feu qui zigzague depuis le ciel jusqu'à la première
 * matière qui l'arrête. Il traverse les gaz et les gouttes encore en l'air, pas
 * un lac. Le métal touché reçoit une étincelle, qui court dans le circuit puis
 * redevient métal ; ailleurs, une gerbe de feu autour de l'impact — le bois
 * prend, le TNT saute, le sable finit en verre. Une cellule figée n'est pas
 * touchée, comme sous le pinceau « ne pas remplacer ».
 */
function bolt(engine: Engine, x: number, y: number): void {
  const g = engine.gravity;
  for (; engine.inBounds(x, y); y += g) {
    if (!open(engine, x, y) && !(falling(engine, x, y) && open(engine, x, y + g))) break;
    engine.set(x, y, FIRE);
    x = Math.min(engine.width - 1, Math.max(0, x + Math.floor(engine.rand() * 3) - 1));
  }
  if (!engine.inBounds(x, y) || engine.frozen[engine.index(x, y)]) return;
  if (engine.get(x, y) === METAL) return engine.set(x, y, SPARK);
  for (let dy = -2; dy <= 2; dy++) {
    for (let dx = -2; dx <= 2; dx++) if (open(engine, x + dx, y + dy)) engine.set(x + dx, y + dy, FIRE);
  }
}

/** Vide ou gaz : ce que l'éclair traverse. Hors grille, `get()` rend un mur. */
const open = (engine: Engine, x: number, y: number): boolean => {
  const kind = MATERIALS[engine.get(x, y)].kind;
  return kind === "empty" || kind === "gas";
};

/** Une goutte ou un flocon (ceux de la météo), que l'éclair traverse s'ils sont en l'air. */
const falling = (engine: Engine, x: number, y: number): boolean => {
  const id = engine.get(x, y);
  return id === WATER || id === SNOW;
};
