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
import { decode, decodeFrozen } from "./sim/codec.ts";
import { type Engine } from "./sim/engine.ts";
import { EMPTY, MATERIALS, SNOW, WATER, type MaterialId } from "./sim/materials.ts";

export type Gesture =
  | { t: "paint"; x: number; y: number; r: number; id: MaterialId; d: number; over: boolean; only?: MaterialId }
  | { t: "fill"; x: number; y: number; id: MaterialId }
  | { t: "rect"; x: number; y: number; x2: number; y2: number; id: MaterialId; over: boolean }
  | { t: "frozen"; x: number; y: number; r: number; on: boolean }
  | { t: "toggle"; x: number; y: number }
  | { t: "clip"; x: number; y: number; w: number; h: number; cells: string; life: string };

/** Un id de matière inventé ferait jeter `MATERIALS[id].life` chez l'hôte. */
const known = (id: MaterialId): MaterialId => (MATERIALS[id] ? id : EMPTY);

export function applyGesture(engine: Engine, g: Gesture): void {
  switch (g.t) {
    case "paint": engine.paint(g.x, g.y, g.r, known(g.id), g.d, g.over, g.only); return;
    case "fill": engine.fill(g.x, g.y, known(g.id)); return;
    case "rect": engine.rect(g.x, g.y, g.x2, g.y2, known(g.id), g.over); return;
    case "frozen": engine.setFrozen(g.x, g.y, g.r, g.on); return;
    // Un seul message pour les deux bascules : la cellule dit laquelle c'est.
    case "toggle": engine.toggleSwitch(g.x, g.y); engine.toggleMagnet(g.x, g.y); return;
    case "clip": {
      const n = g.w * g.h;
      // Un morceau plus grand que le bac ne vient pas d'un pair honnête.
      if (!(n > 0) || n > engine.cells.length) return;
      engine.paste({ width: g.w, height: g.h, cells: decode(g.cells, n), frozen: decodeFrozen(g.cells, n), life: decode(g.life, n) }, g.x, g.y);
      return;
    }
  }
}

/**
 * Météo : quelques gouttes par tick sur la ligne d'où vient la matière (donc en
 * bas si la gravité est inversée). L'ambiante décide de leur nature — c'est ce
 * qui donne enfin à voir le curseur de température.
 *
 * Le tirage passe par `engine.rand()`, pas par `Math.random()` : la pluie fait
 * partie de la partie, un rejeu doit la retrouver goutte pour goutte.
 */
export function weather(engine: Engine): void {
  const id = engine.ambient <= 0 ? SNOW : WATER;
  const y = engine.gravity === 1 ? 0 : engine.height - 1;
  for (let n = Math.max(2, (engine.width / 160) | 0); n > 0; n--) {
    engine.set(Math.floor(engine.rand() * engine.width), y, id);
  }
}
