/**
 * Qui a le droit de dire quoi dans un salon. Le Durable Object (room.ts) ne
 * simule rien, mais il ne relaie plus à l'aveugle : un invité qui envoyait
 * `{"type":"role","host":false}` à l'hôte le destituait — plus personne ne
 * simulait —, un `peers: 1` le faisait taire, et sa propre `grid` écrasait le
 * bac des autres invités. `role` et `peers` ne viennent que du salon lui-même.
 *
 * Lire le type coûte un `JSON.parse` par message : quatre grilles par seconde
 * de l'hôte, quelques gestes des invités, rien à côté du relais.
 *
 * Pur, sans `cloudflare:workers` : test/api.ts le charge sous Node.
 */

/** Taille maximale d'un message relayé — même plafond qu'un monde sauvegardé. */
export const MAX = 200_000;

/**
 * Où envoyer un message : aux invités (la grille de l'hôte), à l'hôte (le
 * geste d'un invité), ou nulle part.
 */
export function route(message: string | ArrayBuffer, fromHost: boolean): "guests" | "host" | null {
  if (typeof message !== "string" || message.length > MAX) return null;
  let type: unknown;
  try {
    type = (JSON.parse(message) as { type?: unknown } | null)?.type;
  } catch {
    return null;
  }
  if (fromHost) return type === "grid" ? "guests" : null;
  return type === "do" ? "host" : null;
}
