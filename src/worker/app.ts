/**
 * L'API seule : aucun import de `cloudflare:workers`, pour que Node puisse la
 * charger telle quelle dans test/api.ts. L'entrée du Worker est index.ts.
 */
import { Hono, type Context } from "hono";
import { createStore, type World } from "./store.ts";

export interface Env {
  ASSETS: Fetcher;
  /** Présent une fois la base D1 créée et le binding décommenté dans wrangler.jsonc. */
  DB?: D1Database;
  /** Limite de débit Cloudflare (binding `unsafe`), absente en dev local. */
  RL?: RateLimit;
  /** Salons du bac partagé. Absent des tests en mémoire : la route répond 503. */
  ROOM?: DurableObjectNamespace;
}

/**
 * En-têtes posés sur toutes les réponses. La page ne charge rien d'ailleurs :
 * un bundle et une feuille de style de même origine, des images en `data:` (le
 * favicon) et en `blob:` (le PNG et la vidéo produits par le canvas), et une
 * websocket vers le même hôte pour le bac partagé — d'où `connect-src 'self'`.
 * `form-action` est laissé libre : le seul <form> de la page est un
 * `method="dialog"` qui ne navigue nulle part.
 */
const HEADERS: Record<string, string> = {
  "content-security-policy":
    "default-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'",
  "x-content-type-options": "nosniff",
  "referrer-policy": "strict-origin-when-cross-origin",
};

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

// Charger un monde compte une vue : c'est par ici que passe la galerie.
app.get("/api/worlds/:id", async (c) => {
  const store = createStore(c.env);
  const world = await store.get(c.req.param("id"));
  if (!world) return c.json({ error: "introuvable" }, 404);
  await store.see(world.id);
  return c.json(world);
});

/**
 * Écriture ouverte à tous (pas de compte dans ce bac) : la seule protection est
 * le débit, 20 requêtes par IP et par minute. Sans le binding — `wrangler dev`
 * local — on laisse passer.
 */
async function flooding(c: Context<{ Bindings: Env }>): Promise<boolean> {
  const key = c.req.header("cf-connecting-ip") ?? "anonyme";
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
    body.width < 1 || body.height < 1 || body.width * body.height > 1_000_000
  ) {
    return c.json({ error: "dimensions invalides" }, 400);
  }
  // Objectif facultatif : « au moins / moins de N cellules de la matière X ».
  // Validé ici, sinon la galerie afficherait n'importe quelle chaîne.
  if (body.goal != null && !/^(ge|lt):\d{1,3}:\d{1,6}$/.test(body.goal)) {
    return c.json({ error: "objectif invalide" }, 400);
  }

  const id = crypto.randomUUID();
  await createStore(c.env).save({
    id,
    name: body.name.slice(0, 60),
    width: body.width,
    height: body.height,
    data: body.data,
    createdAt: new Date().toISOString(),
    views: 0,
    goal: body.goal ?? null,
  });
  return c.json({ id }, 201);
});

app.delete("/api/worlds/:id", async (c) => {
  if (await flooding(c)) return c.json({ error: "trop de requêtes" }, 429);
  await createStore(c.env).remove(c.req.param("id"));
  return c.body(null, 204);
});

/** Bac partagé : une websocket par joueur, un Durable Object par salon. */
app.get("/api/room/:id", async (c) => {
  if (!c.env.ROOM) return c.json({ error: "bac partagé indisponible" }, 503);
  if (await flooding(c)) return c.json({ error: "trop de requêtes" }, 429);
  if (c.req.header("upgrade") !== "websocket") return c.json({ error: "websocket attendue" }, 426);
  const room = c.env.ROOM.get(c.env.ROOM.idFromName(c.req.param("id").slice(0, 60)));
  return room.fetch(c.req.raw);
});

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
