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

const app = new Hono<{ Bindings: Env }>();

app.get("/api/health", (c) =>
  c.json({
    ok: true,
    storage: c.env.DB ? "d1" : "memory",
    now: new Date().toISOString(),
  }),
);

app.get("/api/worlds", async (c) => c.json(await createStore(c.env).list()));

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
app.get("*", (c) => c.env.ASSETS.fetch(c.req.raw));

export default app;
