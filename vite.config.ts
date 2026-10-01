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

/**
 * Sans le polyfill de `modulepreload` : tous les navigateurs qui ont WebGL2 et
 * `SharedArrayBuffer` le connaissent, et c'est un demi-Ko de moins dans la
 * page, qui a un budget. L'assistant qui enrobe un `import()` (celui de
 * sound.ts, dans audio.ts) reste là : Vite 8 n'a pas d'option pour s'en passer.
 */
export default defineConfig({
  plugins: [cloudflare()],
  // `SOURCEMAP=hidden` : les cartes de sources, sans le commentaire qui les
  // annonce — seul `npm run pile` (test/pile.ts) les demande, et les efface.
  build: { modulePreload: false, sourcemap: process.env.SOURCEMAP === "hidden" ? "hidden" : false },
  server: { headers: isolation },
  preview: { headers: isolation },
});
