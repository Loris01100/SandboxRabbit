/**
 * L'API seule : aucun import de `cloudflare:workers`, pour que Node puisse la
 * charger telle quelle dans test/api.ts. L'entrée du Worker est index.ts.
 */
import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { createStore, type World } from "./store.ts";
import { nick } from "./relay.ts";

export interface Env {
  ASSETS: Fetcher;
  /** Présent une fois la base D1 créée et le binding décommenté dans wrangler.jsonc. */
  DB?: D1Database;
  /** Limite de débit Cloudflare (binding `unsafe`), absente en dev local. */
  RL?: RateLimit;
  /** Salons du bac partagé. Absent des tests en mémoire : la route répond 503. */
  ROOM?: DurableObjectNamespace;
  /**
   * Sel des empreintes de votants et de visiteurs (`who()`), un secret :
   * `npx wrangler secret put SALT`. Sans lui, un sel fixe — les empreintes
   * restent distinctes par monde, mais une IP se retrouverait en essayant
   * toutes les adresses.
   */
  SALT?: string;
}

/**
 * En-têtes posés sur toutes les réponses. La page ne charge rien d'ailleurs :
 * un bundle et une feuille de style de même origine, des images en `data:` (le
 * favicon) et en `blob:` (le PNG et la vidéo produits par le canvas), et une
 * websocket vers le même hôte pour le bac partagé — d'où `connect-src 'self'`.
 * `form-action` est laissé libre : le seul <form> de la page est un
 * `method="dialog"` qui ne navigue nulle part.
 *
 * COOP + COEP isolent la page (`crossOriginIsolated`) : c'est la condition de
 * `SharedArrayBuffer`, donc du moteur sur plusieurs fils (sim/pool.ts). Rien
 * ne vient d'une autre origine, `require-corp` ne bloque donc rien. Aussi posés
 * par Vite en développement (vite.config.ts).
 */
const HEADERS: Record<string, string> = {
  "content-security-policy":
    "default-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'",
  "x-content-type-options": "nosniff",
  "referrer-policy": "strict-origin-when-cross-origin",
  "cross-origin-opener-policy": "same-origin",
  "cross-origin-embedder-policy": "require-corp",
};

/**
 * Cellules d'un monde au plus : la plus grande grille du menu, 1920×1080. La
 * galerie alloue `width * height` octets pour la vignette : sans plafond, des
 * dimensions fantaisistes la feraient tomber.
 */
const CELLS = 1920 * 1080;

/**
 * Qui vote ou regarde, sans garder son IP : les 16 premiers octets d'un
 * SHA-256 du sel, du monde et de l'IP. Le monde y entre pour qu'on ne puisse
 * pas suivre un même visiteur d'un monde à l'autre dans les tables.
 */
