# Tests dans un vrai navigateur (Playwright)

Ce qui ne tourne que dans un navigateur (WebGL, canvas, câblage DOM, Web
Worker) échappe aux tests Node. Ce guide décrit la mise en place retenue ici.
Elle se recopie telle quelle dans un autre projet Vite : la première partie
est générique, la seconde propre à Sandbox Rabbit.

## Le principe

- **La bibliothèque `playwright`, pas `@playwright/test`.** Un script Node
  ordinaire avec `node:assert`, comme les autres tests : pas de lanceur, pas
  de fichier de configuration, pas de rapport HTML. On pilote Chromium, on lit
  un résultat, on fait un `assert`.
- **Le serveur Vite est lancé par le script lui-même** (`createServer` de
  `vite`, port 0). Il reprend la configuration de `npm run dev` (plugins,
  en-têtes) sur un port libre : pas besoin de lancer `npm run dev` à la main,
  et un `npm run dev` déjà ouvert ne gêne pas.
- **La logique à tester tourne dans une page de test** (`test/xxx.html` +
  `test/xxx.ts`, servie par Vite comme n'importe quelle page), qui écrit son
  résultat dans `window.xxxReport`. Le script Node attend ce résultat
  (`page.waitForFunction`), le lit (`page.evaluate`) et fait ses `assert`.
  On peut aussi ouvrir la page à la main pendant `npm run dev` pour déboguer.
- **Un seul navigateur : Chromium.** Firefox et WebKit triplent le
  téléchargement et le temps de CI pour un gain rare.

## Installer, une fois par machine

```bash
npm install -D playwright          # la bibliothèque, dans package.json
npx playwright install chromium    # le navigateur (~115 Mo), hors du dépôt
```

Le navigateur n'est **pas** dans `node_modules` : il va dans le cache de
l'utilisateur (`%LOCALAPPDATA%\ms-playwright` sous Windows,
`~/.cache/ms-playwright` sous Linux, `~/Library/Caches/ms-playwright` sous
macOS). C'est l'étape qu'on oublie sur une nouvelle machine, et après une
mise à jour de `playwright` : le script échoue alors avec
`Executable doesn't exist at …`. Relancer `npx playwright install chromium`.

Sous Windows, `npm install` échoue en `EBUSY … rename` quand `npm run dev`
tourne (workerd, esbuild tiennent leurs fichiers ouverts) : arrêter le serveur
de dev le temps de l'installation.

## Le squelette du script

```ts
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { createServer } from "vite";

const server = await createServer({ server: { port: 0 }, logLevel: "error" });
await server.listen();
const base = server.resolvedUrls!.local[0];
const browser = await chromium.launch({ args: ["--enable-unsafe-swiftshader"] });
try {
  const page = await browser.newPage();
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  await page.goto(new URL("test/xxx.html", base).href);
  await page.waitForFunction(() => window.xxxReport !== undefined, null, { timeout: 30_000 });
  const report = await page.evaluate(() => window.xxxReport);
  assert.ok(/* … */);
  assert.deepEqual(errors, [], "aucune erreur dans la console");
} finally {
  await browser.close();
  await server.close();
}
```

Le `finally` compte : sans lui, un `assert` qui échoue laisse le serveur et
Chromium en vie, et le script ne rend jamais la main.

## En CI (GitHub Actions)

```yaml
- run: node node_modules/playwright/cli.js install --with-deps chromium
- run: npm run browser
```

L'appel direct utilise le paquet installé par `npm ci --ignore-scripts` :
il ne peut pas installer un paquet npm à la demande comme `npx`.
`--with-deps` installe aussi les bibliothèques système de Chromium (le runner
Ubuntu ne les a pas). Pas de cache à mettre en place : le téléchargement prend
quelques secondes sur le runner.

## Les pièges rencontrés

- **WebGL sans carte graphique.** Le runner de CI n'a pas de GPU : Chromium
  dessine alors en logiciel (SwiftShader), mais ne le propose plus sans le
  drapeau `--enable-unsafe-swiftshader`. Sans lui, `getContext("webgl2")` rend
  `null`. Le test doit **vérifier** qu'il a bien obtenu WebGL2, sinon il passe
  sans rien comparer.
- **Relire un canvas WebGL.** `getImageData` n'existe pas sur un canvas WebGL.
  Rappeler `canvas.getContext("webgl2")` rend le contexte existant, puis
  `gl.readPixels`. Les rangées arrivent de bas en haut, et il faut
  `preserveDrawingBuffer: true` à la création du contexte, sinon l'image peut
  être effacée avant la lecture.
- **Le GPU ne calcule pas comme JavaScript.** Les flottants du shader sont en
  32 bits, et GLSL a le droit de faire une division en approché (x · 1/y) :
  un `floor()` tombe parfois une unité plus bas. Comparer un shader à une
  version JavaScript exige une tolérance (ici : une unité, sur moins de 2 %
  des pixels). Il faut la mesurer, puis vérifier qu'une vraie modification
  d'un seul côté la dépasse.
- **Chemins relatifs dans une page de test.** Avec le plugin Cloudflare, les
  assets redirigent `/test/xxx.html` vers `/test/xxx`. Le navigateur résout
  encore bien `./xxx.ts`, mais Vite, lui, le cherche à la racine et affiche
  une `Pre-transform error`. Écrire `src="/test/xxx.ts"` (chemin absolu).
- **Vérifier que le test casse.** Changer une constante d'un seul côté et
  relancer : un test de rendu qui passe encore ne teste rien.

## Dans ce dépôt

| Fichier | Rôle |
| --- | --- |
| [test/browser.ts](../test/browser.ts) | le script : lance Vite et Chromium, lit le rapport, charge la page du jeu. `npm run browser` |
| [test/screen.html](../test/screen.html), [test/screen.ts](../test/screen.ts) | la page de comparaison : une grille (monde généré + une bande de chaque matière, `life`, température et figé variés) peinte par le shader de screen.ts et par `Renderer`, aux quatre heures et en vue thermique. Ouvrable à la main : http://localhost:5173/test/screen.html sous `npm run dev` |

Ce qui est vérifié :

1. **shader WebGL2 = `Renderer`**, à une unité près, sur moins de 2 % des
   pixels (la vue thermique est exacte). C'est la seule garde des deux copies
   du coloriage (voir « Le coloriage existe en deux copies » dans
   [AGENTS.md](../AGENTS.md)). L'éclairage global (`lit`) n'existe que côté
   shader : il n'est pas comparé ;
2. **la page du jeu charge** : le bac reçoit sa première frame (le canvas
   `#world` prend la taille de la grille) sans aucune erreur dans la console ;
3. **les erreurs remontent** : une exception lancée dans la page part vers
   `POST /api/error` (src/client/errors.ts) et le Worker répond `204`. Vite
   affiche alors un `[Unhandled error] Error: essai de remontée` : c'est
   l'exception du test, pas une panne.

Ce n'est pas dans `npm run check` : il faut Chromium installé. La CI le lance
après `check`.
