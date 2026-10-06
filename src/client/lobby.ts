/**
 * La porte du salon, côté page. room.ts (lockstep, pseudos, curseurs, verrou)
 * n'est chargé qu'au premier clic sur « Bac partagé » : seul, on n'en a pas
 * besoin, et la page a un budget (84 Kio). D'ici là, main.ts lui parle quand
 * même — un geste à relayer, un curseur à montrer — et rien ne se passe :
 * hors salon, il n'y a personne à qui le dire.
 */
import type { Gesture } from "./gestures.ts";

type Room = typeof import("./room.ts");
type Hooks = Parameters<Room["initRoom"]>[0];

let room: Room | null = null;
let hooks: Hooks | null = null;
let loading = false;

/** Les rappels de main.ts (rôle, taille, geste d'un invité), passés à room.ts quand il arrive. */
export function initRoom(h: Hooks): void {
  hooks = h;
  room?.initRoom(h);
}

/** Relaie un geste à l'hôte, si l'on est invité dans un salon. */
export const relay = (g: Gesture): void => room?.relay(g);
/** Montre aux autres joueurs la cellule sous notre curseur. */
export const pointAt = (x: number, y: number): void => room?.pointAt(x, y);
/** Replace les curseurs des autres, à chaque image. */
export const placeCursors = (): void => room?.placeCursors();

document.querySelector<HTMLButtonElement>("#room")!.addEventListener("click", () => {
  if (room) { room.toggleRoom(); return; }
  if (loading) return; // un double clic pendant le chargement entrerait puis ressortirait
  loading = true;
  void import("./room.ts").then((m) => {
    room = m;
    if (hooks) m.initRoom(hooks);
    m.toggleRoom();
  });
});