async function who(c: Context<{ Bindings: Env }>, world: string): Promise<string> {
  const ip = c.req.header("cf-connecting-ip") ?? "anonyme";
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${c.env.SALT ?? "sandbox-rabbit"}:${world}:${ip}`));
  return [...new Uint8Array(digest).slice(0, 16)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Forme d'un `id` de monde (`crypto.randomUUID()`). */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const app = new Hono<{ Bindings: Env }>();

app.use("*", async (c, next) => {
  await next();
  // Une réponse 101 passe la main à la websocket : ses en-têtes ne se touchent plus.
  if (c.res.status === 101) return;
  for (const [name, value] of Object.entries(HEADERS)) c.res.headers.set(name, value);
});

app.get("/api/health", (c) =>
  c.json({
    ok: true,
    storage: c.env.DB ? "d1" : "memory",
    now: new Date().toISOString(),
  }),
);

/**
 * La galerie fait ses vignettes avec ce que renvoie cette route : elle n'a
 * besoin que de la matière, pas de l'état vivant. On coupe donc `data` à son
 * premier bloc (voir le codec) — sur cinquante mondes en feu, c'est un cinquième
 * de la réponse en moins, jeté à l'arrivée sinon. Le monde entier s'obtient par
 * `/api/worlds/:id`, par lequel passe déjà tout chargement.
 */
app.get("/api/worlds", async (c) => {
  const worlds = await createStore(c.env).list();
  return c.json(worlds.map((w) => ({ ...w, data: w.data.split(".")[0] })));
});

// Charger un monde compte une vue : c'est par ici que passe la galerie. Les
// vues gardent un monde au ménage nocturne : sans débit, une boucle de GET en
// hissait n'importe lequel en tête, une écriture D1 par requête. Au-delà du
// débit, le monde est servi quand même, sans vue.
app.get("/api/worlds/:id", async (c) => {
  const store = createStore(c.env);
  const world = await store.get(c.req.param("id"));
  if (!world) return c.json({ error: "introuvable" }, 404);
  if (!(await flooding(c, "vue:"))) await store.see(world.id, await who(c, world.id));
  return c.json(world);
});

/**
 * Écriture ouverte à tous (pas de compte dans ce bac) : la seule protection est
 * le débit, 20 requêtes par IP et par minute. Sans le binding — `wrangler dev`
 * local — on laisse passer. `counter` sépare les compteurs : parcourir la
 * galerie ne doit pas empêcher de sauvegarder.
 */
async function flooding(c: Context<{ Bindings: Env }>, counter = ""): Promise<boolean> {
  const key = counter + (c.req.header("cf-connecting-ip") ?? "anonyme");
  return c.env.RL ? !(await c.env.RL.limit({ key })).success : false;
}

app.post("/api/worlds", async (c) => {
  if (await flooding(c)) return c.json({ error: "trop de requêtes" }, 429);
  const body = await c.req.json<Partial<World>>().catch(() => null);
  if (
    !body ||
    typeof body.name !== "string" ||
    typeof body.data !== "string" ||
    typeof body.width !== "number" ||
    typeof body.height !== "number"
  ) {
    return c.json({ error: "corps invalide" }, 400);
  }
  if (body.data.length > 200_000) return c.json({ error: "monde trop lourd" }, 413);
  // Des dimensions fantaisistes passeraient jusqu'à la galerie, qui allouerait
  // `width * height` octets pour en faire une vignette.
  if (
    !Number.isInteger(body.width) || !Number.isInteger(body.height) ||
    body.width < 1 || body.height < 1 || body.width * body.height > CELLS
  ) {
    return c.json({ error: "dimensions invalides" }, 400);
  }
  // Objectif facultatif : « au moins / moins de N cellules de la matière X ».
  // Validé ici, sinon la galerie afficherait n'importe quelle chaîne.
  if (body.goal != null && !/^(ge|lt):\d{1,3}:\d{1,6}$/.test(body.goal)) {
    return c.json({ error: "objectif invalide" }, 400);
  }
  // Remix : l'`id` du monde dont celui-ci est repris. Sa forme seulement — le
  // parent peut disparaître au ménage suivant, la galerie le dit alors.
  if (body.parent != null && !(typeof body.parent === "string" && UUID.test(body.parent))) {
    return c.json({ error: "parent invalide" }, 400);
  }

  const id = crypto.randomUUID();
  // Le jeton de suppression est tiré ici, pas envoyé par le client : c'est la
  // seule preuve qu'on est bien le déposant, elle ne se devine pas.
  const token = crypto.randomUUID();
  await createStore(c.env).save({
    id,
    name: body.name.slice(0, 60),
    width: body.width,
    height: body.height,
    data: body.data,
    createdAt: new Date().toISOString(),
    views: 0,
    goal: body.goal ?? null,
    parent: body.parent ?? null,
    likes: 0,
    token,
  });
  // Rendu une seule fois : aucune route de lecture ne le renvoie ensuite.
  return c.json({ id, token }, 201);
});

// Supprimer demande le jeton reçu à la sauvegarde. Sans lui la galerie était
// ouverte au vent : un seul visiteur pouvait la vider.
app.delete("/api/worlds/:id", async (c) => {
  if (await flooding(c)) return c.json({ error: "trop de requêtes" }, 429);
  const token = c.req.header("x-world-token") ?? "";
  const gone = await createStore(c.env).remove(c.req.param("id"), token);
  if (!gone) return c.json({ error: "pas votre monde" }, 403);
  return c.body(null, 204);
});

/**
 * « J'aime » : un vote par IP et par monde, sans compte (`who()`, table
 * `votes`) ; revoter rend le même total. Le débit a son compteur (20 par
 * minute et par IP), sinon voter empêchait de sauvegarder.
 */
app.post("/api/worlds/:id/like", async (c) => {
  if (await flooding(c, "vote:")) return c.json({ error: "trop de requêtes" }, 429);
  const id = c.req.param("id");
  if (!UUID.test(id)) return c.json({ error: "introuvable" }, 404);
  const likes = await createStore(c.env).like(id, await who(c, id));
  if (likes === null) return c.json({ error: "introuvable" }, 404);
  return c.json({ likes });
});

/**
 * Les défis qui ont un classement : ceux livrés avec le jeu, par leur nom
 * (`CHALLENGES` de src/client/challenges.ts, que le Worker n'importe pas — il
 * tirerait le moteur avec lui). test/api.ts vérifie que les deux listes
 * coïncident. Un monde-défi de la galerie n'en a pas : sa grille n'est pas
 * bâtie en code, le juge n'aurait rien à quoi comparer le départ du rejeu.
 */
export const TRIALS = [
  "Débâcle", "Mèche lente", "Court-circuit", "Puits", "Désamorçage", "Coup de grisou", "Jardin", "Coffrage", "Ferraille", "Grand froid",
];
/** Ticks au plus d'un record : `TRIAL_TICKS` de src/client/replay.ts (cinq minutes), que test/api.ts compare. */
export const TRIAL_TICKS = 5 * 60 * 60;
/** Poids au plus d'un rejeu compressé, en caractères : celui d'un monde. */
const FILM_CHARS = 200_000;

/**
 * Le classement d'un défi : les meilleurs records, **rejeux compris** — la
 * page les rejoue tous pour n'afficher que ceux qui tiennent (sim/verdict.ts).
 * Rien n'y est vérifié ici : rejouer une partie coûterait des secondes de
 * calcul par record.
 */
app.get("/api/records/:challenge", async (c) => {
  const challenge = c.req.param("challenge");
  if (!TRIALS.includes(challenge)) return c.json({ error: "défi inconnu" }, 404);
  return c.json(await createStore(c.env).board(challenge));
});

/**
 * Déposer un record : son défi, un pseudo, la durée en ticks et le rejeu
 * compressé. Le Worker ne lit pas le rejeu (il faudrait le décompresser et le
 * rejouer) : il en vérifie la forme, et le juge de chaque visiteur fait le
 * reste. Débit à part (`record:`), 20 par minute et par IP.
 *
 * ponytail: un faux record (un rejeu qui ne gagne pas) entre au classement et
 * en chasse un vrai ; la page l'écarte, mais `BOARD` faux records déposés
 * vident le classement de tous ses visiteurs jusqu'au ménage. Juger côté
 * Worker (offre payante : ~9 s de calcul pour cinq minutes de partie) le jour
 * où un tricheur s'y met.
 */
app.post("/api/records", async (c) => {
  if (await flooding(c, "record:")) return c.json({ error: "trop de requêtes" }, 429);
  const body = await c.req.json<{ challenge?: unknown; name?: unknown; ticks?: unknown; film?: unknown }>().catch(() => null);
  if (!body || typeof body.challenge !== "string" || !TRIALS.includes(body.challenge)) {
    return c.json({ error: "défi inconnu" }, 400);
  }
  if (typeof body.ticks !== "number" || !Number.isInteger(body.ticks) || body.ticks < 1 || body.ticks > TRIAL_TICKS) {
    return c.json({ error: "durée invalide" }, 400);
  }
  if (typeof body.film !== "string" || !/^[\w-]+$/.test(body.film)) return c.json({ error: "rejeu invalide" }, 400);
  if (body.film.length > FILM_CHARS) return c.json({ error: "rejeu trop lourd" }, 413);
  const id = crypto.randomUUID();
  await createStore(c.env).enter({
    id,
    challenge: body.challenge,
    name: nick(body.name) || "Anonyme",
    ticks: body.ticks,
    film: body.film,
    createdAt: new Date().toISOString(),
  });
  return c.json({ id }, 201);
});

/** Bac partagé : une websocket par joueur, un Durable Object par salon. */
app.get("/api/room/:id", async (c) => {
  if (!c.env.ROOM) return c.json({ error: "bac partagé indisponible" }, 503);
  if (await flooding(c)) return c.json({ error: "trop de requêtes" }, 429);
  if (c.req.header("upgrade") !== "websocket") return c.json({ error: "websocket attendue" }, 426);
  const room = c.env.ROOM.get(c.env.ROOM.idFromName(c.req.param("id").slice(0, 60)));
  return room.fetch(c.req.raw);
});

/**
 * Les erreurs des joueurs (src/client/errors.ts), écrites dans les journaux du
 * Worker : `observability` (wrangler.jsonc) les garde, cherchables dans le
 * tableau de bord, et `wrangler tail` les montre en direct. Rien en base. Un
 * objet plutôt qu'une chaîne : ses champs deviennent des filtres. Le débit a
 * son compteur, sinon une page qui boucle sur une erreur empêchait son joueur
 * de sauvegarder ; `bodyLimit` coupe un corps trop gros avant de le lire, la
 * route étant ouverte à tous. 16 Kio : les 4 000 caractères d'un rapport, en
 * UTF-8, au pire.
 */
app.post(
  "/api/error",
  bodyLimit({ maxSize: 16 * 1024, onError: (c) => c.json({ error: "rapport trop lourd" }, 413) }),
  async (c) => {
    if (await flooding(c, "erreur:")) return c.json({ error: "trop de requêtes" }, 429);
    const report = await c.req.text();
    if (!report) return c.json({ error: "rapport vide" }, 400);
    console.error({ message: "erreur joueur", report, agent: (c.req.header("user-agent") ?? "").slice(0, 200) });
    return c.body(null, 204);
  },
);

app.all("/api/*", (c) => c.json({ error: "route inconnue" }, 404));

// Tout le reste est servi par les assets statiques (build Vite).
app.get("*", async (c) => {
  const asset = await c.env.ASSETS.fetch(c.req.raw);
  // Les en-têtes d'ASSETS sont figés : on recopie la réponse telle quelle
  // (corps compris, encodage inclus) pour pouvoir y ajouter les nôtres.
  const res = new Response(asset.body, asset);
  // Les fichiers de /assets portent un hash dans leur nom : ils ne changent
  // jamais. Le HTML, lui, doit être revérifié à chaque visite, sinon un
  // déploiement met une journée à se voir.
  res.headers.set(
    "cache-control",
    new URL(c.req.url).pathname.startsWith("/assets/") ? "public, max-age=31536000, immutable" : "no-cache",
  );
  return res;
});

export default app;
