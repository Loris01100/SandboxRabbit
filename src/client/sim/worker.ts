/**
 * Le fil de la simulation. Trois lignes utiles : le bac (sandbox.ts) reçoit les
 * ordres, une horloge l'avance, et ce qu'il a à dire repart vers la page.
 *
 * Pas de `requestAnimationFrame` dans un Worker : c'est un `setTimeout` qui
 * cadence, et le temps réellement écoulé sert de budget (`ticksFor`) — un onglet
 * en arrière-plan voit ses timers ralentis, la simulation ralentit avec, elle ne
 * rattrape pas sa sieste d'un coup.
 *
 * Le même fichier sert aussi de **fil auxiliaire** du moteur (pool.ts) : il
 * se relance lui-même (`import.meta.url`), et le premier message dit le rôle
 * — `start` pour le bac, une mémoire de moteur pour un fil auxiliaire. Un
 * fichier à part embarquait une seconde copie du moteur : 35 Ko de plus à
 * télécharger.
 */
import { SLICE, Sandbox, type News, type Order } from "./sandbox.ts";
import { Pool, serve, type Helper } from "./pool.ts";

// `self` typé à la main : le projet compile avec la lib DOM, pas celle des
// Workers (les deux se contredisent sur la moitié des noms globaux).
const worker = self as unknown as {
  postMessage(message: unknown, transfer?: Transferable[]): void;
  onmessage: ((e: { data: Order | { t: "start"; w: number; h: number } | { t: "pace"; ms: number } | Parameters<typeof serve>[0] }) => void) | null;
};

let bac: Sandbox | null = null;
let last = performance.now();

/**
 * Les bandes d'une frame sont **transférées** : la page reçoit leur tampon sans
 * copie. Un seul par frame (`Tracker.take()`), et il ne doit figurer qu'une fois
 * dans la liste — deux fois, `postMessage` jette.
 */
function tell(news: News): void {
  const buffers = news.t !== "frame" ? [] : [...new Set(news.patches.map((p) => p.cells.buffer as ArrayBuffer))];
  worker.postMessage(news, buffers);
}

/**
 * Les fils auxiliaires du moteur (pool.ts), si la page est isolée — sinon pas
 * de mémoire partagée, et le moteur fait tout sur ce fil, au même résultat.
 * Autant que de cœurs, moins deux (la page et ce fil-ci), quatorze au plus.
 * Le plafond était de sept, mesuré sur une scène où la mémoire sature ; mais un
 * bac 1920×1080 plein de nanites, où tout calcule, passe encore de 28 ms le
 * tick à 7 fils à 19 ms à 15 (16 cœurs). Au-delà de 16 cœurs, pas mesuré.
 */
function helpers(): Pool | null {
  const scope = self as unknown as { crossOriginIsolated?: boolean; navigator: { hardwareConcurrency?: number } };
  const count = Math.min(14, (scope.navigator.hardwareConcurrency ?? 1) - 2);
  if (!scope.crossOriginIsolated || count < 1) return null;
  const list = Array.from({ length: count }, (): Helper => {
    const w = new Worker(import.meta.url, { type: "module" });
    return { post: (message) => w.postMessage(message), listen: (fn) => { w.onmessage = (e) => fn(e.data); } };
  });
  return new Pool(list);
}

worker.onmessage = (e) => {
  const message = e.data;
  if ("memory" in message) {
    serve(message, (ready) => worker.postMessage(ready));
    return;
  }
  if (message.t === "start") {
    bac = new Sandbox(message.w, message.h, tell, helpers());
    loop();
    return;
  }
  // La page a mesuré son écran, ou le joueur a limité les images (world.ts) :
  // borné ici aussi, un nombre venu d'ailleurs ne doit pas faire tourner la
  // boucle à vide.
  if (message.t === "pace") {
    if (Number.isFinite(message.ms)) period = Math.min(Math.max(message.ms, 1000 / 240), 1000 / 30);
    return;
  }
  bac?.order(message);
};

/** L'écart visé entre deux frames : 60 Hz jusqu'à ce que la page dise la fréquence de son écran ou sa limite (`pace`). */
let period = 1000 / 60;
/** L'heure à laquelle la prochaine frame est due. */
let due = performance.now();

/**
 * Au rythme de l'écran (60 Hz par défaut, 240 au plus, 30 au moins). Le vrai rythme, c'est le temps écoulé : le bac fait ses comptes avec.
 * On vise une échéance fixe plutôt qu'un délai après le travail : attendre
 * 16,7 ms *après* une frame qui en coûte 10 ne livrait que ~37 images par
 * seconde. En retard de plus d'une frame (onglet en veille, tick trop lourd), on
 * repart de maintenant au lieu d'enchaîner des frames pour rattraper. Lancée
 * par `start` seulement : un fil auxiliaire n'a pas d'horloge.
 */
function loop(): void {
  const now = performance.now();
  const elapsed = now - last;
  last = now;
  // L'échéance suivante est posée même si la frame jette : sans ça, une seule
  // exception du moteur arrêtait la boucle pour de bon — plus un tick, plus une
  // image, jusqu'au rechargement de la page.
  try {
    // Une frame deux fois plus longue (limite à 30 images) simule deux fois
    // plus longtemps : sans ça, un bac chargé ralentissait de moitié.
    bac?.frame(elapsed, SLICE * Math.max(1, period / (1000 / 60)));
  } finally {
    due += period;
    const after = performance.now();
    if (due < after - period) due = after;
    setTimeout(loop, Math.max(0, due - after));
  }
}
