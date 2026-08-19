# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Langue

Le README, les commentaires du code et l'UI sont en français. Écrire les nouveaux commentaires et libellés en français pour rester cohérent.

## Commandes

```bash
npm run bench      # chronomètre le moteur (300 ticks) sur les trois tailles de grille
npm run dev        # Vite + Worker dans workerd (http://localhost:5173), HMR
npm run typecheck  # DEUX projets tsc : tsconfig.json (client/DOM) + tsconfig.worker.json (Worker)
npm run build      # typecheck puis vite build
npm run preview    # build puis `wrangler dev` sur le bundle
npm run deploy
npm run cf-typegen # régénère worker-configuration.d.ts après un changement de bindings
npm run check      # asserts sur la simulation (test/sim.ts) et sur l'API (test/api.ts), exécutés par Node
```

Pas de framework de test : [test/sim.ts](test/sim.ts) et [test/api.ts](test/api.ts) sont des scripts d'`assert`, lancés directement par Node (exécution native du TypeScript, d'où les imports en `.ts` dans `src/client/sim` et `src/worker`). `test/api.ts` interroge le Worker en mémoire via `app.request()` de Hono : ni serveur, ni wrangler, et sans binding `DB` c'est le store mémoire qui répond.

## Architecture

Un seul Worker Cloudflare sert le site statique **et** l'API (binding `ASSETS`, `not_found_handling: single-page-application`). Pas de projet Pages séparé.

- [src/worker/app.ts](src/worker/app.ts) — routes Hono `/api/*`, puis fallback `app.get("*")` vers `env.ASSETS`. L'interface `Env` y est définie. **Aucun import de `cloudflare:workers` ici** : c'est ce qui permet à [test/api.ts](test/api.ts) de charger l'API dans Node.
- [src/worker/index.ts](src/worker/index.ts) — l'entrée du Worker : `fetch` délégué à `app`, le `scheduled` du ménage nocturne, et le réexport de la classe `Room`.
- [src/worker/room.ts](src/worker/room.ts) — le Durable Object du bac partagé. Il **relaie, il ne simule pas** : le premier connecté est l'hôte et sa grille fait foi. Faire simuler chaque client ferait diverger les scènes (le moteur tire au sort à chaque tick).
- [src/worker/store.ts](src/worker/store.ts) — `createStore(env)` renvoie l'implémentation D1 si `env.DB` existe, sinon une `Map` en mémoire (bouchon : vit dans l'isolate, non partagé). Activer D1 = créer la base, décommenter le bloc `d1_databases`, appliquer [migrations/0001_worlds.sql](migrations/0001_worlds.sql) ; aucun code à changer.
- [src/client/sim/engine.ts](src/client/sim/engine.ts) — l'automate cellulaire. État = tableaux plats (`cells`, `life`, `clock`, `noise`), pas d'objets par cellule : c'est délibéré, pour pouvoir remplacer l'intérieur d'`Engine` par un module Rust/WASM en gardant l'interface (`step`, `paint`, `cells`).
- [src/client/sim/render.ts](src/client/sim/render.ts) — 1 cellule = 1 pixel dans un `ImageData`, un seul `putImageData` par frame, mise à l'échelle via CSS `image-rendering: pixelated`. Ne pas introduire de dessin par cellule. `renderer.heatmap` bascule sur un rendu de `temp` (même boucle, autre palette).
- [src/client/sim/codec.ts](src/client/sim/codec.ts) — RLE + base64 ; format partagé avec la colonne `data` de D1. Toute modification du codec casse les mondes déjà sauvegardés.
- [src/client/main.ts](src/client/main.ts) — DOM impératif, aucun framework UI. La galerie est un `<dialog>` ouvert en `showModal()` ; `GET /api/worlds` ramène les grilles, dont la galerie fait ses vignettes (`thumbnail()` dans `render.ts`) — une seule requête. Le tri (date / vues) se fait sur cette liste, côté client. Cliquer une carte charge par `GET /api/worlds/:id` : c'est le seul chemin qui compte une vue (`store.see`), donc le raccourci « charger depuis la copie en main » ferait retomber le compteur à zéro. Les éléments viennent de [index.html](index.html) via `querySelector` non-null (`!`) : ajouter un contrôle = ajouter l'élément dans le HTML **et** son câblage ici. Le panneau est fait de `<details class="group">` repliables (natif, aucun JS) ; un réglage = une `.row` (libellé / contrôle / valeur, colonnes alignées) ou une `.check` pour une case à cocher.

### Invariants de la simulation

