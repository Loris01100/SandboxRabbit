/**
 * Qui a le droit de dire quoi dans un salon. Le Durable Object (room.ts) ne
 * simule rien, mais il ne relaie plus à l'aveugle : un invité qui envoyait
 * `{"type":"role","host":false}` à l'hôte le destituait — plus personne ne
 * menait la partie —, un `peers: 1` le faisait taire, et son propre `start`
 * aurait écrasé le bac des autres invités. `role` et `peers` ne viennent que
 * du salon lui-même.
 *
 * Lire le type coûte un `JSON.parse` par message : vingt suites de partie par
 * seconde de l'hôte, quelques gestes des invités, rien à côté du relais.
 *
 * Pur, sans `cloudflare:workers` : test/api.ts le charge sous Node.
 */

/** Taille maximale d'un message relayé — même plafond qu'un monde sauvegardé. */
export const MAX = 200_000;

/**
 * Où envoyer un message : aux invités (le départ et la suite de la partie de
 * l'hôte), à l'hôte (le geste d'un invité, ou sa demande de repartir quand il
 * a divergé), ou nulle part.
 */
export function route(message: string | ArrayBuffer, fromHost: boolean): "guests" | "host" | null {
  if (typeof message !== "string" || message.length > MAX) return null;
  let type: unknown;
  try {
    type = (JSON.parse(message) as { type?: unknown } | null)?.type;
  } catch {
    return null;
  }
  if (fromHost) return type === "start" || type === "turn" ? "guests" : null;
  return type === "do" || type === "sync" ? "host" : null;
}

/** Joueurs par salon. Au-delà, un arrivant coûte un départ complet à tous les autres. */
export const PLACES = 8;

/** Longueur d'un pseudo, en caractères. */
const NICK = 24;

/**
 * Le pseudo qu'un joueur annonce en entrant (`?nick=` de l'URL du salon), tel
 * que les autres le verront : texte seul, sans caractère de contrôle (un saut
 * de ligne cassait la liste des joueurs), espaces resserrés, 24 caractères au
 * plus. Vide si rien d'utilisable : la page affiche alors « Joueur N ».
 */
export function nick(raw: unknown): string {
  if (typeof raw !== "string") return "";
  return [...raw.replace(/[\p{Cc}\p{Cf}]/gu, "").replace(/\s+/g, " ").trim()].slice(0, NICK).join("");
}

/** Le plus petit numéro de joueur libre, de 1 à `PLACES` : il donne sa couleur au curseur, et se recycle quand un joueur part. */
export function freeId(taken: number[]): number {
  for (let id = 1; id <= PLACES; id++) if (!taken.includes(id)) return id;
  return 0;
}

/** Plus grande coordonnée de cellule acceptée : la plus grande grille du menu fait 1920 de large. */
const FAR = 4096;

/**
 * Le curseur d'un joueur, refait par le salon avant d'être relayé à tous les
 * autres : c'est le salon qui y met le numéro de l'émetteur (`id`), sinon un
 * joueur pourrait déplacer le curseur d'un autre. Des cellules entières, ou
 * -1, -1 quand il a quitté le bac. Rien d'autre ne passe : le curseur ne
 * touche pas la grille, il ne peut donc pas faire diverger le lockstep, mais
 * il est relayé à tout le monde, invités compris.
 */
export function cursor(message: string | ArrayBuffer, id: number): string | null {
  if (typeof message !== "string" || message.length > 200) return null;
  let msg: { type?: unknown; x?: unknown; y?: unknown } | null;
  try {
    msg = JSON.parse(message) as typeof msg;
  } catch {
    return null;
  }
  if (msg?.type !== "cursor") return null;
  const { x, y } = msg;
  const inside = (v: unknown): v is number => Number.isInteger(v) && (v as number) >= 0 && (v as number) < FAR;
  const away = x === -1 && y === -1;
  if (!away && !(inside(x) && inside(y))) return null;
  return JSON.stringify({ type: "cursor", id, x, y });
}

/** Un joueur tel que le salon le connaît : rangé dans la pièce jointe de son socket. */
export interface Player { host: boolean; id: number; name: string }

/** La liste des joueurs, envoyée à tous à chaque arrivée, départ ou changement d'hôte. */
export function roster(players: Player[]): string {
  return JSON.stringify({ type: "roster", players: players.map(({ id, name, host }) => ({ id, name, host })) });
}
