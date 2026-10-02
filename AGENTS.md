# AGENTS.md

Guide pour les agents IA (Claude Code, Codex, Cursor, Copilot, Gemini…) qui
travaillent sur ce dépôt. Ce fichier est le point d'entrée ; les guides
détaillés sont dans [docs/agents/](docs/agents/).

**Sandbox Rabbit** est un bac à sable cellulaire (« falling sand ») : ~49
matières, chaleur, explosifs, électricité, défis, galerie de mondes partagés et
bac multijoueur. Client TypeScript sans framework (canvas 2D, simulation dans
un Web Worker), servi par **un seul** Worker Cloudflare (Hono) qui héberge
aussi l'API, D1 et un Durable Object par salon.

## Langue

README, commentaires du code, messages d'`assert` et UI sont **en français**.
Écrire les nouveaux commentaires, libellés et messages en français.

## Commandes

```bash
npm install
npm run dev        # Vite + Worker dans workerd (http://localhost:5173), HMR, D1 local (migrations : --local)
npm run typecheck  # QUATRE projets tsc : client (DOM), Worker, tests (Node + DOM), test/api.ts (Node + Worker)
npm run check      # asserts : test/sim.ts, test/libm.ts, test/ui.ts, test/api.ts, test/sandbox.ts, test/pool.ts, test/rules.ts (Node exécute le TS)
npm run browser    # Chromium (Playwright) : shader WebGL2 = Renderer, page qui charge sans erreur (docs/navigateur.md)
npm run bench      # tick du moteur sur cinq tailles ; échoue au-delà de 4 ms en 320×180
npm run stress     # pires cas : bac plein de chaque matière, explosions, pression, lave, aimants, bandes 1920×1080 ; chacun sous un plafond
npm run drift      # bench et stress de origin/main (ou DRIFT_BASE) contre ici, même machine ; échoue au-delà de +30 %
npm run directions # mesure de décision : 1 cœur, N cœurs, projection (GPU : test/gpu.html sous npm run dev)
npm run rust       # prototype Rust/WASM de thermal() et de la pression contre le moteur JS, libm.ts contre la crate libm (demande Rust : docs/rust.md)
npm run build      # typecheck puis vite build
npm run preview    # build puis wrangler dev sur le bundle
npm run loc        # taille du projet par poste
npm run pile       # retraduit une pile d'erreur de production dans les sources : npm run pile < pile.txt (recettes.md)
npm run cf-typegen # régénère worker-configuration.d.ts après un changement de bindings
npm run deploy     # à ne lancer que sur demande explicite
```

Node ≥ 24 requis (exécution native du TypeScript). Pas de framework de test,
pas de linter.

## Documentation détaillée

| Guide | À lire avant de… |
| --- | --- |
| [docs/agents/architecture.md](docs/agents/architecture.md) | toucher à la page, au Worker de simulation, au salon, à l'API, au stockage ou au codec. Protocoles `Order` / `News` et salon, routes, clés `localStorage`. |
| [docs/agents/simulation.md](docs/agents/simulation.md) | modifier `engine.ts`, `materials.ts` ou `render.ts`. Tous les invariants du moteur, les usages de `life`. |
| [docs/agents/recettes.md](docs/agents/recettes.md) | ajouter une matière, une règle, un défi, un geste, un ordre, un contrôle, un raccourci, une route, une migration ; décoder une pile d'erreur de production. |
| [docs/agents/rendu.md](docs/agents/rendu.md) | toucher à `screen.ts` : la chaîne grille → pixel, les textures et les quatre programmes WebGL2, l'éclairage global (*radiance cascades*) et son dimensionnement, la perte de contexte, le secours 2D. |
| [docs/agents/performance.md](docs/agents/performance.md) | optimiser quoi que ce soit : quoi lancer selon la question, comment profiler, ce qui a déjà payé (et de combien), les pistes laissées de côté. |
| [docs/agents/tests.md](docs/agents/tests.md) | écrire ou corriger un test, mettre à jour l'empreinte du moteur, comprendre la CI et ses budgets. |
| [docs/agents/exploration.md](docs/agents/exploration.md) | travailler sur le mode exploration (bouton Explorer, `EXPLORE_SCALE`) : le plan du monde infini en fenêtre glissante, ses étapes et ce que chacune doit prouver. |
| [docs/navigateur.md](docs/navigateur.md) | écrire ou lancer un test dans un vrai navigateur (Playwright), installer Chromium sur une machine neuve, le reprendre dans un autre projet. |
| [docs/rust.md](docs/rust.md) | toucher à `rust/` : installer Rust, le prototype WASM de `thermal()`, ses mesures, le déterminisme f64, ce qu'il faudrait pour brancher Rust sur le moteur. |

