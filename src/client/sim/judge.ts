/**
 * Le fil du juge : rejoue les records du classement des défis
 * (`verdict()`), un à la fois, sans figer la page ni le bac. Un record de
 * cinq minutes se rejoue en quelques secondes en 320×180.
 *
 * Ce n'est pas un fil de simulation du bac : il a son propre moteur, neuf à
 * chaque record, et ne touche jamais à celui qu'on regarde.
 */
import { unpack } from "../replay.ts";
import { verdict } from "./verdict.ts";

/** Un record à juger, tel que le sert `GET /api/records/:défi` (le rejeu compressé, `pack()`). */
export interface Case { id: string; challenge: string; ticks: number; film: string }

// `self` typé à la main, comme dans sim/worker.ts : le projet compile avec la lib DOM.
const worker = self as unknown as {
  postMessage(message: unknown): void;
  onmessage: ((e: MessageEvent<Case>) => void) | null;
};

// Les records arrivent tous d'un coup : jugés un par un, dans l'ordre.
let queue = Promise.resolve();
worker.onmessage = (e) => {
  const { id, challenge, ticks, film } = e.data;
  queue = queue.then(async () => {
    let ok = false;
    try {
      const rec = await unpack(film);
      ok = rec !== null && verdict(challenge, rec, ticks);
    } catch {
      ok = false; // un rejeu qui fait lever le moteur ne prouve rien
    }
    worker.postMessage({ id, ok });
  });
};
