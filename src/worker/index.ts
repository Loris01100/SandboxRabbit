import { Hono, type Context } from "hono";
import { createStore, type World } from "./store.ts";

export interface Env {
  ASSETS: Fetcher;
  /** Présent une fois la base D1 créée et le binding décommenté dans wrangler.jsonc. */
  DB?: D1Database;
  /** Limite de débit Cloudflare (binding `unsafe`), absente en dev local. */
  RL?: RateLimit;
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

app.get("/api/worlds/:id", async (c) => {
  const world = await createStore(c.env).get(c.req.param("id"));
  return world ? c.json(world) : c.json({ error: "introuvable" }, 404);
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

  const id = crypto.randomUUID();
  await createStore(c.env).save({
    id,
    name: body.name.slice(0, 60),
    width: body.width,
    height: body.height,
    data: body.data,
    createdAt: new Date().toISOString(),
  });
  return c.json({ id }, 201);
});

app.delete("/api/worlds/:id", async (c) => {
  if (await flooding(c)) return c.json({ error: "trop de requêtes" }, 429);
  await createStore(c.env).remove(c.req.param("id"));
  return c.body(null, 204);
});

app.all("/api/*", (c) => c.json({ error: "route inconnue" }, 404));

// Tout le reste est servi par les assets statiques (build Vite).
app.get("*", (c) => c.env.ASSETS.fetch(c.req.raw));

export default app;
