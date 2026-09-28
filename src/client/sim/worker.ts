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
  postMessage(news: News, transfer: Transferable[]): void;
  onmessage: ((e: { data: Order | { t: "start"; w: number; h: number } }) => void) | null;
};

let bac: Sandbox | null = null;
let last = performance.now();

/** Les bandes d'une frame sont **transférées** : chacun de leurs tableaux a son tampon, que la page reçoit sans copie. */
function tell(news: News): void {
  const buffers = news.t !== "frame" ? [] : news.patches.flatMap((p) => {
    const own = [p.cells.buffer, p.life.buffer, p.frozen.buffer, p.temp.buffer];
    if (p.noise) own.push(p.noise.buffer);
    return own as ArrayBuffer[];
  });
  worker.postMessage(news, buffers);
}

worker.onmessage = (e) => {
  const order = e.data;
  if (order.t === "start") {
    bac = new Sandbox(order.w, order.h, tell);
    return;
  }
  bac?.order(order);
};

const PERIOD = 1000 / 60;
/** L'heure à laquelle la prochaine frame est due. */
let due = performance.now();

/**
 * ~60 Hz. Le vrai rythme, c'est le temps écoulé : le bac fait ses comptes avec.
 * On vise une échéance fixe plutôt qu'un délai après le travail : attendre
 * 16,7 ms *après* une frame qui en coûte 10 ne livrait que ~37 images par
 * seconde. En retard de plus d'une frame (onglet en veille, tick trop lourd), on
 * repart de maintenant au lieu d'enchaîner des frames pour rattraper.
 */
function loop(): void {
  const now = performance.now();
  const elapsed = now - last;
  last = now;
  // L'échéance suivante est posée même si la frame jette : sans ça, une seule
  // exception du moteur arrêtait la boucle pour de bon — plus un tick, plus une
  // image, jusqu'au rechargement de la page.
  try {
    bac?.frame(elapsed);
  } finally {
    due += PERIOD;
    const after = performance.now();
    if (due < after - PERIOD) due = after;
    setTimeout(loop, Math.max(0, due - after));
  }
}
loop();
