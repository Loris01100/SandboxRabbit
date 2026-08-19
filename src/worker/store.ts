import type { Env } from "./index.ts";

export interface World {
  id: string;
  name: string;
  width: number;
  height: number;
  /** Grille encodée (RLE + base64), voir src/client/sim/codec.ts */
  data: string;
  createdAt: string;
}

export interface Store {
  /** Renvoie les grilles : la galerie en fait ses vignettes, ~1 ko par monde. */
  list(): Promise<World[]>;
  get(id: string): Promise<World | null>;
  save(world: World): Promise<void>;
  remove(id: string): Promise<void>;
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
  };
}

function d1Store(db: D1Database): Store {
  return {
    async list() {
      const { results } = await db
        .prepare("SELECT id, name, width, height, data, created_at AS createdAt FROM worlds ORDER BY created_at DESC LIMIT 50")
        .all<World>();
      return results;
    },
    async get(id) {
      return db
        .prepare("SELECT id, name, width, height, data, created_at AS createdAt FROM worlds WHERE id = ?")
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
  };
}
