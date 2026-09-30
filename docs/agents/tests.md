# Tests, budgets et CI

## Les commandes

| Commande | Ce qu'elle vérifie |
| --- | --- |
| `npm run typecheck` | **quatre** projets tsc : `tsconfig.json` (client, lib DOM), `tsconfig.worker.json` (Worker, types générés, pas de DOM), `tsconfig.test.json` (tout `test/` sauf api.ts : types Node + DOM) et `tsconfig.test-worker.json` (test/api.ts : types Node + Worker). Node exécute les tests **sans** vérifier leurs types : sans ces deux derniers, un champ disparu n'y était vu qu'à l'exécution, et jamais dans test/gpu.ts, qui ne tourne pas en CI |
| `npm run check` | les cinq scripts d'`assert`, dans l'ordre : sim, ui, api, sandbox, pool |
| `npm run browser` | dans Chromium sans fenêtre (Playwright) : le shader WebGL2 contre `Renderer` à une unité près, et la page du jeu qui charge sans erreur. Demande `npx playwright install chromium` une fois par machine ; tout est dans [docs/navigateur.md](../navigateur.md) |
| `npm run bench` | le tick du moteur sur 320×180, 480×270, 640×360, 1280×720, 1920×1080 ; échoue au-delà du budget (mesuré en 320×180 seulement) |
| `npm run build` | typecheck puis `vite build` (sortie dans `dist/`) |
| `npm run loc` | taille du projet par poste |
| `npm run directions` | mesure de décision, pas un test : voir [Choisir une direction](#choisir-une-direction) |
| `npm run rust` | compile [rust/](../../rust/) en WASM puis lance [test/rust.ts](../../test/rust.ts) : `thermal()` en JavaScript contre sa version Rust, temps et égalité au bit près. Demande Rust installé ([docs/rust.md](../rust.md)) ; hors CI |

Il n'y a **pas de framework de test** ni de linter. Node ≥ 24 exécute le
TypeScript directement.

| Script | Couvre | Charge |
| --- | --- | --- |
| [test/sim.ts](../../test/sim.ts) | règles du moteur, registre, codec, défis, gestes, rejeu (et son export : lien, fichier, crible `vet()`, plafond de décompression), table d'éclairage (`lighting()` : qui émet arrête un peu), blocs de veille (dont la mer de lave qui doit s'endormir), empreinte | `Engine`, `codec`, `gestures`, `replay`, `challenges` |
| [test/ui.ts](../../test/ui.ts) | logique pure du panneau, touches réassignables ; ce que voit le héros | `ui.ts`, `sight.ts` |
| [test/api.ts](../../test/api.ts) | routes, validation, jetons, en-têtes, cache, vues sous débit, ménage (récents + plus vus), routage des messages du salon | `app.ts` via `app.request()` (store mémoire, pas de wrangler), `relay.ts` |
| [test/sandbox.ts](../../test/sandbox.ts) | protocole ordres / nouvelles ; salon en lockstep, dont les messages mal formés d'un pair (geste d'invité, `turn` et départ de l'hôte) | `Sandbox` avec un rappel `send` qui empile |
| [test/browser.ts](../../test/browser.ts) (hors `check`) | les deux copies du coloriage (shader de screen.ts, `Renderer`) sur la page [test/screen.html](../../test/screen.html) ; la page du jeu : première frame, console sans erreur | un serveur Vite (`createServer`, port libre) et Chromium via `playwright` |
| [test/pool.ts](../../test/pool.ts) | le moteur sur plusieurs fils : 400 ticks d'une partie chargée (monde généré, feu, explosifs, uranium, héros piloté) sur 1 fil et sur 4, **identiques au bit près** ; rebranchement sur un autre moteur | `Engine`, `Pool`, fils `worker_threads` ([test/helper.ts](../../test/helper.ts)) |

## Choisir une direction

Les grands mondes animés butent sur un seul cœur de processeur. `npm run
directions` ([test/directions.ts](../../test/directions.ts)) mesure, sur la
machine qui le lance, ce que rapporterait chaque piste — il n'échoue jamais et
n'est pas dans la CI :

1. **le vrai moteur** sur une scène chargée en 1920×1080 (eau, sable, feu),
   décomposé en règles, chaleur (`thermal()` chronométré à part) et rendu ;
