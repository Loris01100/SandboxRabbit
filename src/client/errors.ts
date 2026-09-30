/**
 * Les erreurs des joueurs, remontées au Worker (`POST /api/error`) qui les
 * écrit dans ses journaux : sans ça, une exception chez un joueur — dans la
 * page ou dans le Worker de simulation, où le bac se fige sans un mot — ne
 * laissait aucune trace. Ni la grille ni rien qui désigne le joueur : le
 * message et la pile, le navigateur se lit dans l'en-tête de la requête.
 *
 * ponytail: les piles de production pointent dans le bundle minifié
 * (`index-….js:1:48213`). Construire avec `build.sourcemap: "hidden"` et
 * décoder à la main le jour où une pile ne suffit plus à retrouver l'erreur.
 */

/** Plafond d'un rapport, en caractères : une pile tient largement dedans. Le Worker refuse au-delà de 16 Kio (`/api/error`). */
export const REPORT = 4000;

/**
 * Un rapporteur : chaque message distinct part une fois, et `max` au plus par
 * visite. Une erreur dans la boucle de rendu se répète soixante fois par
 * seconde : sans ce filtre, un seul joueur inondait la route.
 */
export function reporter(send: (text: string) => void, max = 5): (text: string) => void {
  const seen = new Set<string>();
  return (text) => {
    if (seen.size >= max || seen.has(text)) return;
    seen.add(text);
    send(text.slice(0, REPORT));
  };
}

/**
 * Écoute la page et le Worker de simulation. `sendBeacon` plutôt que `fetch` :
 * il part même si l'onglet se ferme juste après, ce que suit souvent une
 * erreur. Le Worker a son propre événement : ses exceptions n'atteignent
 * jamais le `window` de la page, et n'y donnent que message et ligne, pas de
 * pile.
 */
export function watchErrors(sim: Worker): void {
  const report = reporter((text) => navigator.sendBeacon("/api/error", text));
  const stack = (e: unknown) => (e instanceof Error ? e.stack ?? e.message : String(e));
  addEventListener("error", (e) => report(`page : ${e.error ? stack(e.error) : `${e.message} (${e.filename}:${e.lineno}:${e.colno})`}`));
  addEventListener("unhandledrejection", (e) => report(`promesse : ${stack(e.reason)}`));
  sim.addEventListener("error", (e) => report(`simulation : ${e.message} (${e.filename}:${e.lineno}:${e.colno})`));
}
