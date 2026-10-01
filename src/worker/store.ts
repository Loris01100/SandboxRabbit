import type { Env } from "./app.ts";

export interface World {
  id: string;
  name: string;
  width: number;
  height: number;
  /** Grille encodée (RLE + base64), voir src/client/sim/codec.ts */
  data: string;
  createdAt: string;
  /** Nombre de chargements depuis la galerie. */
  views: number;
  /** Objectif si le monde est un défi : « ge:12:600 » ou « lt:5:1 ». Absent sinon. */
  goal?: string | null;
  /** Le monde dont celui-ci est un remix (son `id`), ou rien s'il est parti de zéro. Le parent peut avoir disparu depuis. */
  parent?: string | null;
  /** Nombre de « J'aime ». */
  likes?: number;
  /**
   * Jeton de suppression, rendu une seule fois à la sauvegarde. Il ne sort
   * jamais de `list()` ni de `get()` : c'est tout ce qui distingue le déposant
   * d'un visiteur, la galerie n'ayant pas de comptes.
   */
  token?: string | null;
}

/** Le monde tel qu'il est servi : sans son jeton. */
const shown = ({ token: _, ...world }: World): World => world;

export interface Store {
  /** Renvoie les grilles : la galerie en fait ses vignettes, ~1 ko par monde. */
  list(): Promise<World[]>;
  get(id: string): Promise<World | null>;
  save(world: World): Promise<void>;
  /** Supprime, mais seulement pour le bon jeton. False = ce n'est pas votre monde. */
  remove(id: string, token: string): Promise<boolean>;
  /** Ne garde que les mondes choisis par `kept()` (ménage nocturne). */
  purge(keep: number): Promise<void>;
  /** Compte un chargement. Appelé par `GET /api/worlds/:id`, seul chemin de chargement. */
  see(id: string): Promise<void>;
  /** Compte un « J'aime » ; rend le nouveau total, ou null si le monde n'existe pas. */
  like(id: string): Promise<number | null>;
}

/**
 * Deux implémentations derrière la même interface :
 *  - D1 dès que le binding existe (voir la section commentée de wrangler.jsonc)
 *  - sinon une Map en mémoire, suffisante pour jouer en local.
 *
 * La version mémoire vit dans l'isolate : elle disparaît au redémarrage et
 * n'est pas partagée entre les machines de Cloudflare. C'est volontairement un
 * bouchon, pas un stockage.
 */
export function createStore(env: Env): Store {
  return env.DB ? d1Store(env.DB) : memoryStore();
}

const memory = new Map<string, World>();

/**
 * Mondes gardés, et montrés par la galerie : les `keep` plus récents, les
 * `keep` plus vus **et** les `keep` plus aimés. Avec les seuls récents, 50 sauvegardes vides (deux minutes
 * et demie au débit permis) poussaient tous les autres mondes dehors, et le
 * ménage nocturne les effaçait.
 * ponytail: un spammeur à plusieurs IP peut encore gonfler les vues de ses
 * mondes ; un compte ou un Turnstile le jour où ça arrive.
 */
function kept(worlds: World[], keep: number): World[] {
  const recent = [...worlds].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const viewed = [...recent].sort((a, b) => b.views - a.views).slice(0, keep);
  const liked = [...recent].sort((a, b) => (b.likes ?? 0) - (a.likes ?? 0)).slice(0, keep);
  return recent.filter((w, i) => i < keep || viewed.includes(w) || liked.includes(w));
}

/** Le choix de `kept()` en SQL, `?1` valant `keep`. */
const KEPT =
  "id IN (SELECT id FROM worlds ORDER BY created_at DESC LIMIT ?1) OR id IN (SELECT id FROM worlds ORDER BY views DESC, created_at DESC LIMIT ?1) OR id IN (SELECT id FROM worlds ORDER BY likes DESC, created_at DESC LIMIT ?1)";

/** Les colonnes servies : jamais `token` (pas de `SELECT *`, voir test/rules.ts). */
const COLUMNS = "id, name, width, height, data, created_at AS createdAt, views, goal, parent, likes";

function memoryStore(): Store {
  return {
    async list() {
      return kept([...memory.values()], 50).map(shown);
    },
    async get(id) {
      const world = memory.get(id);
      return world ? shown(world) : null;
    },
    async save(world) {
      memory.set(world.id, world);
    },
    async remove(id, token) {
      const world = memory.get(id);
      // Un monde d'avant les jetons (ou d'un autre visiteur) ne se supprime pas.
      if (!world || !world.token || world.token !== token) return false;
      return memory.delete(id);
    },
    async see(id) {
      const world = memory.get(id);
      if (world) world.views++;
    },
    async like(id) {
      const world = memory.get(id);
      if (!world) return null;
      world.likes = (world.likes ?? 0) + 1;
      return world.likes;
    },
    async purge(keep) {
      const alive = kept([...memory.values()], keep);
      for (const world of memory.values()) if (!alive.includes(world)) memory.delete(world.id);
    },
  };
}

function d1Store(db: D1Database): Store {
  return {
    async list() {
      const { results } = await db
        .prepare(`SELECT ${COLUMNS} FROM worlds WHERE ${KEPT} ORDER BY created_at DESC`)
        .bind(50)
        .all<World>();
      return results;
    },
    async get(id) {
      return db
        .prepare(`SELECT ${COLUMNS} FROM worlds WHERE id = ?`)
        .bind(id)
        .first<World>();
    },
    async save(world) {
      await db
        .prepare("INSERT INTO worlds (id, name, width, height, data, created_at, goal, token, parent) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
        .bind(world.id, world.name, world.width, world.height, world.data, world.createdAt, world.goal ?? null, world.token ?? null, world.parent ?? null)
        .run();
    },
    async remove(id, token) {
      // Le jeton est dans la clause, pas comparé en JS : rien à relire, et un
      // `token` NULL (monde d'avant) ne peut égaler aucune chaîne.
      const { meta } = await db.prepare("DELETE FROM worlds WHERE id = ? AND token = ?").bind(id, token).run();
      return meta.changes > 0;
    },
    async see(id) {
      await db.prepare("UPDATE worlds SET views = views + 1 WHERE id = ?").bind(id).run();
    },
    async like(id) {
      // Une seule requête : l'incrément et le nouveau total, sans lecture à part.
      const row = await db.prepare("UPDATE worlds SET likes = likes + 1 WHERE id = ? RETURNING likes").bind(id).first<{ likes: number }>();
      return row?.likes ?? null;
    },
    async purge(keep) {
      await db
        .prepare(`DELETE FROM worlds WHERE NOT (${KEPT})`)
        .bind(keep)
        .run();
    },
  };
}
