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

/** Un record du classement d'un défi livré. */
export interface Entry {
  id: string;
  /** Le nom du défi (`CHALLENGES` de src/client/challenges.ts, `TRIALS` d'app.ts). */
  challenge: string;
  /** Le pseudo de qui l'a fait, nettoyé comme au salon (`nick()`). */
  name: string;
  /** Durée annoncée, en ticks de simulation (60 par seconde). */
  ticks: number;
  /** Le rejeu, compressé (`pack()` de src/client/replay.ts) : c'est lui la preuve, que chaque visiteur rejoue. */
  film: string;
  createdAt: string;
}

/**
 * Records gardés par défi, servis tous : la page en rejoue jusqu'à en avoir
 * dix qui tiennent. Plus que dix pour qu'une poignée de faux records déposés
 * en tête ne chasse pas les vrais du classement.
 */
export const BOARD = 30;

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
  /**
   * Compte un chargement, une fois par visiteur (`viewer`, l'empreinte que
   * `who()` d'app.ts tire de son IP). Appelé par `GET /api/worlds/:id`, seul
   * chemin de chargement.
   */
  see(id: string, viewer: string): Promise<void>;
  /** Compte un « J'aime », une fois par votant ; rend le total, ou null si le monde n'existe pas. */
  like(id: string, voter: string): Promise<number | null>;
  /** Les `BOARD` meilleurs records d'un défi, du plus court au plus long (à égalité, le premier déposé). */
  board(challenge: string): Promise<Entry[]>;
  enter(entry: Entry): Promise<void>;
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
/** Les votes et les vues déjà comptés, `monde|empreinte` (tables `votes` et `sightings` en D1). */
const voted = new Set<string>();
const sighted = new Set<string>();
const entries: Entry[] = [];

/** L'ordre du classement : le moins de ticks, puis le plus ancien. */
const faster = (a: Entry, b: Entry): number => a.ticks - b.ticks || a.createdAt.localeCompare(b.createdAt);

/**
 * Mondes gardés, et montrés par la galerie : les `keep` plus récents, les
 * `keep` plus vus **et** les `keep` plus aimés. Avec les seuls récents, 50 sauvegardes vides (deux minutes
 * et demie au débit permis) poussaient tous les autres mondes dehors, et le
 * ménage nocturne les effaçait.
 * Une vue et un vote comptent une fois par IP et par monde (`see()`,
 * `like()`) : une seule machine ne hisse plus un monde en tête.
 *
 * ponytail: un spammeur à plusieurs IP le peut encore — une vue par adresse.
 * Un compte ou un Turnstile le jour où ça arrive.
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
    list() {
      return Promise.resolve(kept([...memory.values()], 50).map(shown));
    },
    get(id) {
      const world = memory.get(id);
      return Promise.resolve(world ? shown(world) : null);
    },
    save(world) {
      memory.set(world.id, world);
      return Promise.resolve();
    },
    remove(id, token) {
      const world = memory.get(id);
      // Un monde d'avant les jetons (ou d'un autre visiteur) ne se supprime pas.
      if (!world || !world.token || world.token !== token) return Promise.resolve(false);
      return Promise.resolve(memory.delete(id));
    },
    see(id, viewer) {
      const world = memory.get(id);
      if (!world || sighted.has(`${id}|${viewer}`)) return Promise.resolve();
      sighted.add(`${id}|${viewer}`);
      world.views++;
      return Promise.resolve();
    },
    like(id, voter) {
      const world = memory.get(id);
      if (!world) return Promise.resolve(null);
      if (!voted.has(`${id}|${voter}`)) {
        voted.add(`${id}|${voter}`);
        world.likes = (world.likes ?? 0) + 1;
      }
      return Promise.resolve(world.likes ?? 0);
    },
    purge(keep) {
      const alive = kept([...memory.values()], keep);
      for (const world of memory.values()) if (!alive.includes(world)) memory.delete(world.id);
      for (const set of [voted, sighted]) for (const key of set) if (!memory.has(key.split("|")[0])) set.delete(key);
      const best = new Set<Entry>();
      for (const name of new Set(entries.map((e) => e.challenge))) {
        for (const e of entries.filter((x) => x.challenge === name).sort(faster).slice(0, BOARD)) best.add(e);
      }
      for (let i = entries.length - 1; i >= 0; i--) if (!best.has(entries[i])) entries.splice(i, 1);
      return Promise.resolve();
    },
    board(challenge) {
      return Promise.resolve(entries.filter((e) => e.challenge === challenge).sort(faster).slice(0, BOARD));
    },
    enter(entry) {
      entries.push(entry);
      return Promise.resolve();
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
    get(id) {
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
    // Les deux en un lot (une transaction, dans l'ordre) : `changes()` vaut 1 si
    // l'empreinte vient d'entrer, 0 si elle y était — l'incrément ne compte
    // donc que la première fois, sans lecture à part. Un monde absent n'a pas
    // de ligne à mettre à jour ; sa ligne de vote orpheline part au ménage.
    async see(id, viewer) {
      await db.batch([
        db.prepare("INSERT OR IGNORE INTO sightings (world, viewer) VALUES (?, ?)").bind(id, viewer),
        db.prepare("UPDATE worlds SET views = views + changes() WHERE id = ?").bind(id),
      ]);
    },
    async like(id, voter) {
      const [, update] = await db.batch<{ likes: number }>([
        db.prepare("INSERT OR IGNORE INTO votes (world, voter) VALUES (?, ?)").bind(id, voter),
        db.prepare("UPDATE worlds SET likes = likes + changes() WHERE id = ? RETURNING likes").bind(id),
      ]);
      return update.results[0]?.likes ?? null;
    },
    async purge(keep) {
      await db.batch([
        db.prepare(`DELETE FROM worlds WHERE NOT (${KEPT})`).bind(keep),
        db.prepare("DELETE FROM votes WHERE world NOT IN (SELECT id FROM worlds)"),
        db.prepare("DELETE FROM sightings WHERE world NOT IN (SELECT id FROM worlds)"),
        db.prepare(
          "DELETE FROM records WHERE id NOT IN (SELECT id FROM (SELECT id, ROW_NUMBER() OVER (PARTITION BY challenge ORDER BY ticks, created_at) AS rank FROM records) WHERE rank <= ?)",
        ).bind(BOARD),
      ]);
    },
    async board(challenge) {
      const { results } = await db
        .prepare("SELECT id, challenge, name, ticks, film, created_at AS createdAt FROM records WHERE challenge = ? ORDER BY ticks, created_at LIMIT ?")
        .bind(challenge, BOARD)
        .all<Entry>();
      return results;
    },
    async enter(entry) {
      await db
        .prepare("INSERT INTO records (id, challenge, name, ticks, film, created_at) VALUES (?, ?, ?, ?, ?, ?)")
        .bind(entry.id, entry.challenge, entry.name, entry.ticks, entry.film, entry.createdAt)
        .run();
    },
  };
}
