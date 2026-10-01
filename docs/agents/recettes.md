# Recettes

Les modifications courantes, pas à pas, avec ce qu'on oublie d'habitude. Après
chacune : `npm run typecheck && npm run check` (et `npm run bench` si le moteur
a bougé).

## Ajouter une matière

1. Une constante d'id dans [materials.ts](../../src/client/sim/materials.ts),
   à la suite (la dernière est `RUST = 56`). **Ne jamais renuméroter** : les
   ids sont écrits dans les mondes sauvegardés. Reporter l'id dans la table
   gelée `IDS` de [test/rules.ts](../../test/rules.ts), qui le réclame — c'est
   elle qui interdit la renumérotation.
2. Son entrée dans `MATERIALS` : `id`, `name`, `kind`, `density`, `color`,
   `noise`, `hint` (en français), plus au besoin `flammable`, `life` (≤ 250),
   `spread`, `heat`, `spawn`, `boil`, `freeze`.
3. Son id dans **une** famille de `CATEGORIES` — ou nulle part si elle ne
   s'obtient qu'en jeu (comme la cire fondue).
4. Si son `kind` ne suffit pas : un `case` dans `Engine.update` et une méthode
   `updateXxx` (voir la recette suivante). Une créature de plusieurs cellules
   ne part pas d'une matière simple : une `Shape` (offsets et matières, cœur
   d'abord), `creature` sur le cœur et `part` sur le reste, un `case` pour le
   cœur et un pour les parties (`updatePart(SHAPE, …)`), la forme choisie dans
   `paint()` / `rect()`. Le lapin et le héros en sont les deux exemples, décrits
   dans [simulation.md](simulation.md#créatures--le-lapin).
   Si elle agit sans que rien ne bouge autour d'elle (compteur, tirage qui
   finit par réussir) : `this.wake(i)` dans sa règle quand elle a de quoi agir
   (l'acide, le sel, la pile, l'aimant), ou, si elle agit à chaque tick quoi
   qu'il arrive (un compteur de vie), son id dans la liste `ACTIVE` d'engine.ts
   — les gaz et les créatures y sont d'office. Sinon son bloc s'endort et elle
   se fige (voir [Blocs de veille](simulation.md#blocs-de-veille)). Mesurer
   son pire cas : un bac 1920×1080 plein d'elle seule, `node --cpu-prof`.
5. Un bloc d'`assert` dans [test/sim.ts](../../test/sim.ts) qui prouve son
   comportement. La forme de l'entrée est déjà relue par l'assert du
   registre : clé = `id`, `life` ≤ 250, couleur en trois canaux 0..255,
   `boil.into` / `freeze.into` connus et non bouclés, aucune matière dans deux
   familles.
6. Si elle brille, ou si elle laisse passer la lumière alors que son `kind`
   est opaque (comme le verre) : une ligne `set(…)` dans `lighting()` de
   [render.ts](../../src/client/sim/render.ts). Sinon l'éclairage la traite
   d'après son `kind` : un solide ou une poudre fait de l'ombre, un liquide
   atténue, un gaz laisse passer.
7. Une ligne dans le tableau « Ce qui se passe quand on mélange » du
   [README](../../README.md), et, en tête, le compte de matières **et** son nom
   dans l'énumération : test/rules.ts compare cette liste à la palette.

Un changement d'état seul (fondre, geler, prendre) = `boil` / `freeze`, aucune
ligne dans le moteur. Voir le ciment ou le verre fondu.

## Ajouter ou modifier une règle du moteur

- Tirage au sort : `this.rand()`.
- Voisines : `for (let k = 0; k < 4; k++) { const nx = x + NX[k], ny = y + NY[k]; … }`.
- Mouvement : `this.tryMove(i, x, y + this.gravity, id)` et `this.drift()`.
- Transformer un voisin : `this.become(x, y, id)`, pas `set()`.
- Propriété lue à chaque cellule et chaque tick : une table dérivée (comme
  `DENSITY`) plutôt que `MATERIALS[id].xxx`.
- Relire le tableau des usages de `life` dans [simulation.md](simulation.md)
  avant d'y écrire.
- **Portée ≤ 15 cellules** autour de la cellule traitée, en lecture comme en
  écriture : au-delà, le damier multi-fils ne protège plus (voir « Plusieurs
  fils » dans [simulation.md](simulation.md)). Une explosion passe par
  `this.blast()`, pas `explode()`. test/pool.ts compare 1 et 4 fils : le
  lancer, et y ajouter la nouvelle matière si sa scène ne la réveille pas.
- Écrire directement dans `cells` / `life` / `temp` (hors `set`, `swap`,
  `convert`…) : `this.wake(i)` à côté, sinon le bloc voisin endormi ne le voit
  pas. Une règle qui agit sans changement autour : `this.wake(i)` quand elle a
  de quoi agir, ou son id dans `ACTIVE` si elle agit à chaque tick.
- L'empreinte de test/sim.ts va très probablement changer : voir
  [tests.md](tests.md#lempreinte-du-moteur).

## Ajouter un explosif

Lui trouver un **déclencheur** qui n'existe pas encore (voir
[simulation.md](simulation.md#explosifs--un-déclencheur-chacun)), réutiliser
`explode()` pour le souffle : sa règle appelle `this.blast(x, y)`, et son rayon
va dans la table `BLAST` d'engine.ts (+ 256 pour des retombées) — sans sa ligne,
sa demande est ignorée. S'il doit survivre à une chaîne, le préserver sur
le pourtour d'`explode()` comme `TNT` et `C4`.

## Ajouter un défi

**Sans code** : sauvegarder un monde avec un objectif depuis l'UI (`goal` de la
forme `ge:<id>:<n>` ou `lt:<id>:<n>`). Il apparaît dans la galerie marqué 🎯.

**En code**, pour une scène ou une condition qu'un compte de cellules
n'exprime pas : une entrée dans `CHALLENGES` de
[challenges.ts](../../src/client/challenges.ts) :

```ts
{
  name: "Nom affiché",
  goal: "Phrase d'objectif affichée au joueur.",
  build(e) { /* bâtir la scène en 320×180 avec floor(), block(), e.set()… */ },
  won(e) { return count(e, PLANT) >= 400; },
}
```

Les boutons, le chrono, le record et la détection (toutes les 500 ms, dans le
Worker) sont génériques. test/sim.ts construit déjà chaque défi : vérifier
qu'il ne démarre pas gagné. Mettre à jour la liste des défis du README.
**Ajouter son nom à `TRIALS`** d'[app.ts](../../src/worker/app.ts), la liste
des défis qui ont un classement : test/api.ts échoue tant qu'elle diffère de
`CHALLENGES`. `build` ne doit pas tirer au sort : le juge du classement
(sim/verdict.ts) le rebâtit dans un moteur neuf et compare la grille au
départ du rejeu.
`scene()` de sandbox.ts bâtit un défi à 20 °C (`AMBIENT`), l'ambiante du
panneau rendue ensuite : `build` n'a pas à s'en soucier.

Un **décor** sans objectif (bouton « Surprise ») : même forme dans `SCENES`,
sans `goal` ni `won`.

## Ajouter un geste (une nouvelle façon de modifier la grille)

1. Une variante dans le type `Gesture` de
   [gestures.ts](../../src/client/gestures.ts) — une valeur JSON sérialisable.
2. Son `case` dans `applyGesture(engine, g)`. **Les champs viennent peut-être
   d'un pair de salon** : filtrer les ids par `known()`, borner les tailles.
3. Côté page, l'émettre par `gesture(g)` de main.ts, jamais par
   `order({t:"do"})` direct — sinon le salon ne le voit pas.

Il est alors automatiquement annulable (si main.ts demande un `snapshot`
avant), enregistré, rejoué et relayé.

## Ajouter un ordre ou une nouvelle page ↔ bac

1. Une variante dans `Order` ou `News` de
   [sim/sandbox.ts](../../src/client/sim/sandbox.ts).
2. Le `case` dans `Sandbox.order()` (ou l'envoi dans `frame()`).
3. Côté page : `order(...)` / `listen(...)` via world.ts. Si la page doit
   attendre une réponse, suivre le modèle `askLoad` / `askClip` (numéro `ask`
   + `reply`).
4. Un bloc dans [test/sandbox.ts](../../test/sandbox.ts) : `new Sandbox(W, H,
   (n) => news.push(n))`, puis `sim.order(...)`, `sim.frame(16)`, et des
   asserts sur `news`.

Rappel : ce qui transite est cloné (clone structuré), pas partagé.

## Ajouter un contrôle au panneau

1. L'élément dans [index.html](../../index.html), dans le bon
   `<details class="group">`. Un réglage = une `.row` (libellé / contrôle /
   valeur) ; une case à cocher = une `.check`.
2. Son câblage dans [settings.ts](../../src/client/settings.ts) via
   `document.querySelector<…>("#id")!`, exporté si main.ts le lit.
3. S'il change la simulation : `set({…})` de world.ts et un champ dans
   `Knobs`. S'il doit être retenu : l'ajouter à `SAVED` (settings.ts), qui
   l'écrit dans le blob `sandbox-rabbit:reglages` et le rejoue à `restore()`.
   Le blob range chaque réglage sous l'`id` de son contrôle : **renommer cet
   `id`**, c'est ajouter `"nouvel-id": ["ancien-id"]` à `RENAMED`
   (settings.ts), sinon le réglage repart au défaut chez tous ceux qui
   l'avaient changé.
4. Pas de `style=` ni de `<script>` en ligne (CSP) : passer par
   [style.css](../../src/client/style.css) ou le CSSOM.
5. Toute logique pure (calcul, parsing) va dans
   [ui.ts](../../src/client/ui.ts) avec son test dans test/ui.ts, pas dans
   main.ts.

## Ajouter un raccourci clavier

Tout raccourci clavier est une **action réassignable** :

1. Son nom dans `ACTIONS` et sa touche dans `DEFAULT_BINDINGS`
   ([ui.ts](../../src/client/ui.ts)). Une combinaison s'écrit `Ctrl+z`
   (`combo()` : Cmd vaut Ctrl, Maj ne compte qu'avec Ctrl ou Alt).
2. Son libellé dans `ACTION_NAMES` (ui.ts), et l'action dans l'encadré qui
   lui correspond de `KEY_GROUPS` (ui.ts) : la ligne de la fenêtre des
   raccourcis se fait seule, avec le bouton pour la changer. test/ui.ts
   vérifie qu'elle n'est oubliée dans aucun encadré et que sa touche
   d'origine n'est pas déjà prise.
3. Son `case` dans le `switch` du gestionnaire `keydown` de main.ts, qui lit
   `bound[combo(e)]` — jamais `e.key` directement, sinon la touche ne se
   réassigne pas. Une action tenue (qui agit tant que la touche l'est) va
   plutôt dans `MOVES` (view.ts) ou `STEER` (hero.ts).
4. Un assert dans [test/ui.ts](../../test/ui.ts) si la touche d'origine a une
   subtilité (combinaison, conflit).

Un geste de souris n'est pas réassignable : une ligne `mouse` dans l'encadré
de `KEY_GROUPS` qui lui correspond.

## Ajouter une route d'API

1. La route dans [src/worker/app.ts](../../src/worker/app.ts), avant le
   `app.all("/api/*")` final. **Pas d'import de `cloudflare:workers`** dans ce
   fichier.
2. Écriture ouverte au public ? Commencer par `if (await flooding(c)) return …429`.
3. Valider le corps en entier avant de toucher au store (types, tailles).
4. Si le store doit changer : la méthode dans l'interface `Store` **et** dans
   les deux implémentations (mémoire et D1). Nommer les colonnes des `SELECT`
   (le `token` ne doit jamais sortir).
5. Des asserts dans [test/api.ts](../../test/api.ts) via
   `app.request(path, init, env)`.
6. Mettre à jour le tableau de l'API dans le README.

## Changer le schéma D1

Un nouveau fichier `migrations/000N_quoi.sql` (commentaire en tête : la
commande d'application, et pourquoi). Jamais de retouche d'une migration
existante. Les colonnes ajoutées doivent tolérer les lignes existantes (`NULL`
ou `DEFAULT`). Puis, au déploiement :
`npx wrangler d1 migrations apply sandbox-rabbit --remote`. En local aussi,
`--local` : `npm run dev` et `npm run preview` ont leur propre D1, et une
route sur une table absente y répond 500.

## Changer un binding Cloudflare

Modifier [wrangler.jsonc](../../wrangler.jsonc), mettre à jour `Env` dans
app.ts (binding optionnel `?` s'il est absent en local ou en test), puis
`npm run cf-typegen` pour régénérer `worker-configuration.d.ts`.

## Toucher au codec

À éviter. Si c'est indispensable : ajouter un bloc **en fin** de chaîne, lu
comme absent (valeur par défaut) par les mondes d'avant ; ne jamais changer le
sens d'un bloc existant. Vérifier dans test/sim.ts qu'une chaîne de l'ancien
format se relit toujours.

## Décoder une pile de production

Un rapport d'erreur (journaux du Worker, filtre `message = "erreur joueur"`)
cite le bundle minifié : `index-AbC123.js:1:48213`.

1. Se placer sur **le commit déployé** : les cartes de sources ne sont
   jamais publiées, on reconstruit le même code. Le nom haché du fichier le
   garantit — `npm run pile` dit quand un fichier cité manque au build.
2. Copier la pile dans un fichier, puis `npm run pile < pile.txt`
   ([test/pile.ts](../../test/pile.ts)) : il lance `vite build` avec
   `SOURCEMAP=hidden`, lit les cartes des fichiers cités, **les efface** de
   `dist/`, et réécrit chaque ligne avec son `fichier.ts:ligne:colonne`.
   Sous Windows, passer par l'entrée standard : npm coupe un argument à son
   premier saut de ligne.

Ce qu'on oublie : `dist/` est alors un build de ce commit-là. Ne pas lancer
`wrangler deploy` dessus sans `npm run build` ; et ne jamais garder une carte
dans `dist/` (`hidden` n'empêche que le lien vers elle, pas son envoi).
