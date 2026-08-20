/**
 * Le fil de la simulation. Trois lignes utiles : le bac (sandbox.ts) reçoit les
 * ordres, une horloge l'avance, et ce qu'il a à dire repart vers la page.
 *
 * Pas de `requestAnimationFrame` dans un Worker : c'est un `setTimeout` qui
 * cadence, et le temps réellement écoulé sert de budget (`ticksFor`) — un onglet
 * en arrière-plan voit ses timers ralentis, la simulation ralentit avec, elle ne
 * rattrape pas sa sieste d'un coup.
 */
import { Sandbox, type News, type Order } from "./sandbox.ts";

// `self` typé à la main : le projet compile avec la lib DOM, pas celle des
// Workers (les deux se contredisent sur la moitié des noms globaux).
const worker = self as unknown as {
  postMessage(news: News): void;
  onmessage: ((e: { data: Order | { t: "start"; w: number; h: number } }) => void) | null;
};

let bac: Sandbox | null = null;
let last = performance.now();

worker.onmessage = (e) => {
  const order = e.data;
  if (order.t === "start") {
    bac = new Sandbox(order.w, order.h, (news) => worker.postMessage(news));
    return;
  }
  bac?.order(order);
};

/** ~60 Hz. Le vrai rythme, c'est le temps écoulé : le bac fait ses comptes avec. */
function loop(): void {
  const now = performance.now();
  const elapsed = now - last;
  last = now;
  bac?.frame(elapsed);
  setTimeout(loop, 1000 / 60);
}
loop();
