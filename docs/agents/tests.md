# Tests, budgets et CI

## Les commandes

| Commande | Ce qu'elle vérifie |
| --- | --- |
| `npm run typecheck` | **quatre** projets tsc : `tsconfig.json` (client, lib DOM), `tsconfig.worker.json` (Worker, types générés, pas de DOM), `tsconfig.test.json` (tout `test/` sauf api.ts : types Node + DOM) et `tsconfig.test-worker.json` (test/api.ts : types Node + Worker). Node exécute les tests **sans** vérifier leurs types : sans ces deux derniers, un champ disparu n'y était vu qu'à l'exécution, et jamais dans test/gpu.ts, qui ne tourne pas en CI |
| `npm run check` | les sept scripts d'`assert`, dans l'ordre : sim, libm, ui, api, sandbox, pool, rules |
| `npm run browser` | dans Chromium sans fenêtre (Playwright) : le shader WebGL2 contre `Renderer` à une unité près, la page du jeu qui charge sans erreur, démarre le son au premier geste et survit à une perte du contexte WebGL. Demande `npx playwright install chromium` une fois par machine ; tout est dans [docs/navigateur.md](../navigateur.md) |
| `npm run bench` | le tick du moteur sur 320×180, 480×270, 640×360, 1280×720, 1920×1080 ; échoue au-delà du budget (mesuré en 320×180 seulement) |
| `npm run stress` | les pires cas, chacun sous un plafond, sur un seul fil ([test/stress.ts](../../test/stress.ts)) : un bac 320×180 plein de **chaque** matière (≤ 800 ns par cellule et par tick ; les plus chères font 110 à 160, l'aimant en faisait 4000), TNT en chaîne, souffle en plein air, mer de lave sous la pluie, aimants sur la limaille, et les bandes d'un bac 1920×1080 tout changé (préparation côté bac, tampon rendu comme le fait la page, et pose côté page : ~2 ms chacune, plafond 12 ; 11 et 15 ms avant le tampon unique recyclé et le miroir brut). Plafonds à ~5 fois la mesure de référence ; `STRESS_SLACK=2` les double. ~10 s |
| `npm run build` | typecheck puis `vite build` (sortie dans `dist/`) |
| `npm run loc` | taille du projet par poste |
| `npm run directions` | mesure de décision, pas un test : voir [Choisir une direction](#choisir-une-direction) |
| `npm run rust` | compile [rust/](../../rust/) en WASM puis lance [test/rust.ts](../../test/rust.ts) : `thermal()` et la pression (`breathe()`) en JavaScript contre leurs versions Rust, temps et égalité au bit près ; sim/libm.ts contre la crate Rust `libm`, mêmes bits exigés. Demande Rust installé ([docs/rust.md](../rust.md)) ; hors CI |

Il n'y a **pas de framework de test** ni de linter. Node ≥ 24 exécute le
TypeScript directement.

| Script | Couvre | Charge |
| --- | --- | --- |
| [test/sim.ts](../../test/sim.ts) | règles du moteur, registre, codec, défis, gestes, rejeu (et son export : lien, fichier, crible `vet()`, plafond de décompression), table d'éclairage (`lighting()` : qui émet arrête un peu), blocs de veille (dont la mer de lave qui doit s'endormir), pression et vent (un souffle chasse la fumée, la pierre n'en prend pas, l'onde ne traverse pas un mur, elle retombe à zéro exactement et le bac se rendort, `wakeAll()` l'efface ; une vitre proche éclate, une lointaine tient, une pièce close en casse plus ; l'onde arrache le sable d'un tas), empreinte | `Engine`, `codec`, `gestures`, `replay`, `challenges` |
| [test/libm.ts](../../test/libm.ts) | les fonctions mathématiques déterministes : à au plus un ulp de `Math` sous V8 sur des centaines de milliers d'arguments (voisins des multiples de π/4 compris), un cas de référence de la crate `libm` au bit près, cas particuliers (±0, infinis, NaN, débordements) et la limite assumée de sin / cos. Leur **déterminisme** (mêmes bits que la crate) est vérifié par `npm run rust` | `sim/libm.ts` |
| [test/ui.ts](../../test/ui.ts) | logique pure du panneau, touches réassignables ; ce que voit le héros ; rapports d'erreur (une fois chacun, cinq au plus, plafond) ; réglages purs du son (volumes, forme d'une explosion, stéréo, un curseur par famille de `MIX` dans index.html) | `ui.ts`, `sight.ts`, `reporter()` d'`errors.ts`, fonctions pures de `sound.ts` |
| [test/api.ts](../../test/api.ts) | routes, validation, jetons, en-têtes, cache, vues sous débit, ménage (récents + plus vus), routage des messages du salon ; `/api/error` (ce qui est journalisé, `console.error` capturé ; vide, trop lourd, débit) | `app.ts` via `app.request()` (store mémoire, pas de wrangler), `relay.ts` |
| [test/sandbox.ts](../../test/sandbox.ts) | protocole ordres / nouvelles (dont le son : une explosion dans la seule frame qui l'a jouée, le fond sonore des stats muet en pause) ; salon en lockstep, dont les messages mal formés d'un pair (geste d'invité, `turn` et départ de l'hôte) | `Sandbox` avec un rappel `send` qui empile |
| [test/browser.ts](../../test/browser.ts) (hors `check`) | les deux copies du coloriage (shader de screen.ts, `Renderer`) sur la page [test/screen.html](../../test/screen.html) ; la page du jeu : première frame, console sans erreur, module du son chargé à la première touche sans erreur, bac reposé après une perte du contexte WebGL ; une exception de la page arrive sur `/api/error` (`204`) | un serveur Vite (`createServer`, port libre) et Chromium via `playwright` |
| [test/pool.ts](../../test/pool.ts) | le moteur sur plusieurs fils : 400 ticks d'une partie chargée (monde généré, feu, explosifs, uranium, héros piloté) sur 1 fil et sur 4, **identiques au bit près**, pression comprise (le test vérifie qu'elle a bien soufflé) ; rebranchement sur un autre moteur | `Engine`, `Pool`, fils `worker_threads` ([test/helper.ts](../../test/helper.ts)) |
| [test/rules.ts](../../test/rules.ts) | les « Règles à ne pas enfreindre » d'[AGENTS.md](../../AGENTS.md) qui se lisent dans la source : aucun `Math.random()` hors la graine du constructeur, ids de matière gelés, index.html sans `style=` ni `<script>` en ligne (CSP), la page qui n'importe ni l'`Engine` ni main.ts et ne crée pas de `Worker`, `localStorage` réservé à ui.ts, pas de `SELECT *`, pas de `cloudflare:workers` dans app.ts, et le README qui liste exactement la palette | la source des fichiers, lue ; `materials.ts` pour la palette |

## Les règles lues dans la source

[test/rules.ts](../../test/rules.ts) garde les « Règles à ne pas enfreindre »
d'[AGENTS.md](../../AGENTS.md) qui n'ont pas de test de comportement **et ne
peuvent pas en avoir** : les enfreindre ne casse rien sous le V8 de la CI, ça
casse un salon entre Chrome et Firefox (un `Math.random()` dans une règle), un
monde déjà déposé dans la galerie (un id de matière renuméroté), la page d'un
joueur qui bloque les cookies (un `localStorage` nu) ou servie par le Worker
(la CSP contre `style=`). Il lit donc les fichiers, comme le fait déjà sim.ts
pour les fonctions `Math` approchées.

Y a sa place une règle **vérifiable en lisant un fichier**, dont l'infraction
serait silencieuse. Le comportement du moteur, du panneau et de l'API reste à
sim.ts, ui.ts et api.ts.

Le script tourne en 0,3 s, ce qui lui vaut un second appelant : sous Claude
Code, un hook `PostToolUse` le relance dès qu'une écriture touche `src/`,
index.html ou le README, sans attendre `npm run check`
([CLAUDE.md](../../CLAUDE.md)). Il reste la référence unique de ces règles —
un hook ne recopie pas ses tests, il l'appelle.

Chaque assert a été vérifié en cassant exprès la règle qu'il garde : un test de
source qui ne mord pas ne se voit pas, il passe. Casser la règle avant de
croire l'assert.

Les sources sont lues **sans leurs commentaires** (`code()`), sinon le
commentaire d'`engine.rand()` — « un `Math.random()` de plus dans ce fichier
rouvrirait le trou » — compterait comme une infraction, et interdire une
tournure obligerait à ne plus l'écrire même pour l'expliquer. C'est la
différence avec l'audit `Math` de sim.ts, qui lit la source brute (d'où « un
commentaire qui cite `Math.hypot` le ferait échouer »).

