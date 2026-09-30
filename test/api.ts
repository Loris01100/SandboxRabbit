/**
 * Auto-vérification de l'API : `npm run check` (Node exécute le TS tel quel).
 * Hono répond en mémoire via `app.request()` — ni serveur, ni wrangler.
 * Sans binding `DB` ni `RL`, on tape le store mémoire et rien n'est limité.
 */
import assert from "node:assert/strict";
import app from "../src/worker/app.ts";
import { route } from "../src/worker/relay.ts";
import { createStore, type World } from "../src/worker/store.ts";

const env = {} as never;

/** Faux binding ASSETS : de quoi vérifier ce que le Worker ajoute au statique. */
const assets = {
  ASSETS: { fetch: async () => new Response("<!doctype html>", { headers: { "content-type": "text/html" } }) },
} as never;
const json = (body: unknown) => ({
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});
const monde = { name: "test", width: 4, height: 4, data: "AQE=" };

/** Un monde tel que l'API le rend (lecture) ou le crée (`id` + `token`, une seule fois). */
type Monde = { id: string; token: string; data: string; views: number; goal?: string | null };

/** Le corps JSON d'une réponse, à la forme attendue : sous les types du Worker, `json()` rend `unknown`. */
const body = async <T,>(res: Response | Promise<Response>): Promise<T> => (await (await res).json()) as T;

{
  const res = await app.request("/api/health", {}, env);
  assert.equal(res.status, 200);
  assert.equal((await body<{ storage: string }>(res)).storage, "memory", "sans binding DB, store mémoire");
}

// Corps invalide et monde trop lourd sont refusés avant d'atteindre le store.
{
  assert.equal((await app.request("/api/worlds", json({ name: "x" }), env)).status, 400);
  assert.equal((await app.request("/api/worlds", json({ ...monde, data: "x".repeat(200_001) }), env)).status, 413);
  // Des dimensions fantaisistes n'atteignent pas la galerie, qui allouerait `width * height`.
  assert.equal((await app.request("/api/worlds", json({ ...monde, width: 1e6, height: 1e6 }), env)).status, 400);
  assert.equal((await app.request("/api/worlds", json({ ...monde, width: 0 }), env)).status, 400);
  assert.equal((await app.request("/api/worlds", json({ ...monde, height: 12.5 }), env)).status, 400);
  assert.equal((await app.request("/api/worlds", json({ ...monde, width: 1920, height: 1080 }), env)).status, 201, "la plus grande grille du menu passe");
  assert.equal((await app.request("/api/worlds", json({ ...monde, width: 1921, height: 1080 }), env)).status, 400, "au-delà, non");
}

// Aller-retour complet : sauvegarde, liste, suppression.
{
  const created = await app.request("/api/worlds", json(monde), env);
  assert.equal(created.status, 201);
  const { id, token } = await body<Monde>(created);
  assert.ok(token, "la sauvegarde rend le jeton de suppression, une seule fois");
  const mien = { method: "DELETE", headers: { "x-world-token": token } };

  const list = await body<Monde[]>(app.request("/api/worlds", {}, env));
  const found = list.find((w) => w.id === id)!;
  assert.ok(found, "le monde sauvegardé apparaît dans la liste");
  assert.equal(found.data, monde.data, "la liste porte la grille : la galerie n'a qu'une requête à faire");

  // …mais seulement le bloc matière : la vignette n'a que faire des vies et des
  // températures, qui pèsent un cinquième d'un monde en feu.
  {
    const vivant = { ...monde, data: "AQE=.AQE=.AQE=.AQE=" };
    const { id: chaud, token: sien } = await body<Monde>(app.request("/api/worlds", json(vivant), env));
    const liste = await body<Monde[]>(app.request("/api/worlds", {}, env));
    assert.equal(liste.find((w) => w.id === chaud)!.data, "AQE=", "la liste s'arrête au premier bloc");
    const entier = await body<Monde>(app.request(`/api/worlds/${chaud}`, {}, env));
    assert.equal(entier.data, vivant.data, "le monde entier, lui, garde son état vivant");
    await app.request(`/api/worlds/${chaud}`, { method: "DELETE", headers: { "x-world-token": sien } }, env);
  }

  // Charger un monde compte une vue ; la liste la porte, c'est ce qui trie la galerie.
  assert.equal(found.views, 0, "un monde neuf n'a pas de vue");
  await app.request(`/api/worlds/${id}`, {}, env);
  await app.request(`/api/worlds/${id}`, {}, env);
  const seen = await body<Monde[]>(app.request("/api/worlds", {}, env));
  assert.equal(seen.find((w) => w.id === id)!.views, 2, "deux chargements, deux vues");
  assert.equal(seen.find((w) => w.id === id)!.token, undefined, "le jeton ne ressort jamais de la lecture");
  assert.equal((await app.request(`/api/worlds/${id}`, {}, env)).status, 200);
  assert.equal(((await (await app.request(`/api/worlds/${id}`, {}, env)).json()) as { token?: string }).token, undefined, "ni du monde entier");

  // Sans jeton, ou avec un faux : le monde reste. C'est tout ce qui protège la galerie.
  assert.equal((await app.request(`/api/worlds/${id}`, { method: "DELETE" }, env)).status, 403);
  assert.equal((await app.request(`/api/worlds/${id}`, { method: "DELETE", headers: { "x-world-token": "faux" } }, env)).status, 403);
  assert.ok(await (await app.request(`/api/worlds/${id}`, {}, env)).json(), "toujours là après deux tentatives");

  assert.equal((await app.request(`/api/worlds/${id}`, mien, env)).status, 204);
  const after = await body<Monde[]>(app.request("/api/worlds", {}, env));
  assert.equal(after.find((w) => w.id === id), undefined, "supprimé de la liste");
  assert.equal((await app.request(`/api/worlds/${id}`, {}, env)).status, 404);
}

