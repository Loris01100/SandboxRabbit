import { defineConfig } from "vite";
import { cloudflare } from "@cloudflare/vite-plugin";

/**
 * COOP + COEP en développement aussi : sans eux la page n'est pas isolée, pas
 * de `SharedArrayBuffer`, et le moteur tourne sur un seul fil — au même
 * résultat, mais on ne verrait jamais le multi-fils en `npm run dev`. En
 * production, c'est le Worker qui les pose (`HEADERS` de src/worker/app.ts).
 */
const isolation = {
  "cross-origin-opener-policy": "same-origin",
  "cross-origin-embedder-policy": "require-corp",
};

export default defineConfig({
  plugins: [cloudflare()],
  server: { headers: isolation },
  preview: { headers: isolation },
});
