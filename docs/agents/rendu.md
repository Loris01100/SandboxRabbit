# Le rendu, de la grille au pixel

Comment une cellule du moteur devient un pixel à l'écran, et surtout **comment
marche [screen.ts](../../src/client/screen.ts)** : ses textures, ses quatre
programmes, son éclairage global.

Les deux autres faces du sujet sont ailleurs, et ne sont pas répétées ici :

- les **règles d'aspect** (ce qui décide d'une couleur, les deux copies du
  coloriage, les vues thermique et pression, l'heure) :
  [simulation.md § Rendu](simulation.md#rendu) ;
- le **transport** d'une frame du bac à la page (bandes, tampon unique,
  miroir) : [architecture.md § Trois fils](architecture.md#trois-fils-dexécution).

## La chaîne, en cinq temps

| Où | Qui | Quoi |
| --- | --- | --- |
| Worker | `Tracker.take()` (render.ts) | découpe les blocs changés en bandes (`Patch`) de données **brutes**, toutes vues d'**un seul** tampon |
| Worker | `tell()` (sim/worker.ts) | `postMessage` qui **transfère** ce tampon (zéro copie) |
| Page | `blit()` → `land()` (world.ts, render.ts) | recopie chaque bande dans le **miroir**, note le rectangle changé, rend le tampon au Worker (`spare`) |
| Page | `present()` (world.ts) | une fois par `requestAnimationFrame` : `screen.paint(miroir, rectangle, vue, éclairage, heure)` |
| Page | `paint()` (screen.ts) | monte le rectangle à la carte, puis **un** triangle plein écran |

Deux conséquences qui tiennent tout le reste : le miroir est la **copie exacte**
du moteur (température et pression en flottants bruts, grain compris), donc le
shader colorie exactement ce que colorierait `Renderer` ; et rien n'est jamais
dessiné cellule par cellule.

## Les couches en textures

`LAYERS` liste les six tableaux montés, dans cet ordre : chacun occupe
**l'unité de texture de son rang**. Les unités suivantes sont nommées à la
suite (`PALETTE`, `LIGHT`, `TABLE`, `SCENE_UNIT`, `UPPER`) : ajouter une couche
décale tout ce qui suit, c'est voulu — un seul endroit à changer.

| Couche | Format interne | Lue comme | Pourquoi |
| --- | --- | --- | --- |
| `cells` | `R8UI` | `usampler2D` | id de matière, index de la palette |
| `life` | `R8UI` | `usampler2D` | compteur multi-usage (rougeoiements) |
| `frozen` | `R8UI` | `usampler2D` | hachures du figé |
| `noise` | `R8I` | `isampler2D` | grain signé, fixe pour un moteur |
| `temp` | `R32F` | `sampler2D` | °C **bruts** : arrondir côté Worker coûtait 10 ms par frame en 1920×1080 |
| `press` | `R32F` | `sampler2D` | pression brute, ramenée à son palier dans le shader |

Les textures entières exigent `NEAREST` ; seule la texture d'éclairage est en
`LINEAR` (elle est étirée). Une taille de grille qui change refait les six
textures (`texStorage2D`) et repart d'une image entière.

**Ne monter que le rectangle changé**, sans copie intermédiaire : `paint()`
règle `UNPACK_ROW_LENGTH` / `UNPACK_SKIP_PIXELS` / `UNPACK_SKIP_ROWS` sur la
largeur du bac et le coin du rectangle, et passe le tableau du miroir **entier**
à `texSubImage2D` ; la carte y lit la sous-image. Ces trois réglages sont remis
à zéro juste après — ils sont globaux, et une autre texture montée ensuite lirait
de travers.

Pas de tampon de sommets : `VERTEX` fabrique un triangle qui couvre l'écran à
partir de `gl_VertexID`, et chaque passe est un `drawArrays(TRIANGLES, 0, 3)`.

## Les quatre programmes

Tous partagent ce vertex shader ; `link()` lie les échantillonneurs de chacun à
leurs unités une fois pour toutes.

| Programme | Écrit dans | Rôle |
| --- | --- | --- |
| `FRAGMENT` | le canvas | le coloriage : copie de `Renderer.shade()` / `shadeHeat()` / `shadeAir()` ; le mélange de la lumière, de `Renderer.illuminate()`. `view` = 0 matière, 1 thermique, 2 pression (les deux dernières sortent tôt, sans éclairage ni heure) |
| `SCENE` | `scene` | résume le bac en grille de lumière : par texel, moyenne de l'émission prémultipliée par l'opacité et de l'opacité (`lighting()` de render.ts), plus le rougeoiement au-delà de 450 °C |
| `CASCADE` | `cascades[n]` | une cascade de *radiance cascades*, de la plus lointaine à la plus proche |
| `FLUENCE` | `light` | moyenne les 4 directions de la cascade 0 en une lumière par texel |

## L'éclairage global (`SCENE`, `CASCADE`, `FLUENCE`)

*Radiance cascades* (Alexander Sannikov). L'idée est expliquée au-dessus de
`SCENE` dans le code ; ce qui suit est le **dimensionnement**, qu'il faut avoir
en tête avant d'y toucher.

- **Grille de lumière plus grossière que le bac** : `scale = ceil(largeur /
  lightWidth)`, donc un texel couvre `scale × scale` cellules, et la grille fait
  `ceil(largeur / scale) × ceil(hauteur / scale)`. `lightWidth` vaut
  `LIGHT_WIDTH` = 480 texels, réglable par `detail()` (Paramètres › Graphismes :
  480, 240, 120) — la moitié de largeur, c'est **quatre fois** moins de texels à
  éclairer.
- **Nombre de cascades** : on en ajoute tant que la portée `(4ⁿ − 1)/3` n'atteint
  pas la diagonale de la grille de lumière, `CASCADES` = 6 au plus (portée 1365
  texels). Inutile de porter plus loin que le bac.
- **Taille d'une cascade** : la cascade `n` pose une sonde tous les `2ⁿ` texels et
  garde `(2 << n)²` directions par sonde, rangées en carré autour d'elle — d'où
  une texture de `ceil(lw / 2ⁿ) × (2 << n)` sur `ceil(lh / 2ⁿ) × (2 << n)`.
  **Toutes les cascades ont donc à peu près le même nombre de texels** : c'est
  tout l'intérêt, le coût croît avec le log de la portée.
- **Mipmaps** : `scene` est créée avec ses niveaux
  (`NEAREST_MIPMAP_NEAREST`, `generateMipmap()` après chaque passe `SCENE`), et
  une cascade lointaine, qui marche à grands pas, lit le niveau correspondant à
  son pas (`lod = log2(stride)`). Sans ça elle sauterait par-dessus les murs
  fins.
- **Demi-flottants si la carte sait y dessiner**
  (`EXT_color_buffer_float` → `RGBA16F`, sinon `RGBA8`) : en octets, un halo
  faible s'échelonne en paliers visibles.
- **La dernière cascade n'a pas de dessus** : elle lit `none`, une cible 1×1
  noire. Jamais la texture où elle écrit — lire et écrire la même texture dans
  une passe est interdit.
- `FLUENCE` finit par deux cas particuliers, chacun né d'un défaut visible : un
  texel **opaque** prend la lumière de son voisin non opaque le plus éclairé (sa
  propre sonde, enfermée dans le mur, ne voit rien — la pierre au bord de la lave
  restait noire) ; un texel opaque **qui brille** ne reçoit rien (la lumière de
  son voisin est la sienne, et le bord d'une mer de lave virait au jaune saturé).

`illuminate()` refait **tout** le bac, quel que soit le rectangle changé : la
lumière n'est pas locale. Mais seulement quand une frame arrive et que
l'éclairage est allumé en vue matière (`lit && view === "matter"`) — un bac au
repos n'envoie rien, donc ne recalcule rien. Le mélange final se fait dans
`FRAGMENT` : `light` est échantillonnée en bilinéaire aux coordonnées du pixel
divisées par `taille de la grille de lumière × scale`, puis ajoutée en deux
parts, un halo constant (`LIGHT_HALO` = 160) et une part proportionnelle à la
couleur (`LIGHT_GAIN` = 1,5) — le halo se voit sur le fond sombre, le gain
éclaire les surfaces.

`resize()` détruit et refait toutes les cibles : à appeler quand la taille du bac
change **ou** quand `detail()` change `lightWidth` (mais pas avant la première
frame, `paint()` s'en charge).

## La perte de contexte

Le contexte WebGL peut se perdre (pilote qui redémarre, onglet en arrière-plan
sur un mobile). `createScreen()` enveloppe donc `glScreen()` dans
`restartable()` : à `webglcontextlost`, il appelle `preventDefault()` (sans quoi
le navigateur ne rend jamais le contexte) et ne peint plus ; à
`webglcontextrestored`, il refait un `glScreen()` neuf, lui redonne la dernière
largeur de `detail()` et repose en entier le dernier miroir reçu. world.ts a
continué d'y recopier les bandes pendant la perte, et un bac en pause, qui
n'envoie plus de frame, réapparaît quand même. Tout ce que `glScreen()` monte
(programmes, textures, cibles) doit donc pouvoir être refait de zéro : pas
d'objet GL gardé hors de lui.

## Le secours 2D

Sans WebGL2 (`getContext("webgl2")` nul — le choix est définitif, un canvas n'a
qu'un contexte), `flatScreen()` fait tourner le même `Renderer` qu'en test sur le
miroir, puis un `putImageData` du rectangle changé.

**Il éclaire aussi**, par `FlatLight`
([sim/flatlight.ts](../../src/client/sim/flatlight.ts)), qui **ressemble** au
shader sans en être une copie — les *radiance cascades* demandent des milliers
de rayons par texel, que le fil de la page ne peut pas se payer :

- **Mêmes entrées** : émission et opacité de `lighting()`, rougeoiement au-delà
  de `RED_HOT` (450 °C), moyennés par texel comme `SCENE`, puis une pyramide de
  niveaux réduits (les mipmaps).
- **Autre chemin** : une seule grille de `FLAT_LIGHT` = 80 texels de large, quelle
  que soit la taille du bac ; par texel non opaque, `RAYS` = 16 rayons dont le
  pas grandit avec la distance (1 jusqu'à 8 texels, puis le quart de la
  distance) et qui lisent la pyramide **en bilinéaire** au niveau de leur pas —
  lue au plus proche, la lumière se dessinait en pavés. Même absorption que
  `CASCADE` : `(1 − opacité)^pas`, la part arrêtée renvoie sa couleur.
- **Même fin** que `FLUENCE` (un opaque prend la lumière de son voisin le plus
  éclairé, un opaque qui brille ne reçoit rien) et **même mélange** que
  `FRAGMENT` : `LIGHT_HALO` et `LIGHT_GAIN`, désormais dans render.ts pour les
  deux chemins.
- **Coût** : ~4,5 ms par éclairage, de 320×180 à 1920×1080 (la collecte ne lit
  qu'une cellule sur `scale/4` par sens au-delà de 4 × 4 cellules par texel) ;
  le mélange par rangée (`row()` : la lumière interpolée en vertical une fois,
  index et poids horizontaux précalculés) ajoute ~30 % au coloriage. Comme la
  lumière n'est pas locale, un éclairage recolorie tout le bac : au plus toutes
  les `relight()` ms, 50 jusqu'en 640×360, ~200 en 1920×1080 ; entre deux, seul
  le rectangle changé est reposé, avec la lumière d'avant.
- **Chargé à la demande** (`import()` dans `flatScreen()`, à la première frame
  éclairée) : seule une page sans WebGL2 en a besoin, et la page a un budget.
  D'ici là, le bac est peint sans lumière.
- **Pas comparé** au shader par `npm run browser` : les deux ressemblent, ils
  ne coïncident pas (`ponytail:` de `FlatLight`). test/sim.ts en garde les
  traits (la lave éclaire, un mur fait de l'ombre, le noir reste noir) et
  test/browser.ts le fait tourner dans un Chromium sans WebGL. Pour juger
  l'aspect, comparer à l'œil : la même scène peinte des deux façons, la nuit.
- La case « Éclairage » est proposée aussi sans WebGL2 ; « Finesse de
  l'éclairage » (Graphismes), non : la grille du secours est fixe.

## En touchant à ce fichier

- Une règle d'aspect se change **des deux côtés** (shader et `Renderer`) :
  `npm run browser` les compare à une unité près sur
  [test/screen.html](../../test/screen.html) ([navigateur.md](../navigateur.md)).
- La rampe de la vue pression est calculée **en entiers** des deux côtés : en
  flottants, le GPU arrondissait autrement 2 % des paliers.
- `preserveDrawingBuffer: true` n'est pas décoratif : le PNG et la vidéo de
  share.ts relisent le canvas par `drawImage()` après coup.
- `ponytail:` les cascades sont « à la vanille », sans la correction
  bilinéaire des rayons.