Le [README](README.md) décrit le jeu du point de vue du joueur (une ligne par
fonctionnalité) : le tenir à jour quand un comportement visible change.

## Carte du dépôt

```
index.html               tout le DOM de la page (panneau, dialogues, raccourcis)
src/client/
  main.ts                câblage DOM, souris, raccourcis, défis, rejeu, boucle rAF ; gesture()
  palette.ts             palette des matières, récentes ; select(), current, emit
  hero.ts                héros côté page : position, caméra décrochée, commandes, vues
  settings.ts            réglages du panneau, retenus d'une visite à l'autre ; fit(), restore()
  view.ts                zoom et déplacement de la vue (transformation CSS du canvas)
  keys.ts                touches réassignables, touches tenues, fenêtre Paramètres
  world.ts               canvas + porte unique vers le Worker : order(), listen(), askLoad(), askClip() ; miroir de la grille
  screen.ts              colorie le miroir : shader WebGL2, secours 2D
  gestures.ts            Gesture + applyGesture(engine, g) + météo          (pur)
  replay.ts              Recorder / Player                                  (pur)
  challenges.ts          défis et décors bâtis en code                      (pur)
  terrain.ts             monde généré par graine, bâti au repos             (pur)
  sight.ts               ce que voit le héros : rayons → colonne de pixels  (pur)
  ui.ts                  logique pure du panneau + read/write/forget (localStorage)
  room.ts share.ts theme.ts   salon (pseudos, curseurs), sauvegarde/exports, jour-nuit (reçoivent leurs dépendances par init…())
  gallery.ts             la galerie (recherche, tri, J'aime, remix), chargée à sa première ouverture par share.ts
  lobby.ts               porte du salon : charge room.ts au premier clic sur « Bac partagé »
  board.ts               classement des défis, chargé au premier défi : records jugés par sim/judge.ts, publication
  audio.ts sound.ts      son : porte (charge sound.ts au premier geste) et synthèse Web Audio ; Heard / Hum de sandbox.ts
  errors.ts              exceptions de la page et du Worker de simulation → POST /api/error ; reporter() (pur)
  sim/
    worker.ts            entrée du Web Worker, cadence ~60 Hz ; se relance en fils auxiliaires
    sandbox.ts           Sandbox : moteur, rendu, annulation, défis, rejeu ; Order / News
    pool.ts              fils auxiliaires du moteur (mémoire partagée, Atomics)   (pur)
    engine.ts            l'automate cellulaire (tableaux plats)
    materials.ts         MATERIALS, CATEGORIES, PALETTE, SHORTCUTS
    render.ts            bandes (Tracker), Renderer : matière, vue thermique, vue pression ; vignettes
    flatlight.ts         éclairage global du secours 2D, chargé à la demande par screen.ts      (pur)
    flatlight-worker.ts  fil de l'éclairage du secours : les rayons de FlatLight, hors de la page
    judge.ts verdict.ts  le juge du classement : un fil qui rejoue chaque record ; verdict() (pur)
    codec.ts             RLE + base64 url (format des mondes sauvegardés)
    libm.ts              sin, cos, atan, atan2, exp, log déterministes (copie de musl)   (pur)
src/worker/
  index.ts               entrée Cloudflare : fetch → app, cron, réexport de Room
  app.ts                 routes Hono /api/*, en-têtes, fallback ASSETS ; interface Env
  store.ts               D1 si env.DB, sinon Map en mémoire
  room.ts                Durable Object du salon (relaie, ne simule pas)
  relay.ts               qui a le droit de dire quoi dans un salon      (pur)
migrations/              schéma D1, un fichier numéroté par changement
rust/                    prototype : thermal() et la pression en Rust → WASM, et la crate libm, référence de libm.ts ; mesurés par test/rust.ts (pas branchés sur le bac)
test/                    scripts d'assert (+ bench.ts, stress.ts, drift.ts, loc.ts, pile.ts) ; browser.ts + screen.html : tests dans Chromium
```

