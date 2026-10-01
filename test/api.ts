/**
 * Auto-vérification de l'API : `npm run check` (Node exécute le TS tel quel).
 * Hono répond en mémoire via `app.request()` — ni serveur, ni wrangler.
 * Sans binding `DB` ni `RL`, on tape le store mémoire et rien n'est limité.
 */
import assert from "node:assert/strict";
import app from "../src/worker/app.ts";
import { PLACES, cursor, freeId, nick, roster, route, unique } from "../src/worker/relay.ts";
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

// Pseudos, numéros et curseurs du salon : ce qu'un joueur annonce n'est pas
// de confiance, et le numéro d'un curseur vient du salon, jamais de l'émetteur.
{
  assert.equal(nick("  Alice\n\u0000 la  Lapine "), "Alice la Lapine", "contrôles retirés, espaces resserrés");
  assert.equal(nick("x".repeat(100)).length, 24, "24 caractères au plus");
  assert.equal(nick("🐇".repeat(30)), "🐇".repeat(24), "comptés en caractères, pas en moitiés d'emoji");
  assert.equal(nick(null), "");
  assert.equal(unique("Alice", ["Bob"]), "Alice");
  assert.equal(unique("Alice", ["Alice", "Alice 2"]), "Alice 3", "deux joueurs ne portent pas le même pseudo");
  assert.equal(unique("x".repeat(24), ["x".repeat(24)]), "x".repeat(22) + " 2", "le suffixe tient dans les 24 caractères");
  assert.equal(unique("", [""]), "", "sans pseudo : « Joueur N », déjà distinct par son numéro");
  assert.equal(freeId([]), 1);
  assert.equal(freeId([1, 2, 4]), 3, "le plus petit numéro libre, recyclé");
  assert.equal(freeId(Array.from({ length: PLACES }, (_, i) => i + 1)), 0);

  const msg = (o: unknown): string => JSON.stringify(o);
  assert.equal(route(msg({ type: "lock", on: true }), true), "guests", "l'hôte prévient les invités du verrou");
  assert.equal(route(msg({ type: "lock", on: false }), false), null, "un invité ne se déverrouille pas lui-même");
  assert.deepEqual(JSON.parse(cursor(msg({ type: "cursor", x: 10, y: 20, id: 7 }), 3)!), { type: "cursor", id: 3, x: 10, y: 20 },
    "le numéro est celui que le salon connaît, pas celui que l'émetteur prétend");
  assert.ok(cursor(msg({ type: "cursor", x: -1, y: -1 }), 1), "hors du bac : -1, -1");
  for (const bad of [{ x: 1.5, y: 2 }, { x: -1, y: 4 }, { x: 5000, y: 0 }, { x: "3", y: 3 }, { x: 3 }]) {
    assert.equal(cursor(msg({ type: "cursor", ...bad }), 1), null, `curseur refusé : ${msg(bad)}`);
  }
  assert.equal(cursor(msg({ type: "do", g: {} }), 1), null, "un geste n'est pas un curseur");
  assert.equal(route(msg({ type: "cursor", x: 1, y: 1 }), false), null, "ni route() ni un invité ne relaient un curseur brut");
  assert.deepEqual(JSON.parse(roster([{ id: 1, name: "A", host: true }])), { type: "roster", players: [{ id: 1, name: "A", host: true }] });
}

// Remix et « J'aime ».
{
  const parent = await body<Monde>(app.request("/api/worlds", json(monde), env));
  const enfant = await app.request("/api/worlds", json({ ...monde, parent: parent.id }), env);
  assert.equal(enfant.status, 201, "un remix se sauvegarde avec son parent");
  const lu = await body<Monde & { parent: string; likes: number }>(app.request(`/api/worlds/${(await body<Monde>(enfant)).id}`, {}, env));
  assert.equal(lu.parent, parent.id, "et le garde");
  assert.equal(lu.likes, 0, "un monde neuf n'a aucun « J'aime »");
  assert.equal((await app.request("/api/worlds", json({ ...monde, parent: "../etc" }), env)).status, 400, "un parent qui n'a pas la forme d'un id est refusé");

  const vote = await app.request(`/api/worlds/${parent.id}/like`, { method: "POST" }, env);
  assert.equal(vote.status, 200);
  assert.equal((await body<{ likes: number }>(vote)).likes, 1, "le vote compte");
  assert.equal((await body<{ likes: number }>(app.request(`/api/worlds/${parent.id}/like`, { method: "POST" }, env))).likes, 2);
  assert.equal((await app.request("/api/worlds/00000000-0000-0000-0000-000000000000/like", { method: "POST" }, env)).status, 404, "pas de vote pour un monde absent");
  assert.equal((await app.request("/api/worlds/pas-un-id/like", { method: "POST" }, env)).status, 404);
  const listés = await body<{ id: string; likes: number; token?: string }[]>(app.request("/api/worlds", {}, env));
  const listé = listés.find((w) => w.id === parent.id)!;
  assert.equal(listé.likes, 2, "la galerie voit les votes");
  assert.equal(listé.token, undefined, "et toujours pas le jeton");
}

// Le ménage garde les mondes aimés, comme les mondes vus.
{
  const store = createStore(env);
  const vieux = { name: "v", width: 4, height: 4, data: "AQE=", views: 0, createdAt: "2000-01-01T00:00:00.000Z" };
  await store.save({ ...vieux, id: "adoré" });
  for (let i = 0; i < 3; i++) await store.like("adoré");
  for (let i = 0; i < 60; i++) await store.save({ ...vieux, id: `récent${i}`, createdAt: new Date(Date.now() + i).toISOString() });
  await store.purge(50);
  assert.ok(await store.get("adoré"), "le monde aimé survit au ménage");
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

// Les erreurs des joueurs vont aux journaux, avec le navigateur ; vide, trop
// lourd ou au-delà du débit, rien n'est écrit.
{
  const logged: unknown[] = [];
  const log = console.error;
  console.error = (entry: unknown) => { logged.push(entry); };
  try {
    const beacon = (report: string, e: never = env) =>
      app.request("/api/error", { method: "POST", headers: { "user-agent": "Testeur/1.0" }, body: report }, e);
    assert.equal((await beacon("page : TypeError: x is undefined")).status, 204);
    assert.deepEqual(logged, [{ message: "erreur joueur", report: "page : TypeError: x is undefined", agent: "Testeur/1.0" }]);
    assert.equal((await beacon("")).status, 400, "rapport vide refusé");
    assert.equal((await beacon("x".repeat(16 * 1024 + 1))).status, 413, "rapport trop lourd refusé");
    const saturé = { RL: { limit: async () => ({ success: false }) } } as never;
    assert.equal((await beacon("encore", saturé)).status, 429, "au-delà du débit, refusé");
    assert.equal(logged.length, 1, "seul le premier rapport est écrit");
  } finally {
    console.error = log;
  }
}

assert.equal((await app.request("/api/inconnu", {}, env)).status, 404);

console.log("ok — API conforme");
