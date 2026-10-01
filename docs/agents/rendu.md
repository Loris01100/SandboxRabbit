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
| `FRAGMENT` | le canvas | le coloriage : copie de `Renderer.shade()` / `shadeHeat()` / `shadeAir()`. `view` = 0 matière, 1 thermique, 2 pression (les deux dernières sortent tôt, sans éclairage ni heure) |
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

## Le secours 2D

Sans WebGL2 (`getContext("webgl2")` nul — le choix est définitif, un canvas n'a
qu'un contexte), `flatScreen()` fait tourner le même `Renderer` qu'en test sur le
miroir, puis un `putImageData` du rectangle changé. Il **n'éclaire pas** : c'est
la seule différence d'aspect assumée entre les deux chemins
(`ponytail:` de `lighting()`).

## En touchant à ce fichier

- Une règle d'aspect se change **des deux côtés** (shader et `Renderer`) :
  `npm run browser` les compare à une unité près sur
  [test/screen.html](../../test/screen.html) ([navigateur.md](../navigateur.md)).
- La rampe de la vue pression est calculée **en entiers** des deux côtés : en
  flottants, le GPU arrondissait autrement 2 % des paliers.
- `preserveDrawingBuffer: true` n'est pas décoratif : le PNG et la vidéo de
  share.ts relisent le canvas par `drawImage()` après coup.
- `ponytail:` une perte de contexte WebGL (pilote qui redémarre) laisse le bac
  noir jusqu'au rechargement ; et les cascades sont « à la vanille », sans la
  correction bilinéaire des rayons.