## Règles à ne pas enfreindre

Chacune est expliquée dans le guide indiqué. Celles qui se vérifient en lisant
un fichier sont gardées par [test/rules.ts](test/rules.ts) — tirage
reproductible, ids de matière gelés, CSP, cloisonnement de la page,
`localStorage`, `SELECT *` ; les autres ne sont gardées par aucun test précis.

**Simulation** ([simulation.md](docs/agents/simulation.md))

- Tout tirage au sort du moteur (et de la météo) passe par `engine.rand()`,
  **jamais** `Math.random()`. Seule exception : terrain.ts a son propre
  tirage, semé par la graine — bâtir un monde ne doit pas décaler celui du bac.
- Pas de fonction `Math` « approchée selon l'implémentation » (`hypot`, `sin`,
  `exp`, `pow`…) dans engine.ts ni terrain.ts : un bit d'écart entre
  navigateurs fait diverger un salon. `Math.sqrt` est permise ; `sin`, `cos`,
  `atan`, `atan2`, `exp`, `log` viennent de `sim/libm.ts`, déterministes.
  test/sim.ts lit la source et le vérifie.
- Déplacements via `tryMove()`, `y + this.gravity` et `drift()`. Exceptions :
  `MAGNET`, le lapin qui bouge ses neuf cellules d'un bloc (`relocate()`),
  et le gaz ou la poudre que pousse la pression (`blown()`, `swept()`).
- La pression de l'air n'entre que par `puff()` : une écriture directe dans
  `press` laisse un bloc endormi sous pression, ou la passe `breathe()` sautée.
- Une règle transforme un voisin avec `become()`, pas `set()` (qui libère le
  figé).
- Ne pas lire `MATERIALS[id].xxx` dans le chemin chaud : utiliser les tables
  dérivées (`KIND`, `DENSITY`, `HEAT`…) ou en ajouter une.
- `life` est un octet (≤ 250) aux usages multiples selon la matière : ne pas le
  réinitialiser à l'aveugle.
- Changement d'état = `boil` / `freeze` dans `MATERIALS`, pas de règle — sauf
  pour une créature, qui change en entier.
- Le corps du lapin ne garde rien dans `life`. Celui du héros y garde sa
  fiche (`HERO_SLOTS`), qu'il faut lire comme valide tout à zéro : une grille
  sans état vivant la remet à zéro.
- `engine.temp` est réassigné à chaque tick : ne pas en garder de référence.
- Ne pas toucher à l'ordre du balayage, à `clock`, ni à l'ordre bord → centre
  d'`explode()`.
- Un nouvel explosif = un nouveau **déclencheur**. Une règle ne fait jamais
  sauter directement : `blast(x, y)`, et la matière dans `BLAST` (son rayon).
- Multi-fils : **une règle ne lit ni n'écrit à plus de 15 cellules** de sa
  cellule (le damier ne protège pas au-delà) ; plus loin, on diffère comme
  `blast()`. Jamais d'état partagé tiré ou modifié pendant le damier. Le
  résultat ne doit pas dépendre du nombre de fils : test/pool.ts compare 1 et
  4 fils au bit près.
- Blocs de veille : une écriture directe dans les tableaux appelle
  `this.wake(i)` dans le moteur, `engine.wakeAll()` ailleurs ; une matière qui
  agit sans que rien ne bouge autour appelle `wake(i)` quand elle a de quoi
  agir, ou va dans `ACTIVE` si elle agit à chaque tick. Sinon son bloc
  s'endort et elle se fige.
- Ne jamais renuméroter les ids de matière.

**Client** ([architecture.md](docs/agents/architecture.md))

- Le fil principal n'importe pas l'`Engine` : il passe par `order()` /
  `listen()` / `askLoad()` / `askClip()` de world.ts.
- Toute modification de la grille par l'utilisateur passe par `gesture()` de
  main.ts (jamais `order({t:"do"})` en direct), sinon le salon ne la voit pas.
- Ce qui change la grille sans geste appelle `this.rec?.stamp()` dans
  sandbox.ts, sinon le rejeu diverge. S'il la remplace, il arrête d'abord le
  rejeu (`this.play(false)`).