Le dernier bloc compare le README à la palette : la liste des matières en tête
du README s'était décalée d'une entrée (quarante-huit annoncées pour
quarante-sept, la gomme absente de l'énumération, et « quarante-sept
tabulations » pour quarante-neuf boutons). Personne ne relit une énumération de
cinquante noms ; le compte et la liste viennent maintenant de `PALETTE`.

## Choisir une direction

Avant d'ouvrir une piste, lire [performance.md](performance.md) : ce qui a déjà
payé, et pourquoi le GPU et Rust sont restés des prototypes.

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
   exacte ne l'est plus, ou si trop peu de changements d'état sont comparés.
   Il porte aussi la pression (`breathe()` → `air()`, deux versions exactes),
   comparée sur une salve d'explosions au-dessus du chantier, en 1920×1080 et
   1917×1077 ; il échoue si la salve laisse trop peu de pression à comparer.
   Enfin, sim/libm.ts contre la crate `libm` : un million d'arguments par
   fonction (doubles tirés bit à bit, voisins des multiples de π/4), le
   moindre bit d'écart le fait échouer.
   Résultats et marche à suivre dans [docs/rust.md](../rust.md).

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

En fin de fichier, un test **lit la source** d'engine.ts, de terrain.ts et de
sim/libm.ts, et refuse toute fonction `Math` approchée (`hypot`, `sin`,
`exp`…) : leur résultat peut différer d'un bit entre navigateurs, ce qu'aucun
test de comportement ne voit sous un seul V8. Ce qu'il faut à la place est
dans sim/libm.ts. Un commentaire qui cite `Math.hypot` le ferait échouer :
écrire `hypot()`. Les autres règles lues dans la source sont dans
[test/rules.ts](../../test/rules.ts), décrit plus haut.

