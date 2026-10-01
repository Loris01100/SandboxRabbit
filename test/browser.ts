/**
 * Les tests qui demandent un vrai navigateur : Chromium sans fenêtre
 * (Playwright), sur un serveur Vite lancé ici même — la même configuration
 * que `npm run dev`, sur un port libre, à côté d'un `npm run dev` déjà ouvert.
 *
 * 1. test/screen.html : le shader WebGL2 contre `Renderer`, au pixel près.
 * 2. la page du jeu : elle charge, le bac reçoit sa première frame, et aucune
 *    erreur ne sort dans la console — c'est tout ce qui couvre main.ts, le
 *    câblage DOM et le Worker de simulation dans un vrai navigateur ;
 * 3. une exception lancée dans la page part vers `/api/error` (errors.ts) et
 *    le Worker l'accepte.
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
  // Un canvas sans attributs mesure 300 × 150 : il ne quitte cette taille qu'à
  // la première frame, qui lui donne celle de la grille (320 × 180 au départ).
  await page.waitForFunction(() => {
    const c = document.querySelector<HTMLCanvasElement>("#world")!;
    return c.width !== 300 || c.height !== 150;
  }, null, { timeout: 30_000 });
  assert.deepEqual(errors, [], "la page du jeu charge sans erreur dans la console");

  // Le son : son module n'arrive qu'au premier geste (audio.ts), puis crée
  // son contexte audio et ses boucles. Aucun test sans navigateur n'y passe.
  const sound = page.waitForResponse((r) => r.url().includes("/sound.ts"), { timeout: 10_000 });
  await page.keyboard.press("Shift");
  assert.ok((await sound).ok(), "le module du son se charge au premier geste");
  await page.waitForTimeout(300);
  assert.deepEqual(errors, [], "le son démarre sans erreur dans la console");

  // Le pilote qui redémarre, simulé par WEBGL_lose_context. Lu dès l'événement
  // `restored`, avant toute frame : un contexte rendu part d'une image vide
  // (0, 0, 0), et seul screen.ts peut y reposer le bac — l'air n'est pas noir.
  const back = await page.evaluate(async () => {
    const canvas = document.querySelector<HTMLCanvasElement>("#world")!;
    const gl = canvas.getContext("webgl2")!;
    const lose = gl.getExtension("WEBGL_lose_context")!;
    const event = (name: string) => new Promise((done) => canvas.addEventListener(name, done, { once: true }));
    const lost = event("webglcontextlost");
    lose.loseContext();
    await lost;
    // Une tâche plus loin : appelé dans la microtâche de l'événement, avant que
    // Chromium ait fini de le distribuer, restoreContext() est ignoré.
    await new Promise((done) => setTimeout(done));
    const restored = event("webglcontextrestored");
    lose.restoreContext();
    await restored;
    const px = new Uint8Array(canvas.width * canvas.height * 4);
    gl.readPixels(0, 0, canvas.width, canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, px);
    return px.some((v, i) => i % 4 !== 3 && v > 0);
  });
  assert.ok(back, "après une perte du contexte WebGL, le bac est reposé");
  assert.deepEqual(errors, [], "perdre puis retrouver le contexte WebGL ne lève rien");

  const beacon = page.waitForResponse((r) => r.url().endsWith("/api/error"), { timeout: 10_000 });
  await page.evaluate(() => { window.setTimeout(() => { throw new Error("essai de remontée"); }); });
  const sent = await beacon;
  assert.match(sent.request().postData() ?? "", /^page : Error: essai de remontée/, "une exception de la page part vers /api/error");
  assert.equal(sent.status(), 204, "le Worker l'accepte");

  // Le salon, à deux, sur le Durable Object que Vite fait tourner dans workerd :
  // pseudos, liste des joueurs, curseur de l'autre, promotion quand l'hôte part.
  // Un nom de salon neuf à chaque passage, pour ne croiser personne.
  const salon = `essai-${Date.now()}`;
  // Sa propre liste : celle de la page contient déjà l'exception lancée exprès ci-dessus.
  const ratés: string[] = [];
  const joueur = async (nick: string) => {
    const p = await browser.newPage();
    p.on("pageerror", (e) => ratés.push(`${nick} : ${e.message}`));
    await p.goto(base);
    await p.waitForFunction(() => document.querySelector<HTMLCanvasElement>("#world")!.width !== 300, null, { timeout: 30_000 });
    await p.evaluate((n) => { document.querySelector<HTMLInputElement>("#nick")!.value = n; }, nick);
    p.once("dialog", (d) => void d.accept(salon));
    await p.evaluate(() => document.querySelector<HTMLButtonElement>("#room")!.click());
    return p;
  };
  const noms = (p: typeof page) => p.$$eval("#roster li", (l) => l.map((li) => li.textContent));
  const alice = await joueur("Alice");
  await alice.waitForFunction(() => document.querySelectorAll("#roster li").length === 1, null, { timeout: 15_000 });
  const bob = await joueur("Bob <b>");
  for (const p of [alice, bob]) await p.waitForFunction(() => document.querySelectorAll("#roster li").length === 2, null, { timeout: 15_000 });
  assert.deepEqual(await noms(bob), ["Alice (hôte)", "Bob <b> (vous)"], "chacun voit les pseudos, l'hôte et lui-même ; un pseudo reste du texte");
  const cadre = (await alice.locator("#world").boundingBox())!;
  await alice.mouse.move(cadre.x + cadre.width / 2, cadre.y + cadre.height / 2);
  await alice.mouse.move(cadre.x + cadre.width / 2 + 20, cadre.y + cadre.height / 2);
  await bob.waitForFunction(() => [...document.querySelectorAll<HTMLElement>(".peer")].some((e) => !e.hidden), null, { timeout: 5_000 });
  assert.equal(await bob.$eval(".peer", (e) => e.textContent), "Alice", "Bob voit le curseur d'Alice, à son nom");
  await alice.mouse.move(2, 2);
  await bob.waitForFunction(() => [...document.querySelectorAll<HTMLElement>(".peer")].every((e) => e.hidden), null, { timeout: 5_000 });
  await alice.close();
  await bob.waitForFunction(() => document.querySelectorAll("#roster li").length === 1, null, { timeout: 10_000 });
  assert.deepEqual(await noms(bob), ["Bob <b> (hôte) (vous)"], "Alice partie : Bob mène, et son curseur à elle a disparu");
  assert.equal(await bob.$$eval(".peer", (l) => l.length), 0);
  await bob.close();
  assert.deepEqual(ratés, [], "le salon tourne sans erreur");

  console.log(`ok — navigateur : ${report.cases.length} rendus identiques à une unité près, page du jeu chargée, son démarré, contexte WebGL retrouvé, erreur remontée, salon à deux`);
} finally {
  await browser.close();
  await server.close();
}
