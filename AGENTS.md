# AGENTS.md

Guide pour les agents IA (Claude Code, Codex, Cursor, Copilot, Gemini…) qui
travaillent sur ce dépôt. Ce fichier est le point d'entrée ; les guides
détaillés sont dans [docs/agents/](docs/agents/).

**Sandbox Rabbit** est un bac à sable cellulaire (« falling sand ») : ~47
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
npm run dev        # Vite + Worker dans workerd (http://localhost:5173), HMR, store en mémoire
npm run typecheck  # DEUX projets tsc : tsconfig.json (client/DOM) + tsconfig.worker.json (Worker)
npm run check      # asserts : test/sim.ts, test/ui.ts, test/api.ts, test/sandbox.ts (Node exécute le TS)
npm run bench      # tick du moteur sur trois tailles ; échoue au-delà de 4 ms en 320×180
npm run build      # typecheck puis vite build
npm run preview    # build puis wrangler dev sur le bundle
npm run loc        # taille du projet par poste
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
| [docs/agents/recettes.md](docs/agents/recettes.md) | ajouter une matière, une règle, un défi, un geste, un ordre, un contrôle, un raccourci, une route, une migration. |
| [docs/agents/tests.md](docs/agents/tests.md) | écrire ou corriger un test, mettre à jour l'empreinte du moteur, comprendre la CI et ses budgets. |

Le [README](README.md) décrit le jeu du point de vue du joueur (une ligne par
fonctionnalité) : le tenir à jour quand un comportement visible change.

## Carte du dépôt

```
index.html               tout le DOM de la page (panneau, dialogues, raccourcis)
src/client/
  main.ts                câblage DOM, souris, zoom, réglages, défis, boucle rAF ; gesture()
  world.ts               canvas + porte unique vers le Worker : order(), listen(), askLoad(), askClip()
  gestures.ts            Gesture + applyGesture(engine, g) + météo          (pur)
  replay.ts              Recorder / Player                                  (pur)
  challenges.ts          défis et décors bâtis en code                      (pur)
  ui.ts                  logique pure du panneau + read/write/forget (localStorage)
  room.ts share.ts theme.ts   salon, galerie/exports, jour-nuit (reçoivent leurs dépendances par init…())
  sim/
    worker.ts            entrée du Web Worker, cadence ~60 Hz
    sandbox.ts           Sandbox : moteur, rendu, annulation, défis, rejeu ; Order / News
    engine.ts            l'automate cellulaire (tableaux plats)
    materials.ts         MATERIALS, CATEGORIES, PALETTE, SHORTCUTS
    render.ts            cellules → ImageData, vue thermique, vignettes
    codec.ts             RLE + base64 url (format des mondes sauvegardés)
src/worker/
  index.ts               entrée Cloudflare : fetch → app, cron, réexport de Room
  app.ts                 routes Hono /api/*, en-têtes, fallback ASSETS ; interface Env
  store.ts               D1 si env.DB, sinon Map en mémoire
  room.ts                Durable Object du salon (relaie, ne simule pas)
  relay.ts               qui a le droit de dire quoi dans un salon      (pur)
migrations/              schéma D1, un fichier numéroté par changement
test/                    scripts d'assert (+ bench.ts, loc.ts)
```

## Règles à ne pas enfreindre

Chacune est expliquée dans le guide indiqué. La plupart ne sont gardées par
aucun test précis.

**Simulation** ([simulation.md](docs/agents/simulation.md))

- Tout tirage au sort du moteur (et de la météo) passe par `engine.rand()`,
  **jamais** `Math.random()`.
- Déplacements via `tryMove()`, `y + this.gravity` et `drift()`. Exceptions :
  `MAGNET`, et le lapin qui bouge ses neuf cellules d'un bloc (`relocate()`).
- Une règle transforme un voisin avec `become()`, pas `set()` (qui libère le
  figé).