- `temp` (°C) est diffusé à chaque tick par `thermal()` ; `heat` tire la cellule vers sa température (feu, lave, glace) sans l'imposer, `boil`/`freeze` déclenchent les changements d'état. Ajouter un changement d'état = deux champs dans `MATERIALS`, aucune règle dans `Engine`.
- `gravity` (±1) et `wind` (-1..1) sont lus par les règles de mouvement : toute nouvelle règle de déplacement doit passer par `y + this.gravity` et `drift()`. Seule exception assumée : `MAGNET`, qui déplace la limaille d'un cran vers lui — c'est tout son intérêt.
- `ambient` (°C) est la température vers laquelle `thermal()` ramène tout le bac : c'est un réglage de scène, pas une constante. `AMBIENT` n'en est que la valeur par défaut. Le baisser sous 0 gèle l'eau sans y toucher.
- `life` sert de vie pour les gaz, de compteur de chute pour `NITRO`, d'amorçage pour `C4`, de ticks de combustion pour `THERMITE`, de charge utile pour `SOURCE` (la matière émise), de mèche allumée pour `CANDLE` et de repos pour `METAL`, d'emballement pour `URANIUM` : ne pas le réinitialiser à l'aveugle. C'est un `Uint8Array`, donc `life` ≤ 250 dans `MATERIALS`.
- Un explosif se distingue par son **déclencheur**, pas par son rayon : feu (`TNT`), choc (`NITRO`), étincelle (`C4`), poids (`MINE`), volume (`FIREDAMP` via `flammable`), masse (`URANIUM`, qui compte ses voisins identiques et n'a besoin de rien d'extérieur). Ajouter un explosif de plus = ajouter un déclencheur, sinon c'est du TNT repeint.
- `explode()` projette (`hurl()`) au lieu d'effacer, et traite le disque **du bord vers le centre** : inverser cet ordre ferait partir les cellules vers des places pas encore libérées. `hurl()` ne dépose que sur du vide, donc la matière est conservée ; quand le rayon est bouché, l'appelant pulvérise — c'est ce repli qui garde le pouvoir de percer un mur.
- `explode()` préserve `TNT` et `C4` sur son pourtour, sinon une chaîne s'annule elle-même : le TNT repart par le feu semé, le C4 par `life` = 1 (il ne réagit pas aux flammes).
- `URANIUM` doit rester désamorçable : casser le tas fait redescendre `life`, donc ne jamais rendre l'emballement irréversible. Sa chaleur est le seul avertissement avant le souffle. Le nucléaire ne se distingue du TNT que par les retombées (`FALLOUT`) semées par `nuke()` : les retirer en referait un gros TNT.
- Le `boil` du pétrole est à 200 °C **exprès** : à 80 °C une flamme voisine suffisait, ce qui en refaisait de l'huile. Le pétrole ne réagit qu'à une vraie source de chaleur, et c'est le grisou libéré qui explose, pas lui.
- La pierre fond au-delà de 1400 °C. C'est calibré : une nappe de lave ne chauffe la roche voisine qu'à ~800 °C, donc seule la thermite (2800 °C) peut creuser. Baisser ce seuil ferait fondre le décor de toutes les scènes de lave.
- `SPARK` ne se propage que dans `METAL`, et le métal traversé garde `RECOVERY` ticks de repos : sans ça l'étincelle repart en arrière et le circuit ne s'éteint jamais. Tout ce qui met un fil sous tension passe par `charge()` (étincelle, `BATTERY`, `SWITCH` fermé).
- `SWITCH` ne devient **jamais** une étincelle : il la relaie à ses voisins (`life` = 1 quand il est fermé). S'il se changeait en `SPARK`, il redeviendrait du `METAL` à l'extinction et l'interrupteur disparaîtrait de la grille.
- Le balayage de `step()` part du bas et alterne le sens en x selon `parity` ; `clock` empêche une cellule de bouger deux fois dans le même tick. Toucher à cet ordre introduit des dérives visibles de la matière.
- `frozen` (1 par cellule) court-circuite tout : `step()` saute la cellule et `tryMove()` refuse de s'y déplacer. `set()` la remet à 0, donc repeindre libère.
- Hors grille, `get()` renvoie `STONE` (mur implicite) — les règles n'ont pas besoin de tester les bords.
- `MATERIALS` est indexé par id numérique. `CATEGORIES` fixe les familles repliables de la barre d'outils et `PALETTE` en découle (`flatMap`) ; les raccourcis clavier 1..9 / 0 vivent à part dans `SHORTCUTS`, pour que réordonner une famille ne les déplace pas.

### Ajouter un défi

Deux voies. Sans code : sauvegarder un monde avec un objectif (`goal`, du type `ge:12:600`) — il devient un défi jouable dans la galerie, `challengeOf()` dans main.ts en fabrique le `Challenge`. En code, pour une scène ou une condition qu'un simple compte de cellules n'exprime pas :

Une entrée dans `CHALLENGES` ([src/client/challenges.ts](src/client/challenges.ts)) : `build(engine)` construit la scène en code (pas de monde encodé), `won(engine)` lit la grille. Les boutons et la détection de victoire (une fois par demi-seconde, dans la boucle de rendu) sont génériques.

### Ajouter une matière

Une entrée dans `MATERIALS` + son id dans une famille de `CATEGORIES` ([materials.ts](src/client/sim/materials.ts)) — l'omettre partout est valide : la matière n'est alors obtenue qu'en jeu. Si son `kind` (`powder` / `liquid` / `gas` / `static`) ne suffit pas, ajouter un `case` dans `Engine.update`.
