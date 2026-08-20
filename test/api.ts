/**
 * Auto-vérification de l'API : `npm run check` (Node exécute le TS tel quel).
 * Hono répond en mémoire via `app.request()` — ni serveur, ni wrangler.
 * Sans binding `DB` ni `RL`, on tape le store mémoire et rien n'est limité.
 */
import assert from "node:assert/strict";
import app from "../src/worker/app.ts";

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

{
  const res = await app.request("/api/health", {}, env);
  assert.equal(res.status, 200);
  assert.equal((await res.json()).storage, "memory", "sans binding DB, store mémoire");
}

// Corps invalide et monde trop lourd sont refusés avant d'atteindre le store.
{
  assert.equal((await app.request("/api/worlds", json({ name: "x" }), env)).status, 400);
  assert.equal((await app.request("/api/worlds", json({ ...monde, data: "x".repeat(200_001) }), env)).status, 413);
  // Des dimensions fantaisistes n'atteignent pas la galerie, qui allouerait `width * height`.
  assert.equal((await app.request("/api/worlds", json({ ...monde, width: 1e6, height: 1e6 }), env)).status, 400);
  assert.equal((await app.request("/api/worlds", json({ ...monde, width: 0 }), env)).status, 400);
  assert.equal((await app.request("/api/worlds", json({ ...monde, height: 12.5 }), env)).status, 400);
}

// Aller-retour complet : sauvegarde, liste, suppression.
{
  const created = await app.request("/api/worlds", json(monde), env);
  assert.equal(created.status, 201);
  const { id, token } = await created.json();
  assert.ok(token, "la sauvegarde rend le jeton de suppression, une seule fois");
  const mien = { method: "DELETE", headers: { "x-world-token": token } };

  const list = await (await app.request("/api/worlds", {}, env)).json();
  const found = list.find((w: { id: string }) => w.id === id);
  assert.ok(found, "le monde sauvegardé apparaît dans la liste");
  assert.equal(found.data, monde.data, "la liste porte la grille : la galerie n'a qu'une requête à faire");

  // …mais seulement le bloc matière : la vignette n'a que faire des vies et des
  // températures, qui pèsent un cinquième d'un monde en feu.
  {
    const vivant = { ...monde, data: "AQE=.AQE=.AQE=.AQE=" };
    const { id: chaud, token: sien } = await (await app.request("/api/worlds", json(vivant), env)).json();
    const liste = await (await app.request("/api/worlds", {}, env)).json();
    assert.equal(liste.find((w: { id: string }) => w.id === chaud).data, "AQE=", "la liste s'arrête au premier bloc");
    const entier = await (await app.request(`/api/worlds/${chaud}`, {}, env)).json();
    assert.equal(entier.data, vivant.data, "le monde entier, lui, garde son état vivant");
    await app.request(`/api/worlds/${chaud}`, { method: "DELETE", headers: { "x-world-token": sien } }, env);
  }

  // Charger un monde compte une vue ; la liste la porte, c'est ce qui trie la galerie.
  assert.equal(found.views, 0, "un monde neuf n'a pas de vue");
  await app.request(`/api/worlds/${id}`, {}, env);
  await app.request(`/api/worlds/${id}`, {}, env);
  const seen = await (await app.request("/api/worlds", {}, env)).json();
  assert.equal(seen.find((w: { id: string }) => w.id === id).views, 2, "deux chargements, deux vues");
  assert.equal(seen.find((w: { id: string }) => w.id === id).token, undefined, "le jeton ne ressort jamais de la lecture");
  assert.equal((await app.request(`/api/worlds/${id}`, {}, env)).status, 200);
  assert.equal(((await (await app.request(`/api/worlds/${id}`, {}, env)).json()) as { token?: string }).token, undefined, "ni du monde entier");

  // Sans jeton, ou avec un faux : le monde reste. C'est tout ce qui protège la galerie.
  assert.equal((await app.request(`/api/worlds/${id}`, { method: "DELETE" }, env)).status, 403);
  assert.equal((await app.request(`/api/worlds/${id}`, { method: "DELETE", headers: { "x-world-token": "faux" } }, env)).status, 403);
  assert.ok(await (await app.request(`/api/worlds/${id}`, {}, env)).json(), "toujours là après deux tentatives");

  assert.equal((await app.request(`/api/worlds/${id}`, mien, env)).status, 204);
  const after = await (await app.request("/api/worlds", {}, env)).json();
  assert.equal(after.find((w: { id: string }) => w.id === id), undefined, "supprimé de la liste");
  assert.equal((await app.request(`/api/worlds/${id}`, {}, env)).status, 404);
}

// Un objectif mal formé est refusé ; bien formé, il revient avec le monde.
{
  assert.equal((await app.request("/api/worlds", json({ ...monde, goal: "gagne !" }), env)).status, 400);
  const { id, token } = await (await app.request("/api/worlds", json({ ...monde, name: "défi", goal: "ge:12:600" }), env)).json();
  const world = await (await app.request(`/api/worlds/${id}`, {}, env)).json();
  assert.equal(world.goal, "ge:12:600", "l'objectif voyage avec le monde");
  await app.request(`/api/worlds/${id}`, { method: "DELETE", headers: { "x-world-token": token } }, env);
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

  const file = await app.request("/assets/index-abc123.js", {}, assets);
  assert.match(file.headers.get("cache-control") ?? "", /immutable/, "un fichier hashé se garde un an");
}

assert.equal((await app.request("/api/inconnu", {}, env)).status, 404);

console.log("ok — API conforme");