- Ne pas lire `MATERIALS[id].xxx` dans le chemin chaud : utiliser les tables
  dérivées (`KIND`, `DENSITY`, `HEAT`…) ou en ajouter une.
- `life` est un octet (≤ 250) aux usages multiples selon la matière : ne pas le
  réinitialiser à l'aveugle.
- Changement d'état = `boil` / `freeze` dans `MATERIALS`, pas de règle — sauf
  pour une créature, qui change en entier.
- Le corps d'une créature ne garde rien dans `life` : le salon ne le transmet
  pas.
- `engine.temp` est réassigné à chaque tick : ne pas en garder de référence.
- Ne pas toucher à l'ordre du balayage, à `clock`, ni à l'ordre bord → centre
  d'`explode()`.
- Un nouvel explosif = un nouveau **déclencheur**.
- Ne jamais renuméroter les ids de matière.

**Client** ([architecture.md](docs/agents/architecture.md))

- Le fil principal n'importe pas l'`Engine` : il passe par `order()` /
  `listen()` / `askLoad()` / `askClip()` de world.ts.
- Toute modification de la grille par l'utilisateur passe par `gesture()` de
  main.ts (jamais `order({t:"do"})` en direct), sinon le salon ne la voit pas.
- Ce qui change la grille sans geste appelle `this.rec?.stamp()` dans
  sandbox.ts, sinon le rejeu diverge.
- `localStorage` uniquement via `read` / `write` / `forget` de ui.ts.
- `room.ts`, `share.ts`, `theme.ts` n'importent pas main.ts (cycle).
- 1 cellule = 1 pixel, un seul `putImageData` par frame : pas de dessin par
  cellule.
- Pas de `style=` ni de `<script>` en ligne : la CSP les bloque.
- Données externes (galerie, lien, pair de salon) : `engine.adopt()` et
  `known()` écartent les ids inconnus, `disc()` borne les rayons,
  `applyGesture` refuse les coordonnées non entières. `life` n'est pas filtré :
  une règle qui y lit un id de matière passe par `KNOWN`.
- Le salon (`relay.ts`) ne laisse passer que la `grid` de l'hôte vers les
  invités et le `do` d'un invité vers l'hôte ; `role` et `peers` ne viennent
  que du Durable Object.

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
  implicite.
- Pas de framework UI, DOM impératif, éléments récupérés par
  `querySelector<…>("#id")!`. Pas de dépendance client sans raison forte : le
  bundle a un budget de 80 Kio en CI.
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
| `challenges.ts` | README (défis, décors) |
| `main.ts`, `index.html`, `style.css`, `ui.ts`, `share.ts`, `room.ts`, `theme.ts` | [architecture.md](docs/agents/architecture.md) (modules, galerie, salon, clés `localStorage`) ; README si une fonctionnalité visible change |
| `src/worker/*`, `migrations/`, `wrangler.jsonc` | [architecture.md](docs/agents/architecture.md) (API, stockage) ; README (tableau de l'API) |
| `test/*`, scripts de `package.json`, `.github/` | [tests.md](docs/agents/tests.md) ; section Commandes de ce fichier |
| une nouvelle marche à suivre récurrente | [recettes.md](docs/agents/recettes.md) |
| une nouvelle règle à ne pas enfreindre | « Règles à ne pas enfreindre » ci-dessus **et** le guide concerné |

Côté Claude Code, un hook `Stop` ([.claude/hooks/doc-sync.sh](.claude/hooks/doc-sync.sh))
refuse de clore un tour quand du code a changé sans aucun `.md`. Les autres
agents appliquent la règle d'eux-mêmes.

## Avant de rendre la main

1. `npm run typecheck` (les deux projets).
2. `npm run check`.
3. `npm run bench` si le moteur ou le rendu a bougé.
4. `npm run build` si des dépendances, index.html ou le CSS ont changé (budget
   de bundle).
5. La doc suit le code : voir « Documentation à tenir à jour » ci-dessus.
6. Ne pas commit, push ni déployer sans demande explicite.
