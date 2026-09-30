/**
 * Les tests qui demandent un vrai navigateur : Chromium sans fenêtre
 * (Playwright), sur un serveur Vite lancé ici même — la même configuration
 * que `npm run dev`, sur un port libre, à côté d'un `npm run dev` déjà ouvert.
 *
 * 1. test/screen.html : le shader WebGL2 contre `Renderer`, au pixel près.
 * 2. la page du jeu : elle charge, le bac reçoit sa première frame, et aucune
 *    erreur ne sort dans la console — c'est tout ce qui couvre main.ts, le
 *    câblage DOM et le Worker de simulation dans un vrai navigateur.
 *
 * Le navigateur s'installe une fois par machine : `npx playwright install
 * chromium` (voir docs/navigateur.md).
 */
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { createServer } from "vite";
import type { Report } from "./screen.ts";

/**
 * Part des pixels où shader et `Renderer` peuvent différer d'une unité. GLSL
 * a le droit de calculer une division en approché (x · 1/y) : à 100 °C, le
 * halo de chaleur du ciel tombait à 16,99… au lieu de 17, et `floor()` perdait
 * une unité sur le rouge. L'égalité exacte est hors d'atteinte ; on en mesurait
 * 0,4 % au pire (la nuit). Un aspect changé d'un seul côté, lui, fait plus
 * qu'une unité, ou sur bien plus de pixels.
 */
const TOLERATED = 0.02;

const server = await createServer({ server: { port: 0 }, logLevel: "error" });
await server.listen();
const base = server.resolvedUrls!.local[0];
/**
 * Sans carte graphique (la CI), Chromium dessine le WebGL2 en logiciel par
 * SwiftShader, qu'il ne propose plus sans ce drapeau : sans lui, pas de
 * WebGL2, et la comparaison du shader n'aurait rien à comparer.
 */
const browser = await chromium.launch({ args: ["--enable-unsafe-swiftshader"] });

try {
  const page = await browser.newPage();
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });

  await page.goto(new URL("test/screen.html", base).href);
  await page.waitForFunction(() => window.screenReport !== undefined, null, { timeout: 30_000 });
  const report = (await page.evaluate(() => window.screenReport)) as Report;
  assert.equal(report.kind, "webgl2", "le navigateur de test a WebGL2 : sans lui, rien n'est comparé");
  for (const c of report.cases) {
    const why = `${c.differ} pixels, écart ${c.worst}, premier ${c.first}`;
    assert.ok(c.worst <= 1, `shader et Renderer colorient pareil à une unité près (${c.name}) : ${why}`);
    assert.ok(c.differ <= report.pixels * TOLERATED, `les écarts d'une unité restent rares (${c.name}) : ${why}`);
  }
  assert.deepEqual(errors, [], "la page de comparaison tourne sans erreur");

  await page.goto(base);
  await page.waitForFunction(() => document.querySelector<HTMLCanvasElement>("#world")!.width > 1, null, { timeout: 30_000 });
  assert.deepEqual(errors, [], "la page du jeu charge sans erreur dans la console");

  console.log(`ok — navigateur : ${report.cases.length} rendus identiques à une unité près, page du jeu chargée`);
} finally {
  await browser.close();
  await server.close();
}
