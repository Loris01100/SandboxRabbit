/**
 * Auto-vérification de l'API : `npm run check` (Node exécute le TS tel quel).
 * Hono répond en mémoire via `app.request()` — ni serveur, ni wrangler.
 * Sans binding `DB` ni `RL`, on tape le store mémoire et rien n'est limité.
 */
import assert from "node:assert/strict";
import app from "../src/worker/app.ts";

const env = {} as never;
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
}

// Aller-retour complet : sauvegarde, liste, suppression.
{
  const created = await app.request("/api/worlds", json(monde), env);
  assert.equal(created.status, 201);
  const { id } = await created.json();

  const list = await (await app.request("/api/worlds", {}, env)).json();
  const found = list.find((w: { id: string }) => w.id === id);
  assert.ok(found, "le monde sauvegardé apparaît dans la liste");
  assert.equal(found.data, monde.data, "la liste porte la grille : la galerie n'a qu'une requête à faire");

  // Charger un monde compte une vue ; la liste la porte, c'est ce qui trie la galerie.
  assert.equal(found.views, 0, "un monde neuf n'a pas de vue");
  await app.request(`/api/worlds/${id}`, {}, env);
  await app.request(`/api/worlds/${id}`, {}, env);
  const seen = await (await app.request("/api/worlds", {}, env)).json();
  assert.equal(seen.find((w: { id: string }) => w.id === id).views, 2, "deux chargements, deux vues");

  assert.equal((await app.request(`/api/worlds/${id}`, { method: "DELETE" }, env)).status, 204);
  const after = await (await app.request("/api/worlds", {}, env)).json();
  assert.equal(after.find((w: { id: string }) => w.id === id), undefined, "supprimé de la liste");
  assert.equal((await app.request(`/api/worlds/${id}`, {}, env)).status, 404);
}

// Sans binding Durable Object (tests, `vite dev`), le bac partagé se dit indisponible.
assert.equal((await app.request("/api/room/public", {}, env)).status, 503);

assert.equal((await app.request("/api/inconnu", {}, env)).status, 404);

console.log("ok — API conforme");
