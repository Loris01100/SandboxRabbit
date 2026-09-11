# Tests, budgets et CI

## Les commandes

| Commande | Ce qu'elle vérifie |
| --- | --- |
| `npm run typecheck` | **deux** projets tsc : `tsconfig.json` (client, lib DOM) et `tsconfig.worker.json` (Worker, types générés, pas de DOM) |
| `npm run check` | les quatre scripts d'`assert`, dans l'ordre : sim, ui, api, sandbox |
| `npm run bench` | le tick du moteur sur 320×180, 480×270, 640×360 ; échoue au-delà du budget |
| `npm run build` | typecheck puis `vite build` (sortie dans `dist/`) |
| `npm run loc` | taille du projet par poste |

Il n'y a **pas de framework de test** ni de linter. Node ≥ 24 exécute le
TypeScript directement.

| Script | Couvre | Charge |
| --- | --- | --- |
| [test/sim.ts](../../test/sim.ts) | règles du moteur, registre, codec, défis, gestes, rejeu, empreinte | `Engine`, `codec`, `gestures`, `replay`, `challenges` |
| [test/ui.ts](../../test/ui.ts) | logique pure du panneau | `ui.ts` |
| [test/api.ts](../../test/api.ts) | routes, validation, jetons, en-têtes, cache, routage des messages du salon | `app.ts` via `app.request()` (store mémoire, pas de wrangler), `relay.ts` |
| [test/sandbox.ts](../../test/sandbox.ts) | protocole ordres / nouvelles | `Sandbox` avec un rappel `send` qui empile |

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

Le test de rejeu qui suit vérifie qu'une partie enregistrée retombe sur la
même grille dans un moteur neuf : il casse si une modification de la grille
échappe à `Recorder` (voir `stamp()` dans [simulation.md](simulation.md)).

## Budgets surveillés par la CI

[.github/workflows/ci.yml](../../.github/workflows/ci.yml), à chaque push et PR,
Node 24 :

1. `npm ci`
2. `npm audit --omit=dev --audit-level=high` — seules les dépendances livrées
   au navigateur comptent (aujourd'hui : `hono`).
3. `npm run build`
4. `npm run check`
5. `npm run bench` — **tick ≤ 4 ms en 320×180** (surchargeable par
   `BENCH_BUDGET_MS`). Le budget attrape un effondrement, pas une dérive. La
   mesure dépend beaucoup de la charge de la machine (de 2,8 à 5 ms d'une
   exécution à l'autre sur un poste occupé) : relancer avant de conclure à une
   régression.
6. **Bundle JS + CSS ≤ 81 920 octets** non compressés (`dist/client/assets`).
   Pas de framework, pas de dépendance client ajoutée à la légère.

Les actions sont épinglées par SHA et le workflow n'a que `contents: read` :
garder ces deux propriétés en modifiant la CI.

## Ce qui n'est pas testé automatiquement

main.ts, world.ts, room.ts (client), share.ts, theme.ts et le Durable Object
tiennent au DOM ou au runtime Cloudflare (le routage du salon, lui, est sorti
dans relay.ts et testé). Pour eux : `npm run dev`
(http://localhost:5173, Vite + Worker dans workerd, store mémoire) et vérifier
dans le navigateur. Le salon partagé se teste avec deux onglets sur le même nom
de salon.
