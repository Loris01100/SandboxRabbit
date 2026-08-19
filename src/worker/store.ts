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
}

export interface Store {
  /** Renvoie les grilles : la galerie en fait ses vignettes, ~1 ko par monde. */
  list(): Promise<World[]>;
  get(id: string): Promise<World | null>;
  save(world: World): Promise<void>;
  remove(id: string): Promise<void>;
  /** Ne garde que les `keep` mondes les plus récents (ménage nocturne). */
  purge(keep: number): Promise<void>;
  /** Compte un chargement. Appelé par `GET /api/worlds/:id`, seul chemin de chargement. */
  see(id: string): Promise<void>;
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

function memoryStore(): Store {
  return {
    async list() {
      return [...memory.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    },
    async get(id) {
      return memory.get(id) ?? null;
    },
    async save(world) {
      memory.set(world.id, world);
    },
    async remove(id) {
      memory.delete(id);
    },
    async see(id) {
      const world = memory.get(id);
      if (world) world.views++;
    },
    async purge(keep) {
      const old = [...memory.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(keep);
      for (const world of old) memory.delete(world.id);
    },
  };
}

function d1Store(db: D1Database): Store {
  return {
    async list() {
      const { results } = await db
        .prepare("SELECT id, name, width, height, data, created_at AS createdAt, views FROM worlds ORDER BY created_at DESC LIMIT 50")
        .all<World>();
      return results;
    },
    async get(id) {
      return db
        .prepare("SELECT id, name, width, height, data, created_at AS createdAt, views FROM worlds WHERE id = ?")
        .bind(id)
        .first<World>();
    },
    async save(world) {
      await db
        .prepare("INSERT INTO worlds (id, name, width, height, data, created_at) VALUES (?, ?, ?, ?, ?, ?)")
        .bind(world.id, world.name, world.width, world.height, world.data, world.createdAt)
        .run();
    },
    async remove(id) {
      await db.prepare("DELETE FROM worlds WHERE id = ?").bind(id).run();
    },
    async see(id) {
      await db.prepare("UPDATE worlds SET views = views + 1 WHERE id = ?").bind(id).run();
    },
    async purge(keep) {
      await db
        .prepare("DELETE FROM worlds WHERE id NOT IN (SELECT id FROM worlds ORDER BY created_at DESC LIMIT ?)")
        .bind(keep)
        .run();
    },
  };
}