Les tests à tirage sensible prennent une graine fixe (`new Engine(W, H, 1234)`)
plutôt qu'`engine()` : le TNT, au hasard, échouait une fois sur 4 000.

Le test de rejeu qui suit vérifie qu'une partie enregistrée retombe sur la
même grille dans un moteur neuf : il casse si une modification de la grille
échappe à `Recorder` (voir `stamp()` dans [simulation.md](simulation.md)).

La pression (`press`) n'est pas hachée, mais le TNT de la scène souffle :
son vent déplace fumée et flammes, donc l'empreinte. Neutraliser le vent
(`GUST_MIN` démesuré) doit rendre l'ancienne empreinte, `c0b016ea` : c'est
ainsi qu'on a vérifié que la pression ne change rien d'autre.

La scène de l'empreinte (60×40, soit 4×3 blocs) garde tous ses blocs éveillés
— lave, pile, thermite : les blocs de veille ne l'ont pas changée. Sortir
acide, thermite, sel, source, pile et aimant d'`ACTIVE` ne l'a pas changée non
plus : remis dans `ACTIVE`, la même empreinte sort — c'est ainsi qu'on a
vérifié que leurs règles tirent la même suite qu'avant. (Un premier essai la
changeait : la pile arrêtait son compte quand son métal devenait étincelle.) Ce sont les
tests « Blocs de veille », en fin de fichier, qui les couvrent : un bac au
repos ne tire plus au sort (`seed` figé), un trou, la gravité retournée et une
ambiante sous zéro réveillent les blocs endormis, et un rejeu lancé sur un bac
à moitié endormi retombe sur la même grille. Pour y poser un liquide au repos,
le mettre dans un bassin qu'il remplit exactement : sur un sol plat, sa
dernière rangée incomplète glisse sans fin et tient son bloc éveillé.

Pire cas de chaque matière (fin de test/sim.ts, sans chronomètre) : un bac
64×64 plein d'une seule matière doit s'endormir (`busy` = 0) — en 30 ticks
pour une matière inerte, en 2000 pour celles de `WORKS`, qui travaillent
vraiment (gaz qui vieillissent, acide qui ronge le bord, uranium qui saute,
verre fondu qui refroidit, créatures), chacune avec sa raison. Seul le héros
ne s'endort jamais. Une nouvelle matière qui tient son bloc éveillé pour rien
casse ce test : la faire appeler `wake(i)` quand elle a de quoi agir (voir
« Blocs de veille » dans [simulation.md](simulation.md)). Remettre l'aimant
dans `ACTIVE` le fait tomber. Le coût, lui, est chronométré par
`npm run stress`.

Mondes générés (fin de test/sim.ts) : même graine → même grille quel que soit
le tirage du bac, aucun tirage consommé, poches de pétrole et de lave closes,
uranium sans amas, et moins de 1 % des cellules qui bougent en 200 ticks. Un
réglage du générateur qui casse ce dernier assert rend les grandes grilles
lentes dès la naissance du monde.

Côté rendu, test/sandbox.ts recompose l'image comme la page (bandes posées
dans un miroir par le même `land()` de render.ts que world.ts), vérifie que
le miroir est la grille du moteur au bit près (température et pression
brutes comprises), et compare l'image, au pixel près, à un rendu témoin tout
neuf — après un feu, un geste bac en pause, la vue thermique, une autre
ambiante et un souffle, dont la pression doit arriver au miroir, puis y
retomber à zéro. Le témoin se tire **juste après** une frame, sinon il consomme les
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
7. `npm run stress` — les pires cas sous leurs plafonds (voir le tableau
   ci-dessus). Il a été vérifié contre le moteur d'avant l'optimisation des
   matières inactives : il y tombe sur l'aimant (4032 ns par cellule).
8. **Deux budgets de bundle**, non compressés (`dist/client/assets`) : la
   **page** (`index-*.js` + `*.css`, ce qui s'affiche d'abord), 86 016 octets
   (84 Kio), et le **moteur** (`worker-*.js`, le Worker de simulation, qui sert
   aussi de fil auxiliaire), 81 920 (80 Kio). Un seul total ne disait pas
   lequel avait grossi ; il avait dépassé 80 Ko sans que personne le voie.
   La page est passée de 80 à 84 Kio avec le son : chargé au premier geste,
   `sound-*.js` n'y compte pas, mais sa porte et l'assistant d'`import()` de
   Vite (~1,5 Ko) si. Un module qui n'a rien à faire avant un geste du joueur
   se charge de la même façon (audio.ts).
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

De ces modules-là, test/rules.ts ne vérifie **que** la forme : qu'ils
n'importent pas l'`Engine` ni main.ts, qu'ils ne créent pas de `Worker` et
qu'ils ne touchent pas `localStorage` en direct. Ce qu'ils font, personne ne le
vérifie à votre place.