// Un objectif mal formé est refusé ; bien formé, il revient avec le monde.
{
  assert.equal((await app.request("/api/worlds", json({ ...monde, goal: "gagne !" }), env)).status, 400);
  const { id, token } = await body<Monde>(app.request("/api/worlds", json({ ...monde, name: "défi", goal: "ge:12:600" }), env));
  const world = await body<Monde>(app.request(`/api/worlds/${id}`, {}, env));
  assert.equal(world.goal, "ge:12:600", "l'objectif voyage avec le monde");
  await app.request(`/api/worlds/${id}`, { method: "DELETE", headers: { "x-world-token": token } }, env);
}

// Au-delà du débit, un monde se charge encore mais ne gagne plus de vue : une
// boucle de GET ne le hisse pas en tête des plus vus.
{
  const { id } = await body<Monde>(app.request("/api/worlds", json(monde), env));
  const saturé = { RL: { limit: async () => ({ success: false }) } } as never;
  assert.equal((await app.request(`/api/worlds/${id}`, {}, saturé)).status, 200, "servi malgré le débit");
  assert.equal((await body<Monde>(app.request(`/api/worlds/${id}`, {}, saturé))).views, 0, "sans vue comptée");
}

// Le ménage garde les plus récents et les plus vus : 50 sauvegardes vides ne
// poussent plus dehors un monde que les joueurs chargent.
{
  const store = createStore(env);
  const vieux = (id: string, views: number): World =>
    ({ id, name: id, width: 4, height: 4, data: "AQE=", createdAt: "2000-01-01T00:00:00.000Z", views });
  await store.save(vieux("aimé", 7));
  await store.save(vieux("oublié", 0));
  for (let i = 0; i < 50; i++) await store.save({ ...vieux(`spam${i}`, 0), createdAt: new Date().toISOString() });
  const montrés = (await store.list()).map((w) => w.id);
  assert.ok(montrés.includes("aimé"), "la galerie montre encore le monde vu");
  assert.ok(!montrés.includes("oublié"), "pas le vieux monde jamais vu");
  await store.purge(50);
  assert.ok(await store.get("aimé"), "le ménage garde le monde vu");
  assert.equal(await store.get("oublié"), null, "et efface l'autre");
}

// Le salon ne relaie plus à l'aveugle : l'hôte ne diffuse que sa partie, un
// invité ne parle qu'à l'hôte, par gestes ou pour redemander un départ.
// `role` et `peers` ne viennent que du salon — un invité qui les imitait
// destituait l'hôte.
{
  const msg = (o: unknown): string => JSON.stringify(o);
  const départ = msg({ type: "start", rec: { w: 320, h: 180 } });
  const suite = msg({ type: "turn", ticks: 3, beats: [], sums: [] });
  assert.equal(route(msg({ type: "do", g: { t: "fill", x: 1, y: 1, id: 1 } }), false), "host", "le geste d'un invité va à l'hôte");
  assert.equal(route(msg({ type: "sync" }), false), "host", "sa demande de repartir aussi");
  assert.equal(route(départ, true), "guests", "le départ de l'hôte va aux invités");
  assert.equal(route(suite, true), "guests", "et la suite de sa partie");
  assert.equal(route(msg({ type: "sync" }), true), null, "l'hôte n'a rien à redemander");
  assert.equal(route(msg({ type: "role", host: false }), false), null, "un invité ne destitue pas l'hôte");
  assert.equal(route(msg({ type: "peers", n: 1 }), false), null, "ni ne le fait taire");
  assert.equal(route(départ, false), null, "ni n'impose sa grille aux autres invités");
  assert.equal(route(suite, false), null, "ni sa partie");
  assert.equal(route(msg({ type: "role", host: true }), true), null, "l'hôte non plus ne distribue pas les rôles");
  assert.equal(route(msg({ type: "do", g: {} }), true), null, "ni n'envoie de gestes");
  assert.equal(route("pas du json", false), null);
  assert.equal(route("null", false), null);
  assert.equal(route(msg({ type: "do", g: "x".repeat(200_001) }), false), null, "plafonné à la taille d'un monde");
  assert.equal(route(new ArrayBuffer(4), false), null, "rien que du texte");
}

// Sans binding Durable Object (tests, `vite dev`), le bac partagé se dit indisponible.
assert.equal((await app.request("/api/room/public", {}, env)).status, 503);

// En-têtes de sécurité partout, et cache éternel pour les seuls fichiers hashés.
{
  const api = await app.request("/api/health", {}, env);
  assert.match(api.headers.get("content-security-policy") ?? "", /default-src 'self'/, "CSP sur l'API");
  assert.equal(api.headers.get("x-content-type-options"), "nosniff");

  const page = await app.request("/", {}, assets);
  assert.equal(page.status, 200, "la page passe par le fallback ASSETS");
  assert.equal(page.headers.get("cache-control"), "no-cache", "le HTML est revérifié à chaque visite");
  assert.match(page.headers.get("content-security-policy") ?? "", /frame-ancestors 'none'/);
  assert.equal(page.headers.get("cross-origin-opener-policy"), "same-origin", "COOP : la page isolée, condition de la mémoire partagée");
  assert.equal(page.headers.get("cross-origin-embedder-policy"), "require-corp", "COEP : sans lui, le moteur reste sur un seul fil");

  const file = await app.request("/assets/index-abc123.js", {}, assets);
  assert.match(file.headers.get("cache-control") ?? "", /immutable/, "un fichier hashé se garde un an");
}

assert.equal((await app.request("/api/inconnu", {}, env)).status, 404);

console.log("ok — API conforme");
