# Le moteur de simulation

[src/client/sim/engine.ts](../../src/client/sim/engine.ts) et son registre
[materials.ts](../../src/client/sim/materials.ts). À lire avant toute
modification d'une règle ou d'une matière : la plupart des invariants ci-dessous
ne sont gardés par **aucun** test visible, seulement par l'empreinte globale
(voir [tests.md](tests.md#lempreinte-du-moteur)).

## État

Tableaux plats de taille `width * height`, **aucun objet par cellule** — c'est
délibéré, pour pouvoir remplacer l'intérieur d'`Engine` par du Rust/WASM en
gardant l'interface (`step`, `paint`, `cells`).

| Tableau | Type | Contenu |
| --- | --- | --- |
| `cells` | `Uint8Array` | id de matière (`MATERIALS`) |
| `life` | `Uint8Array` | compteur multi-usage, voir plus bas |
| `temp` | `Float32Array` | °C, **réassigné à chaque tick** (double tampon) |
| `clock` | `Uint8Array` | parité du tick où la cellule a déjà bougé |
| `frozen` | `Uint8Array` | 1 = figée à la main |
| `noise` | `Int8Array` | grain fixe par cellule (rendu) |

Scalaires : `gravity` (±1), `wind` (-1..1), `ambient` (°C, réglage de scène —
`AMBIENT` = 20 n'est que le défaut), `emit` (matière des `SOURCE` posées
ensuite), `seed` et `scan` (état du xorshift, sens du balayage).

## Un tick (`step()`)

1. `parity ^= 1`.
2. Balayage **dans le sens de la gravité** (du bas si `gravity` = 1), le sens
   en x alternant avec `parity`. Pour chaque cellule non vide, non figée, dont
   `clock` ≠ `parity` : `clock = parity`, puis `update()`.
3. `update()` : d'abord un `switch` sur les ids à règle propre (feu, lave,
   acide, TNT, étincelle…), sinon mouvement générique selon `kind`
   (`powder` / `liquid` / `gas`, `static` ne bouge pas).
4. `thermal()` : les sources (`heat`) tirent leur cellule vers leur
   température, puis diffusion (`CONDUCTION`), retour vers `ambient`
   (`COOLING`), et changements d'état `boil` / `freeze`. Les deux tampons
   s'échangent.

Toucher à l'ordre du balayage ou à `clock` introduit des dérives visibles.

## Invariants

### Reproductibilité

- **Tout tirage passe par `engine.rand()`** (xorshift32 semé au constructeur),
  jamais `Math.random()`. Un `Math.random()` dans une règle casse le rejeu et
  la comparaison avec un futur moteur WASM. L'empreinte de test/sim.ts ne
  l'attrape que si sa scène réveille la règle fautive ; sinon **aucun test ne
  le voit**. Même règle hors du moteur pour ce qui fait partie de la partie
  (`weather()`). Seule exception : la graine par défaut du constructeur.
- Changer **l'ordre** des tirages d'une règle change l'empreinte, même à
  comportement visible identique. C'est voulu.
- Rejouer en cours de partie exige les tableaux **plus** `seed`, `scan` et
  `clock` (une cellule fraîchement peinte garde l'horloge de ce qui l'occupait).
  C'est pour ça que `clock` est publique et que replay.ts la sérialise.

### Mouvement

- Toute règle de déplacement passe par `y + this.gravity` et `drift()` (vent).
  Seule exception : `MAGNET`, qui tire la limaille d'un cran vers lui en
  ignorant la gravité.
- Déplacer = `tryMove()` (qui refuse une cible figée et vérifie
  `displaces()`), jamais écrire `cells` à la main.
- Hors grille, `get()` renvoie `STONE` : les règles ne testent pas les bords.
- Voisines : offsets `NX` / `NY` (boucle `for k < 4`). Pas de générateur ni
  d'itérateur alloué par appel — ça coûtait 30 % du tick.

### Figé, `set`, `become`

- `frozen` court-circuite tout : `step()` saute la cellule, `tryMove()` refuse
  d'y entrer, `become()` passe son tour.
- Une **règle** qui repeint un voisin appelle `become()`. `set()` remet
  `frozen` à 0 : c'est le geste du pinceau (repeindre libère).

### Chaleur

- `heat` tire la cellule vers une température sans l'imposer (une flamme peut
  encore faire fondre la glace qu'elle touche).
- Ajouter un changement d'état = `boil` / `freeze` dans `MATERIALS`, **aucune
  règle dans `Engine`**. Pas de cycle (`A → B → A` sur des seuils qui se
  chevauchent) : l'assert du registre le refuse.
- Seuils calibrés à ne pas « simplifier » :
  - pétrole `boil` à 200 °C : à 80 une flamme voisine suffisait ;
  - pierre `boil` à 1400 °C : la lave ne chauffe la roche qu'à ~800, seule la
    thermite (2800) creuse. Baisser ce seuil fait fondre le décor de toutes
    les scènes de lave.

### Performance du chemin chaud

Ce que la boucle lit par cellule et par tick est **dérivé** de `MATERIALS` au
chargement, en tableaux typés indexés par id : `KIND`, `DENSITY`, `HEAT`,
`BOIL_AT` / `BOIL_INTO`, `FREEZE_AT` / `FREEZE_INTO` (engine.ts), `palette` et
`grain` (render.ts). Lire `MATERIALS[id].density` dans `displaces()` ou
`.noise` dans `draw()` annule le gain (le tick est passé de 1,6 à 0,7 ms en
320×180). Une nouvelle propriété lue dans le chemin chaud mérite sa table.

- Les boucles en disque (`paint`, `setFrozen`) bornent leur carré englobant
  via `disc()` : leur coût est celui du bac, jamais du rayon demandé (un pair
  de salon peut envoyer un rayon d'un milliard).
- `temp` est réassigné à chaque tick : le lire au moment de s'en servir, ne
  pas en garder une référence d'une frame à l'autre.

### Données venues d'ailleurs

Une grille externe (galerie, lien, salon) entre par `engine.adopt()`, qui
écarte les ids absents de `MATERIALS` — sinon `MATERIALS[id].heat` jette à
chaque tick et le bac s'arrête. Même filtre sur les gestes (`known()` dans
gestures.ts).

## Les usages de `life`

`Uint8Array` : donc `life` ≤ 250 dans `MATERIALS`. **Ne jamais le
réinitialiser à l'aveugle**, chaque matière en fait autre chose.

| Matière | `life` signifie |
| --- | --- |
| gaz (feu, fumée, vapeur, grisou, retombées), nanites, braise | ticks restant à vivre |
| `NITRO` | cellules de chute (au-delà de `SHOCK` = 4, l'atterrissage détonne) |
| `C4` | amorçage (1 = saute au tick suivant) |
| `THERMITE` | ticks de combustion |
| `SOURCE` | la matière émise |
| `CANDLE` | mèche allumée |
| `METAL` | ticks de repos après une étincelle (`RECOVERY`) |
| `SWITCH` | 1 = fermé |
| `URANIUM` | compteur d'emballement |
| `MAGNET` | pôle (1 = repousse) |

## Familles de règles

### Explosifs : un déclencheur chacun

Un explosif se distingue par son **déclencheur**, pas par son rayon. Ajouter un
explosif = ajouter un déclencheur, sinon c'est du TNT repeint.

| Matière | Déclencheur |
| --- | --- |
| `TNT`, poudre | feu |
| `NITRO` | choc (chute) |
| `C4` | étincelle |
| `MINE` | poids de ce qui coule (poudre / liquide) |
| `FIREDAMP` | volume (gaz `flammable` 1) |
| `URANIUM` | masse (≥ `CRITICAL` voisins identiques), sans rien d'extérieur |
| `THERMITE` | l'anti-explosif : perce au lieu de souffler |

- `explode()` **projette** (`hurl()`) au lieu d'effacer, et traite le disque
  **du bord vers le centre** (sinon les cellules partent vers des places pas
  encore libérées). `hurl()` ne dépose que sur du vide : la matière est
  conservée. Quand le rayon est bouché, l'appelant pulvérise — ce repli garde
  le pouvoir de percer un mur.
- `explode()` préserve `TNT` et `C4` sur son pourtour, sinon une chaîne
  s'annule : le TNT repart par le feu semé, le C4 par `life` = 1.
- `URANIUM` doit rester **désamorçable** : casser le tas fait redescendre
  `life`. Sa chaleur est le seul avertissement. Le nucléaire ne se distingue
  du TNT que par les retombées (`FALLOUT`) semées par `nuke()`.

### Électricité

- `SPARK` ne se propage que dans `METAL`, et le métal traversé garde
  `RECOVERY` ticks de repos (sinon l'étincelle repart en arrière et le circuit
  ne s'éteint jamais).
- Tout ce qui met un fil sous tension passe par `charge()` (étincelle,
  `BATTERY`, `SWITCH` fermé).
- `SWITCH` ne devient **jamais** une étincelle : il la relaie. Sinon il
  redeviendrait `METAL` à l'extinction et disparaîtrait.

## Rendu

[render.ts](../../src/client/sim/render.ts) : 1 cellule = 1 pixel dans un
`ImageData`, un seul `putImageData` par frame côté page, mise à l'échelle par
CSS `image-rendering: pixelated`. **Pas de dessin par cellule.**
`renderer.heatmap` bascule sur une palette de `temp` dans la même boucle. La
lumière autour des sources chaudes est un sous-produit de `temp` (aucun flou).
`thumbnail()` sert aux vignettes de la galerie.

## Où vit quoi dans `Sandbox`

[sim/sandbox.ts](../../src/client/sim/sandbox.ts) est le **seul** endroit qui
appelle `engine.step()` (via `tick()`, météo comprise) et `Renderer.draw()`.
Il porte aussi l'annulation (10 crans de copies des quatre tableaux), le
défi en cours, l'enregistrement et le rejeu.

Tout ce qui change la grille **sans passer par un geste** (annuler, vider,
charger, bâtir une scène) doit appeler `this.rec?.stamp()`, sinon le rejeu
diverge à partir de là. Un changement de taille abandonne l'enregistrement.