- `localStorage` uniquement via `read` / `write` / `forget` de ui.ts.
- `room.ts`, `share.ts`, `theme.ts`, `view.ts`, `keys.ts`, `palette.ts`, `settings.ts`, `hero.ts`, `audio.ts`, `sound.ts`, `gallery.ts`, `lobby.ts`, `board.ts` n'importent pas main.ts (cycle).
- Une frame ne porte que les bandes changées : world.ts les recopie toutes
  dans son miroir, n'en saute jamais une. Un réglage qui change l'aspect sans
  écriture (comme `heatmap`) fait tout recolorier.
- 1 cellule = 1 pixel, un seul envoi à l'écran par frame (`screen.paint`) :
  pas de dessin par cellule.
- Le coloriage existe en deux copies : le shader de screen.ts et `Renderer`
  de render.ts (secours sans WebGL2, tests). Un aspect se change des deux
  côtés ; `npm run browser` compare les deux. L'éclairage aussi a deux
  chemins (cascades du shader, `FlatLight` de sim/flatlight.ts) : mêmes
  entrées (`lighting()`, `RED_HOT`) et même mélange, mais ils se ressemblent
  sans coïncider et ne sont pas comparés — une matière lumineuse se règle
  dans `lighting()`, pour les deux.
- Pas de `style=` ni de `<script>` en ligne : la CSP les bloque.
- Données externes (galerie, lien, pair de salon) : `engine.adopt()` et
  `known()` écartent les ids inconnus, `disc()` borne les rayons,
  `applyGesture` refuse les coordonnées non entières ; le salon passe les
  gestes d'invité par `isGesture()`, le départ et les `turn` de l'hôte par
  `vet()` / `vetBeats()`. `life` n'est pas filtré :
  une règle qui y lit un id de matière passe par `KNOWN`.
- Le salon (`relay.ts`) ne laisse passer que `start` / `turn` de l'hôte vers
  les invités et `do` / `sync` d'un invité vers l'hôte ; `role`, `peers` et
  `roster` ne viennent que du Durable Object. Le `cursor` va de chacun à tous,
  mais **refait** par le DO (`cursor()` : cellules entières, numéro de
  l'émetteur) : il ne touche jamais la grille — rien de ce qui la change ne
  passe par lui.
- Salon en lockstep : ce qui change la grille de l'hôte sans geste passe par
  `stamp()` de sandbox.ts, sinon les invités divergent (voir
  [docs/agents/architecture.md](docs/agents/architecture.md)).

**Worker et données**

- Aucun import de `cloudflare:workers` dans `src/worker/app.ts`.
- Le `token` de suppression ne sort d'aucune route de lecture (pas de
  `SELECT *`).
- Écriture publique = `flooding()` en premier, puis validation complète.
- Le codec est le format des mondes déjà sauvegardés : n'ajouter qu'un bloc en
  fin, ne jamais changer un bloc existant.
- Schéma D1 : un nouveau fichier de migration, jamais de retouche d'un ancien.

**Tests** ([tests.md](docs/agents/tests.md))

- Modules chargés par les tests : imports avec extension `.ts`, pas de
  paramètre-propriété, pas d'`enum`, pas de DOM au niveau module.
- Une empreinte de moteur qui change doit être justifiée, pas recopiée par
  réflexe.

## Conventions

- Les commentaires disent **pourquoi**, avec le cas concret qui a motivé le
  code (« sans ça, un invité qui remplit voit son geste effacé… »). Suivre la
  densité et le ton des commentaires existants.
- `ponytail:` en tête d'un commentaire marque un raccourci assumé et sa limite
  (« à revoir le jour où… »). En ajouter un plutôt que de laisser une dette
  implicite. La liste complète :
  `grep -rn -A6 --exclude-dir=target "ponytail:" src test rust migrations .github index.html wrangler.jsonc`
  (skill `ponytail-debt`) ; le README la résume sous « Dette connue ».
- Pas de framework UI, DOM impératif, éléments récupérés par
  `querySelector<…>("#id")!`. Pas de dépendance client sans raison forte : la
  CI tient deux budgets, 84 Kio pour la page (JS + CSS) et 80 Kio pour le moteur (Worker).
- Ce qui est testable (pur) va dans un module sans DOM (`ui.ts`,
  `gestures.ts`…) avec son test, plutôt que de grossir main.ts.
- TypeScript strict, `noUnusedLocals` / `noUnusedParameters` : préfixer par `_`
  un paramètre imposé mais inutilisé.

