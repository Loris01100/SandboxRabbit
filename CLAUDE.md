# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Langue

Le README, les commentaires du code et l'UI sont en français. Écrire les nouveaux commentaires et libellés en français pour rester cohérent.

## Commandes

```bash
npm run dev        # Vite + Worker dans workerd (http://localhost:5173), HMR
npm run typecheck  # DEUX projets tsc : tsconfig.json (client/DOM) + tsconfig.worker.json (Worker)
npm run build      # typecheck puis vite build
npm run preview    # build puis `wrangler dev` sur le bundle
npm run deploy
npm run cf-typegen # régénère worker-configuration.d.ts après un changement de bindings
npm run check      # asserts sur les règles de simulation (test/sim.ts, exécuté par Node)
```

Pas de framework de test : [test/sim.ts](test/sim.ts) est un script d'`assert`, lancé directement par Node (exécution native du TypeScript, d'où les imports en `.ts` dans `src/client/sim`).

## Architecture

Un seul Worker Cloudflare sert le site statique **et** l'API (binding `ASSETS`, `not_found_handling: single-page-application`). Pas de projet Pages séparé.

- [src/worker/index.ts](src/worker/index.ts) — routes Hono `/api/*`, puis fallback `app.get("*")` vers `env.ASSETS`. L'interface `Env` y est définie ; `DB` et `AI` sont optionnels car leurs bindings sont commentés dans [wrangler.jsonc](wrangler.jsonc).
- [src/worker/store.ts](src/worker/store.ts) — `createStore(env)` renvoie l'implémentation D1 si `env.DB` existe, sinon une `Map` en mémoire (bouchon : vit dans l'isolate, non partagé). Activer D1 = créer la base, décommenter le bloc `d1_databases`, appliquer [migrations/0001_worlds.sql](migrations/0001_worlds.sql) ; aucun code à changer.
- [src/client/sim/engine.ts](src/client/sim/engine.ts) — l'automate cellulaire. État = tableaux plats (`cells`, `life`, `clock`, `noise`), pas d'objets par cellule : c'est délibéré, pour pouvoir remplacer l'intérieur d'`Engine` par un module Rust/WASM en gardant l'interface (`step`, `paint`, `cells`).
- [src/client/sim/render.ts](src/client/sim/render.ts) — 1 cellule = 1 pixel dans un `ImageData`, un seul `putImageData` par frame, mise à l'échelle via CSS `image-rendering: pixelated`. Ne pas introduire de dessin par cellule.
- [src/client/sim/codec.ts](src/client/sim/codec.ts) — RLE + base64 ; format partagé avec la colonne `data` de D1. Toute modification du codec casse les mondes déjà sauvegardés.
- [src/client/main.ts](src/client/main.ts) — DOM impératif, aucun framework UI. Les éléments viennent de [index.html](index.html) via `querySelector` non-null (`!`) : ajouter un contrôle = ajouter l'élément dans le HTML **et** son câblage ici. Le panneau est fait de `<details class="group">` repliables (natif, aucun JS) ; un réglage = une `.row` (libellé / contrôle / valeur, colonnes alignées) ou une `.check` pour une case à cocher.

### Invariants de la simulation

- `temp` (°C) est diffusé à chaque tick par `thermal()` ; `heat` tire la cellule vers sa température (feu, lave, glace) sans l'imposer, `boil`/`freeze` déclenchent les changements d'état. Ajouter un changement d'état = deux champs dans `MATERIALS`, aucune règle dans `Engine`.
- `gravity` (±1) et `wind` (-1..1) sont lus par les règles de mouvement : toute nouvelle règle de déplacement doit passer par `y + this.gravity` et `drift()`.
- `life` sert de vie pour les gaz **et** de charge utile pour `SOURCE` (la matière émise) : ne pas le réinitialiser à l'aveugle.
- Le balayage de `step()` part du bas et alterne le sens en x selon `parity` ; `clock` empêche une cellule de bouger deux fois dans le même tick. Toucher à cet ordre introduit des dérives visibles de la matière.
- Hors grille, `get()` renvoie `STONE` (mur implicite) — les règles n'ont pas besoin de tester les bords.
- `MATERIALS` est indexé par id numérique, et `PALETTE` fixe l'ordre de la barre d'outils *et* les raccourcis clavier 1..9 / 0.

### Ajouter une matière

Une entrée dans `MATERIALS` + son id dans `PALETTE` ([materials.ts](src/client/sim/materials.ts)). Si son `kind` (`powder` / `liquid` / `gas` / `static`) ne suffit pas, ajouter un `case` dans `Engine.update`.
