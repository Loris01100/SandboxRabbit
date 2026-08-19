/**
 * Entrée du Worker : l'API Hono (app.ts), le Durable Object des salons, et le
 * ménage nocturne de la base.
 */
import app from "./app.ts";
import { createStore } from "./store.ts";
import type { Env } from "./app.ts";

export { Room } from "./room.ts";
export type { Env } from "./app.ts";

/** Nombre de mondes gardés en base ; la galerie n'en montre pas plus. */
const KEEP = 50;

export default {
  fetch: app.fetch,
  // Au-delà de 50, on paye du stockage que personne ne voit.
  async scheduled(_event, env) {
    await createStore(env).purge(KEEP);
  },
} satisfies ExportedHandler<Env>;