## Documentation à tenir à jour

**Toute modification du code s'accompagne de la mise à jour d'au moins un
fichier `.md`.** Tout **ajout** (matière, défi, route, module, ordre, geste,
commande, règle…) reçoit son entrée dans la doc qui couvre le sujet — ou un
nouveau guide dans `docs/agents/` si aucun ne le couvre, avec sa ligne dans le
tableau « Documentation détaillée » ci-dessus. Une doc fausse est pire qu'une
doc absente : corriger aussi ce que la modification rend faux.

Seule exception : un changement sans effet sur ce que la doc décrit (renommage
local, faute de frappe, refactor interne). Le dire explicitement.

| Code modifié | Doc à mettre à jour |
| --- | --- |
| `sim/engine.ts`, `sim/materials.ts`, `sim/render.ts`, `sim/codec.ts` | [simulation.md](docs/agents/simulation.md) (invariants, usages de `life`) ; README (tableau des règles, nombre de matières) si le comportement visible change ; codec → [architecture.md](docs/agents/architecture.md) |
| `sim/sandbox.ts`, `sim/worker.ts`, `world.ts` | [architecture.md](docs/agents/architecture.md) (protocole `Order` / `News`) |
| `gestures.ts`, `replay.ts` | [architecture.md](docs/agents/architecture.md) (chemin d'un geste), [recettes.md](docs/agents/recettes.md) (ajouter un geste) |
| `challenges.ts`, `terrain.ts` | README (défis, décors, mondes générés) ; `terrain.ts` → [architecture.md](docs/agents/architecture.md) (modules) |
| `main.ts`, `index.html`, `style.css`, `ui.ts`, `share.ts`, `room.ts`, `theme.ts` | [architecture.md](docs/agents/architecture.md) (modules, galerie, salon, clés `localStorage`) ; README si une fonctionnalité visible change |
| `src/worker/*`, `migrations/`, `wrangler.jsonc` | [architecture.md](docs/agents/architecture.md) (API, stockage) ; README (tableau de l'API) |
| `test/*`, scripts de `package.json`, `.github/` | [tests.md](docs/agents/tests.md) ; section Commandes de ce fichier ; `test/browser.ts`, `test/screen.*` → [docs/navigateur.md](docs/navigateur.md) |
| `screen.ts` | [rendu.md](docs/agents/rendu.md) (textures, programmes, éclairage) ; [simulation.md](docs/agents/simulation.md) si la règle d'aspect change des deux côtés |
| une optimisation (moteur, rendu, boucle, budgets) | [performance.md](docs/agents/performance.md) (« Ce qui a déjà payé », avec le gain mesuré) |
| `rust/` | [docs/rust.md](docs/rust.md) (et ses résultats, s'ils changent) |
| une skill (`.claude/skills/` ou `.agents/skills/`) | l'autre copie, identique : les deux dossiers portent les mêmes skills |
| les permissions ou les hooks de `.claude/` | [CLAUDE.md](CLAUDE.md), section « Propre à Claude Code » (ce qui passe sans demander, ce qui reste confirmé, ce que garde chaque hook) |
| une nouvelle marche à suivre récurrente | [recettes.md](docs/agents/recettes.md) |
| une nouvelle règle à ne pas enfreindre | « Règles à ne pas enfreindre » ci-dessus **et** le guide concerné |

Côté Claude Code, un hook `Stop` ([.claude/hooks/doc-sync.mjs](.claude/hooks/doc-sync.mjs), en Node : pas de `jq` à installer)
refuse de clore un tour quand du code a changé sans aucun `.md` — et deux autres
hooks gardent les règles ci-dessus au moment de l'écriture ([CLAUDE.md](CLAUDE.md)).
Les autres agents appliquent la règle d'eux-mêmes.

## Avant de rendre la main

1. `npm run typecheck` (les quatre projets, tests compris).
2. `npm run check`.
3. `npm run bench` et `npm run stress` si le moteur ou le rendu a bougé ; `npm run browser` si
   render.ts, screen.ts, main.ts, world.ts ou index.html a bougé.
4. `npm run build` si des dépendances, index.html ou le CSS ont changé (budget
   de bundle).
5. La doc suit le code : voir « Documentation à tenir à jour » ci-dessus.
6. Ne pas commit, push ni déployer sans demande explicite.
