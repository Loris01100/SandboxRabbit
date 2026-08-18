# Sandbox Rabbit

Un bac à sable cellulaire (« falling sand ») qui tourne entièrement dans le
navigateur, servi par un Worker Cloudflare qui héberge aussi l'API.

Vingt matières : `sable / eau / pierre / bois / huile / acide / lave / plante /
feu / glace / sel / eau salée / poudre / TNT / graine / nanites / verre /
source / fumée`, pinceau réglable, pause & pas à pas, sauvegarde de mondes.

### Ce qui se passe quand on mélange

| Règle | Effet |
| --- | --- |
| Chaleur | Un champ de température est diffusé à chaque tick. L'eau bout à 100 °C et gèle à 0, la glace fond, le sable vitrifie près de la lave, l'huile s'auto-enflamme. Une seule loi, tous les changements d'état en découlent (`boil` / `freeze` dans `materials.ts`). |
| TNT & poudre | La flamme déclenche l'explosion, l'explosion rallume les charges voisines : ça part en chaîne. |
| Sel | Se dissout dans l'eau (eau salée, plus lourde, gèle à -18 °C) et fait fondre la glace. |
| Graine | Tombe comme une poudre, germe en plante au contact de l'eau. |
| Nanites | Dévorent la matière et se répliquent, puis meurent de vieillesse. Seul le verre les arrête : on peut construire un bocal. |
| Source | Émet en continu la dernière matière sélectionnée avant elle (stockée dans `life`). |
| Feu | `flammable` est une probabilité **par tick et par flamme voisine** : la poudre part instantanément (1), l'huile s'embrase (0,6), la graine crépite (0,05), le bois met une seconde à prendre (0,02). C'est le seul réglage de vitesse de propagation. |
| Vitesse | Curseur ×0,25 à ×4 : nombre de ticks de simulation par frame, avec reliquat pour le ralenti et plafond à 8 ticks pour ne pas s'enliser. |
| Vent & gravité | Un curseur biaise la dérive horizontale, la touche `g` retourne la gravité. |
| Pinceau | Case « Ne pas remplacer » : on ne peint que le vide, la matière déjà posée est préservée (la gomme efface toujours). Clic maintenu = dépôt continu, même sans bouger la souris. |
| Lien | Le bouton « Lien » met le monde entier dans l'URL (RLE + base64, ~1 ko) et le copie. Ouvrir le lien recharge la scène. |

## Stack

| Morceau | Choix | Pourquoi |
| --- | --- | --- |
| Front | TypeScript + Vite, canvas 2D | 1 cellule = 1 pixel dans un `ImageData`, un seul `putImageData` par frame. ~0,2 ms par tick sur une grille 320×180. |
| Serveur | Worker Cloudflare + [Hono](https://hono.dev) | Un seul déploiement sert le site statique **et** l'API (`env.ASSETS`). |
| Stockage | Map en mémoire, D1 prêt derrière la même interface | Voir `src/worker/store.ts`. |

### Pages ou Workers ?

Les deux ne sont plus séparés : un Worker avec la clé `assets` sert les fichiers
statiques *et* le code serveur. C'est ce que Cloudflare recommande pour les
nouveaux projets, et ça évite d'avoir un projet Pages + un Worker à synchroniser.

### Et Rust ?

Rust sur Cloudflare passe par WebAssembly. Deux usages possibles :

1. **Le Worker en Rust** (`workers-rs`) — déconseillé ici : DX plus lourde,
   bindings D1/AI moins confortables, et le Worker ne fait que du routage JSON.
2. **Le noyau de simulation en Rust → WASM** — c'est là que ça devient
   intéressant : la boucle de `engine.ts` est un automate cellulaire sur des
   tableaux d'octets, exactement ce que WASM fait bien. `Engine` a été écrit avec
   cette frontière en tête : `cells` / `life` / `noise` sont des tableaux plats,
   le rendu ne fait que lire `cells`. Le jour où la grille passe à 1000×600 ou
   où plusieurs milliers d'agents bougent, on remplace l'intérieur de `Engine`
   par un module `wasm-bindgen` en gardant la même interface (`step`, `paint`,
   `cells`).

## Commandes

```bash
npm install
npm run dev        # http://localhost:5173 — front + Worker dans workerd, avec HMR
npm run typecheck  # client et worker ont chacun leur tsconfig (DOM vs runtime Workers)
npm run check      # auto-vérification de la simulation (Node exécute test/sim.ts tel quel)
npm run build
npm run preview    # build puis exécution du Worker en local
npm run deploy     # déploiement (npx wrangler login la première fois)
```

## API

| Route | Effet |
| --- | --- |
| `GET /api/health` | État + backend de stockage actif |
| `GET /api/worlds` | Liste des mondes (sans les données) |
| `GET /api/worlds/:id` | Un monde complet |
| `POST /api/worlds` | Sauvegarde `{ name, width, height, data }` |

`data` est la grille en RLE + base64 (`src/client/sim/codec.ts`) : un monde
320×180 pèse environ 1,3 ko.

## Étapes suivantes

**Base de données (D1)**

```bash
npx wrangler d1 create sandbox-rabbit           # récupérer le database_id
# décommenter la section d1_databases de wrangler.jsonc, y coller l'id
npx wrangler d1 migrations apply sandbox-rabbit --local
npx wrangler d1 migrations apply sandbox-rabbit --remote
npm run cf-typegen
```

`createStore()` bascule tout seul sur D1 dès que le binding existe : rien
d'autre à changer.

**Comportements IA**

Deux pistes distinctes, à ne pas confondre :

- *IA dans la simulation* — des créatures qui cherchent l'eau, fuient le feu,
  creusent. C'est de l'automate/pathfinding côté client, dans `engine.ts`, sans
  appel réseau.
- *IA générative côté Worker* — ajouter `"ai": { "binding": "AI" }` dans
  `wrangler.jsonc` donne accès à Workers AI depuis le Worker : générer une
  carte à partir d'une description, commenter ce que fait le joueur, etc.
  Le binding est déjà déclaré (optionnel) dans `Env`.

**Nouvelle matière** : une entrée dans `MATERIALS` + son id dans `PALETTE`. Si
son comportement n'est pas couvert par `kind` (`powder` / `liquid` / `gas` /
`static`), lui ajouter un `case` dans `Engine.update`.