2. **deux noyaux** qui résument ce travail
   ([directions-kernels.ts](../../test/directions-kernels.ts)) : le sable qui
   tombe et la diffusion de la chaleur, sur un cœur puis sur 2, 4, 8… cœurs
   ([directions-worker.ts](../../test/directions-worker.ts) : damier de blocs
   64×64 en quatre phases, `SharedArrayBuffer`, barrière `Atomics`, tirage
   haché par (bloc, tick) pour rester déterministe) ;
3. **une projection** : le vrai moteur, règles et chaleur divisées par le gain
   mesuré sur les noyaux, rendu inchangé ;
4. **la carte graphique**, qui ne se mesure que dans un navigateur :
   [test/gpu.html](../../test/gpu.html) pendant `npm run dev`
   (http://localhost:5173/test/gpu.html). Mêmes noyaux en WebGPU, le sable
   reformulé en blocs de Margolus (sans balayage ni horloge — la réécriture
   qu'imposerait le moteur), en 1920×1080, 4K et 8K.

5. **Rust / WASM** : `npm run rust` porte `thermal()` en Rust (trois
   versions, dont deux exactes au bit près) et le compare au moteur sur trois
   scènes, dix ticks chacune ; la fonderie (1917×1077, ambiante -0) y force
   des changements d'état et des blocs incomplets. Il échoue si une version
   exacte ne l'est plus, ou si trop peu de changements d'état sont comparés. Résultats
   et marche à suivre dans [docs/rust.md](../rust.md).

Les noyaux sont un **minorant** : le vrai moteur a cinquante matières, des
créatures et des explosions. La dernière ligne du rapport compare le coût par
cellule du noyau sable et celui du moteur réel par cellule éveillée : c'est le
facteur à appliquer aux gains du GPU pour estimer le moteur complet.

## Contrainte : Node **dépouille** le TypeScript, il ne le compile pas

Tout module chargé par un test (et tout ce qu'il importe) doit être du
TypeScript « effaçable » :

- imports **avec l'extension** `.ts` (`import { Engine } from "./engine.ts"`) ;
- `import type` / `type` pour ce qui n'est qu'un type (`verbatimModuleSyntax`) ;
- **pas** de paramètre-propriété (`constructor(private readonly x: T)`), pas
  d'`enum`, pas de `namespace` : écrire le champ et l'affecter dans le
  constructeur, utiliser un objet `as const` ;
- pas de DOM ni d'API de Worker au niveau module dans ce qui doit rester
  testable (`sim/*`, `gestures`, `replay`, `challenges`, `ui`, `app`, `store`).

Enfreindre une de ces règles ne casse pas `tsc`, mais sort le module de portée
des tests — c'est ce qui a longtemps gardé render.ts invérifiable.

## Écrire un test

Même style partout : un bloc `{ … }` par comportement, précédé d'un
commentaire en français qui dit la règle, et un message d'`assert` qui la
reformule.

```ts
// La neige fond dès 2 °C.
{
  const e = engine();                       // 60×40 dans test/sim.ts
  e.ambient = 20;
  e.set(10, 10, SNOW);
  assert.ok(runUntil(e, WATER, 200), "la neige fond à l'ambiante");
}
```

Utilitaires de test/sim.ts : `engine()`, `runUntil(e, id, ticks)`,
`count(e, id)`. Pense à `clock` : une cellule fraîchement posée peut sauter un
tick, d'où les boucles de deux pas ou plus.

Le script se termine par un `console.log("ok — …")` : un nouveau fichier de
test doit être ajouté à `check` dans package.json.

## L'empreinte du moteur

À la fin de test/sim.ts, une scène fixe (graine 1234, 300 ticks, qui réveille
chute, feu, eau, souffle et circuit) est hachée (FNV-1a sur `cells`, `life` et
`temp` arrondie) et comparée à une constante. C'est le **contrat
d'équivalence** du moteur : un portage Rust/WASM devra sortir la même.

Elle casse dès qu'une règle change son comportement **ou l'ordre de ses
tirages**. Quand le changement est voulu :

1. lancer `node test/sim.ts` : le message d'échec affiche l'empreinte obtenue ;
2. la recopier dans l'`assert.equal(empreinte, "…")` ;
3. le dire dans le message de commit (« l'empreinte change parce que… »).

Si elle change alors qu'on n'a pas touché au moteur : c'est un bug, pas une
empreinte à recopier.

En fin de fichier, un test **lit la source** d'engine.ts et de terrain.ts et
refuse toute fonction `Math` approchée (`hypot`, `sin`, `exp`…) : leur résultat
peut différer d'un bit entre navigateurs, ce qu'aucun test de comportement ne
voit sous un seul V8. Un commentaire qui cite `Math.hypot` le ferait échouer :
écrire `hypot()`.

Les tests à tirage sensible prennent une graine fixe (`new Engine(W, H, 1234)`)
plutôt qu'`engine()` : le TNT, au hasard, échouait une fois sur 4 000.

Le test de rejeu qui suit vérifie qu'une partie enregistrée retombe sur la
même grille dans un moteur neuf : il casse si une modification de la grille
échappe à `Recorder` (voir `stamp()` dans [simulation.md](simulation.md)).

La scène de l'empreinte (60×40, soit 4×3 blocs) garde tous ses blocs éveillés
— lave, pile, thermite : les blocs de veille ne l'ont pas changée. Ce sont les
tests « Blocs de veille », en fin de fichier, qui les couvrent : un bac au
repos ne tire plus au sort (`seed` figé), un trou, la gravité retournée et une
ambiante sous zéro réveillent les blocs endormis, et un rejeu lancé sur un bac
à moitié endormi retombe sur la même grille. Pour y poser un liquide au repos,
le mettre dans un bassin qu'il remplit exactement : sur un sol plat, sa
dernière rangée incomplète glisse sans fin et tient son bloc éveillé.

Mondes générés (fin de test/sim.ts) : même graine → même grille quel que soit
le tirage du bac, aucun tirage consommé, poches de pétrole et de lave closes,
uranium sans amas, et moins de 1 % des cellules qui bougent en 200 ticks. Un
réglage du générateur qui casse ce dernier assert rend les grandes grilles
lentes dès la naissance du monde.

Côté rendu, test/sandbox.ts recompose l'image comme la page (bandes recopiées
dans un tableau miroir) et la compare, au pixel près, à un rendu témoin tout
neuf — après un feu, un geste bac en pause, la vue thermique et une autre
ambiante. Le témoin se tire **juste après** une frame, sinon il consomme les
blocs changés (`engine.changed()`) à la place du bac.

## Budgets surveillés par la CI

[.github/workflows/ci.yml](../../.github/workflows/ci.yml), à chaque push et PR,
Node 24 :

1. `npm ci`
2. `npm audit --omit=dev --audit-level=high` — seules les dépendances livrées
   au navigateur comptent (aujourd'hui : `hono`).
3. `npm run build`
4. `npm run check`
5. `npx playwright install --with-deps chromium` puis `npm run browser`
   ([docs/navigateur.md](../navigateur.md)) — SwiftShader tient lieu de carte
   graphique sur le runner.
6. `npm run bench` — **tick ≤ 4 ms en 320×180** (surchargeable par
   `BENCH_BUDGET_MS`). Le budget attrape un effondrement, pas une dérive. La
   mesure dépend beaucoup de la charge de la machine (de 2,8 à 5 ms d'une
   exécution à l'autre sur un poste occupé) : relancer avant de conclure à une
   régression.
7. **Deux budgets de bundle, 81 920 octets chacun**, non compressés
   (`dist/client/assets`) : la **page** (`index-*.js` + `*.css`, ce qui
   s'affiche d'abord) et le **moteur** (`worker-*.js`, le Worker de
   simulation, qui sert aussi de fil auxiliaire). Un seul total ne disait pas
   lequel avait grossi ; il avait dépassé 80 Ko sans que personne le voie.
   Pas de framework, pas de dépendance client ajoutée à la légère, et pas de
   second fichier qui embarquerait une autre copie du moteur.

Les actions sont épinglées par SHA et le workflow n'a que `contents: read` :
garder ces deux propriétés en modifiant la CI.

## Ce qui n'est pas testé automatiquement

main.ts, view.ts, keys.ts, palette.ts, settings.ts, hero.ts, world.ts, room.ts (client), share.ts, theme.ts et le Durable Object
tiennent au DOM ou au runtime Cloudflare (le routage du salon, lui, est sorti
dans relay.ts et testé). `npm run browser` ne les couvre qu'en surface : la
page charge et reçoit sa première frame sans erreur, sans geste ni clic. Pour
le reste : `npm run dev`
(http://localhost:5173, Vite + Worker dans workerd, store mémoire) et vérifier
dans le navigateur. Le salon partagé se teste avec deux onglets sur le même nom
de salon.
