# Sandbox Rabbit

Un bac à sable cellulaire (« falling sand ») qui tourne entièrement dans le
navigateur, servi par un Worker Cloudflare qui héberge aussi l'API.

Quarante-trois matières, rangées en familles repliables (terrain, liquides,
inflammable, explosifs, froid, vivant, électricité, gaz, outils) : `sable / eau /
pierre / bois / huile / goudron / alcool / acide / lave / plante / feu / glace /
neige / azote liquide / sel / eau salée / poudre / TNT / nitroglycérine / C4 /
mine / thermite / uranium / grisou / retombées / pétrole / graine / nanites / verre / verre fondu / mercure /
cire / bougie / boue / braise / métal / pile / interrupteur / étincelle /
source / fumée`, pinceau réglable, vue thermique, pause & pas à pas, galerie de
mondes partagés.

### Ce qui se passe quand on mélange

| Règle | Effet |
| --- | --- |
| Chaleur | Un champ de température est diffusé à chaque tick. L'eau bout à 100 °C et gèle à 0, la glace fond, le sable vitrifie près de la lave, l'huile s'auto-enflamme. Une seule loi, tous les changements d'état en découlent (`boil` / `freeze` dans `materials.ts`). |
| TNT & poudre | La flamme déclenche l'explosion, l'explosion rallume les charges voisines : ça part en chaîne. |
| Souffle | Une explosion ne se contente plus d'effacer un disque : elle **projette**. Chaque cellule part le long de son rayon et se dépose sur la dernière place libre rencontrée — les débris d'une charge enterrée ressortent donc par le cratère au lieu de s'écraser dans la roche voisine, et deux projections ne peuvent pas atterrir au même endroit, donc la matière est conservée. Le disque est traité du bord vers le centre, pour que chacune parte vers une place déjà libérée. Ce qui n'a nulle part où aller (un mur plein) est pulvérisé comme avant : sans ce repli, une charge ne percerait plus rien. À l'air libre, un souffle détruit ainsi deux fois moins de matière qu'enterré — il la déplace. |
| Explosifs | Cinq matières, cinq **déclencheurs** différents — c'est là qu'est la variété, pas dans le rayon de souffle. La nitroglycérine obéit au choc : `life` compte ses cellules de chute et l'atterrissage au-delà de quatre détonne, la poser à la main ne risque rien. Le C4 ignore le feu et n'obéit qu'à l'étincelle : une charge amorcée par la détonation d'une voisine (`life` = 1) fait partir un mur entier, ce qui donne enfin un usage à la pile et à l'interrupteur. Le grisou obéit au volume : gaz `flammable` 1, il s'accumule au plafond puis toute la nappe part d'un coup. La mine obéit au poids, mais seulement de ce qui coule (`kind` poudre ou liquide) : on peut donc la murer. |
| Nucléaire | Le seul explosif sans mise à feu : **sa masse est son déclencheur**. Un grain d'uranium isolé se contente de tiédir (60 °C, c'est un chauffage) ; dès qu'une cellule a trois voisins d'uranium, elle s'emballe — un compteur monte dans `life`, la température avec lui (jusqu'à ~750 °C, la matière pâlit et la vue thermique voit venir le coup), et au bout de 120 ticks c'est un souffle de rayon 16. Casser le tas fait redescendre le compteur : c'est la seule parade, et elle se joue à la souris. Ce qui reste distingue le nucléaire d'un gros TNT : les **retombées**, un gaz qui traîne 250 ticks et où rien de vivant ne tient. |
| Pétrole | Il ne brûle pas. Une flamme posée dessus ne fait rien du tout — il faut le **chauffer** (200 °C, c'est-à-dire la lave ou la thermite, pas une allumette) et il se change alors en grisou. C'est le gaz qui explose, pas le liquide : une poche scellée sous la roche se remplit, et attend l'étincelle. |
| Thermite | L'anti-explosif : elle ne souffle rien, elle perce. Elle impose 2800 °C sur place pendant 150 ticks, ce qui liquéfie la pierre (`boil` à 1400 °C, hors de portée de la lave qui plafonne à 800 °C dans la roche voisine), et elle continue de tomber en brûlant — densité 8, elle passe sous la lave qu'elle vient de créer. D'où un vrai puits, et pas un cratère. |
| Sel | Se dissout dans l'eau (eau salée, plus lourde, gèle à -18 °C) et fait fondre la glace. |
| Graine | Tombe comme une poudre, germe en plante au contact de l'eau. |
| Nanites | Dévorent la matière et se répliquent, puis meurent de vieillesse. Seul le verre les arrête : on peut construire un bocal. |
| Source | Émet en continu la dernière matière sélectionnée avant elle (stockée dans `life`). |
| Feu | `flammable` est une probabilité **par tick et par flamme voisine** : la poudre part instantanément (1), l'huile s'embrase (0,6), la graine crépite (0,05), le bois met une seconde à prendre (0,02). C'est le seul réglage de vitesse de propagation. |
| Mercure | Densité 13 : passe sous tout, même sous la pierre en train de couler. Gèle en métal à -39 °C, s'évapore à 357. |
| Cire & bougie | La cire fond à 60 °C, coule, puis redurcit sous 55 : on peut faire couler une bougie. La bougie, elle, s'allume au contact d'une flamme (`life` = mèche allumée), réalimente sa flamme indéfiniment, et l'eau la souffle. |
| Azote liquide | `heat` -190 : il gèle l'eau en glace au contact, fige tout ce qu'il touche, et s'évapore en buée dès qu'il retrouve plus chaud que -60 °C. Le pendant froid de la lave, sauf qu'il ne dure pas. |
| Neige | Poudre froide (`heat` -12) plus légère que l'eau : elle s'amoncelle, flotte, et fond dès 2 °C. |
| Boue | Liquide lent et lourd qui engloutit, et sèche en sable au-dessus de 60 °C. |
| Braise | Le bois brûlé passe une fois sur deux par la braise au lieu de disparaître : le foyer continue de chauffer (350 °C) et de rallumer bien après la flamme. |
| Électricité | L'étincelle ne circule que dans le métal, à la vitesse d'un tick. Elle enflamme et fait sauter le TNT à l'autre bout du fil. Le métal traversé se repose 8 ticks, sinon l'étincelle rebondirait sans fin. |
| Pile & interrupteur | La pile envoie une étincelle dans le métal voisin toutes les 24 frames, sans fin. L'interrupteur relaie l'étincelle quand il est fermé (il s'éclaircit) et coupe le circuit quand il est ouvert : cliquer dessus, avec l'interrupteur sélectionné, le bascule. De quoi câbler un vrai circuit plutôt qu'une étincelle lâchée à la main. |
| Goudron | Huile lourde, `spread` 0 : elle coule à peine et brûle longtemps. |
| Alcool | Le plus léger des liquides : il flotte sur tout, s'enflamme d'un rien (0,9) et s'évapore dès 40 °C. |
| Verre fondu | Le verre refond au-dessus de 700 °C, coule, puis se fige sous 600 : sable → verre → verre fondu → verre, sans une ligne de règle dans le moteur. |
| Vue thermique | Case à cocher ou touche `h` : affiche `temp` au lieu de la matière, bleu pour le froid, corps noir jusqu'au blanc à 1200 °C. |
| Vitesse | Curseur ×0,25 à ×4 : nombre de ticks de simulation par frame, avec reliquat pour le ralenti et plafond à 8 ticks pour ne pas s'enliser. |
| Vent & gravité | Un curseur biaise la dérive horizontale, la touche `g` retourne la gravité. |
| Figer | L'outil « Figer » (touche `f`) immobilise la matière sous le pinceau : elle garde son identité et sa couleur (tramée en damier), mais aucune règle ne s'applique plus et rien ne peut la pousser. « Libérer » la rend à la gravité, repeindre par-dessus aussi. De quoi bâtir une structure en sable ou suspendre une cascade. |
| Annuler | Bouton « Annuler » ou `Ctrl+Z` : un cran, revient à l'état d'avant le dernier geste (coup de pinceau, remplissage, « Vider », chargement d'un monde ou d'un défi). Une copie des quatre tableaux de la grille, pas une pile d'historique. |
| Ligne & remplissage | `Maj` + clic trace une ligne droite depuis le dernier point posé, clic droit remplit toute la poche de matière identique sous le curseur. |
| Défis | Quatre scènes prêtes à jouer (Débâcle, Mèche lente, Court-circuit, Jardin) avec leur objectif et sa détection de victoire, construites en code dans `challenges.ts`. |
| Familles | La barre d'outils est découpée en `<details>` repliables (`CATEGORIES` dans `materials.ts`) : une famille ouverte à la fois suffit à tenir dans le panneau. Les raccourcis 1..9 / 0 restent sur les dix classiques, indépendamment de l'ordre d'affichage. |
| Pinceau | Case « Ne pas remplacer » : on ne peint que le vide, la matière déjà posée est préservée (la gomme efface toujours), case « Gomme sélective » : la gomme ne retire que la dernière matière choisie. Clic maintenu = dépôt continu, même sans bouger la souris. |
| Lien | Le bouton « Lien » met le monde entier dans l'URL (RLE + base64, ~1 ko) et le copie. Ouvrir le lien recharge la scène. |
| Galerie | « Sauvegarder » envoie le monde au Worker, « Galerie » ouvre une modale (`<dialog>` natif) qui liste tous les mondes sauvegardés avec leur vignette : la grille décodée est redessinée dans un canvas hors écran, mêmes couleurs que le bac. Un clic charge la scène. |

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

**Nouvelle matière** : une entrée dans `MATERIALS` + son id dans une famille de
`CATEGORIES`. Si son comportement n'est pas couvert par `kind` (`powder` /
`liquid` / `gas` / `static`), lui ajouter un `case` dans `Engine.update`.
