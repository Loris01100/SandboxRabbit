# Recettes

Les modifications courantes, pas à pas, avec ce qu'on oublie d'habitude. Après
chacune : `npm run typecheck && npm run check` (et `npm run bench` si le moteur
a bougé).

## Ajouter une matière

1. Une constante d'id dans [materials.ts](../../src/client/sim/materials.ts),
   à la suite (la dernière est `MAGNET = 46`). **Ne jamais renuméroter** : les
   ids sont écrits dans les mondes sauvegardés.
2. Son entrée dans `MATERIALS` : `id`, `name`, `kind`, `density`, `color`,
   `noise`, `hint` (en français), plus au besoin `flammable`, `life` (≤ 250),
   `spread`, `heat`, `spawn`, `boil`, `freeze`.
3. Son id dans **une** famille de `CATEGORIES` — ou nulle part si elle ne
   s'obtient qu'en jeu (comme la cire fondue).
4. Si son `kind` ne suffit pas : un `case` dans `Engine.update` et une méthode
   `updateXxx` (voir la recette suivante).
5. Un bloc d'`assert` dans [test/sim.ts](../../test/sim.ts) qui prouve son
   comportement. La forme de l'entrée est déjà relue par l'assert du
   registre : clé = `id`, `life` ≤ 250, couleur en trois canaux 0..255,
   `boil.into` / `freeze.into` connus et non bouclés, aucune matière dans deux
   familles.
6. Une ligne dans le tableau « Ce qui se passe quand on mélange » du
   [README](../../README.md), et mettre à jour le compte de matières en tête.

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
- L'empreinte de test/sim.ts va très probablement changer : voir
  [tests.md](tests.md#lempreinte-du-moteur).

## Ajouter un explosif

Lui trouver un **déclencheur** qui n'existe pas encore (voir
[simulation.md](simulation.md#explosifs--un-déclencheur-chacun)), réutiliser
`explode()` pour le souffle. S'il doit survivre à une chaîne, le préserver sur
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
2. Son câblage dans [main.ts](../../src/client/main.ts) via
   `document.querySelector<…>("#id")!`.
3. S'il change la simulation : `order({t:"set", k:{…}})` et un champ dans
   `Knobs`. S'il doit être retenu : l'ajouter au blob `sandbox-rabbit:reglages`
   (via `read` / `write` de ui.ts, jamais `localStorage` en direct).
4. Pas de `style=` ni de `<script>` en ligne (CSP) : passer par
   [style.css](../../src/client/style.css) ou le CSSOM.
5. Toute logique pure (calcul, parsing) va dans
   [ui.ts](../../src/client/ui.ts) avec son test dans test/ui.ts, pas dans
   main.ts.

## Ajouter un raccourci clavier

Le gestionnaire dans main.ts, et **une ligne** dans le `<dialog id="shortcuts">`
d'index.html — c'est la seule liste, nulle part ailleurs. Les raccourcis de
matière 1..9 / 0 viennent de `SHORTCUTS` (materials.ts) et la ligne d'aide
correspondante se remplit toute seule.

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
`npx wrangler d1 migrations apply sandbox-rabbit --remote`.

## Changer un binding Cloudflare

Modifier [wrangler.jsonc](../../wrangler.jsonc), mettre à jour `Env` dans
app.ts (binding optionnel `?` s'il est absent en local ou en test), puis
`npm run cf-typegen` pour régénérer `worker-configuration.d.ts`.

## Toucher au codec

À éviter. Si c'est indispensable : ajouter un bloc **en fin** de chaîne, lu
comme absent (valeur par défaut) par les mondes d'avant ; ne jamais changer le
sens d'un bloc existant. Vérifier dans test/sim.ts qu'une chaîne de l'ancien
format se relit toujours.
