/**
 * Le juge du classement des défis. Un record arrive avec son rejeu, et le
 * Worker Cloudflare ne le vérifie pas : rejouer cinq minutes de partie lui
 * prendrait ~9 s de calcul, hors de l'offre gratuite (10 ms par requête).
 * C'est donc le navigateur de chaque visiteur qui rejoue les records qu'il
 * affiche (sim/judge.ts, un fil à lui) et n'en montre que ceux qui tiennent.
 *
 * Un record tient si son rejeu part **de la grille du défi**, bâtie ici en
 * code — pas de celle qu'il annonce —, est recevable (`fair()` : joué au
 * pinceau, sous `TRIAL_TICKS`), dure exactement les ticks annoncés, et finit
 * sur un défi gagné. Le moteur étant déterministe, ce qui a gagné chez le
 * joueur gagne ici, au tick près.
 */
import { Engine } from "./engine.ts";
import { encode } from "./codec.ts";
import { CHALLENGES } from "../challenges.ts";
import { Player, fair, type Recording } from "../replay.ts";

/** Le rejeu `rec` gagne-t-il le défi `name` en `ticks` ticks ? */
export function verdict(name: string, rec: Recording, ticks: number): boolean {
  const challenge = CHALLENGES.find((c) => c.name === name);
  if (!challenge || rec.ticks !== ticks || !fair(rec)) return false;
  // Comme `scene()` de sandbox.ts : un bac neuf, à l'ambiante d'un bac neuf.
  const e = new Engine(rec.w, rec.h);
  challenge.build(e);
  if (encode(e.cells, e.frozen, e.life, e.temp, e.names) !== rec.grid) return false;
  const player = new Player(rec, e);
  while (player.step()) { /* jusqu'au dernier tick enregistré */ }
  return challenge.won(e);
}
