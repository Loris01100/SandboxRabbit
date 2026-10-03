# Mode exploration : monde infini (plan)

**État : étapes 1 à 4 faites** (`land()`, `Engine.shift()`, le mode dans le
bac, la page qui suit : voir plus bas), étapes 5 et suivantes à faire. Le bouton Explorer 🧭
(main.ts) fixe l'échelle : décor à `EXPLORE_SCALE` (sim/explore.ts), vue à
`EXPLORE_PX` pixels d'écran par cellule. Le monde reste un bac fini de
1280×720. Ce guide dit comment le rendre infini en largeur, dans quel ordre,
et ce que chaque étape doit prouver avant la suivante. Le mettre à jour à
chaque étape livrée : une ligne « fait », ce qui a été mesuré, et ce qui a
changé par rapport au plan.

## Le principe : une fenêtre qui glisse

Le moteur ne grandit pas. Il garde une **fenêtre** de taille fixe, la grille
de toujours (`Engine`, tableaux plats, 1280×720), posée sur un monde découpé en
**chunks** de 256 colonnes de toute la hauteur. Quand le héros approche d'un
bord de la fenêtre, elle se décale d'un chunk :

- les 256 colonnes qui sortent sont encodées (codec RLE) et rangées dans une
  table `numéro de chunk → données` ;
- les 256 colonnes qui entrent sont **relues** de cette table si le joueur y
  est déjà passé, sinon **générées** par la graine ;
- hors de la fenêtre, le monde est gelé. Au bord de la fenêtre, la matière
  bute comme sur un mur (`get()` hors grille = `STONE`), et reprend quand on
  revient.

C'est le schéma de Noita et de Minecraft. Terraria, lui, a un monde fini qu'il
ne simule qu'autour du joueur.

Pourquoi pas une grande grille : 8400×2400 (un grand monde Terraria) fait
20 millions de cellules, soit environ 30 octets chacune dans le moteur
(`cells`, `life`, deux tampons de `temp` et de `press`, `windX`/`windY`,
`clock`, `frozen`, `noise`, tampons de travail du multi-fils), plus le miroir de
la page. Ça donne autour de 600 Mo, des textures WebGL hors des limites de
beaucoup de GPU, un codec et une API (1920×1080 au plus) à refaire. Les blocs
de veille économisent le calcul, pas la mémoire.

### Les choix qui simplifient

| Choix | Pourquoi |
| --- | --- |
| Infini **en largeur seulement**, hauteur = celle de la fenêtre (720) | Un seul sens de décalage : les colonnes, jamais les rangées. Le relief et les étages (mer, nappe, pétrole, lave) sont déjà en fraction de `h`. L'infini vertical reste possible plus tard, en ajoutant le même mécanisme sur les rangées. |
| Chunk de **256 colonnes**, multiple de `CHUNK` (16) et de `PART` (32) | Un décalage garde l'alignement des blocs de veille et du damier : `awake`, `stir`, `hush` se décalent d'un nombre entier de blocs, sans recalcul. |
| Fenêtre de 5 chunks (1280), décalage quand le héros sort des 3 du milieu | Il y a toujours au moins un chunk vivant entre le héros et le mur invisible, hors de la vue (environ 320 cellules visibles à 6 px par cellule sur un écran de 1920 px). |
| Le décalage se fait **entre deux ticks**, jamais pendant | Les tampons de travail du tick (`later`, mouvements du lapin, `jobs`) sont vides : seul `hero` garde un index de cellule d'un tick à l'autre. |
| Pas d'annulation, de rejeu, de défi, de salon ni de choix de taille dans ce mode, au départ | Tous supposent une grille unique et complète. Chacun est repris à part, en fin de plan. |

## Les étapes

Chaque étape se livre seule, testée et documentée. Aucune ne change
l'empreinte du moteur hors du mode : `shift()` n'est jamais appelé ailleurs.

### 1. Générer par tranches de colonnes (pur) — fait

**Fait.** `land()` et `STRIP` (256), d'abord dans terrain.ts, aujourd'hui
dans sim/explore.ts (chargé à la demande, voir l'étape 3). Sous-sol et relief
passent par `plan()`, `surface()` et `under()`, partagés avec `terrain()`, qui
reste identique au bit près (comparé à l'ancienne version en 320×180, 640×360
et 1920×1080). test/sim.ts vérifie : cinq tranches dans le désordre = une
seule passe (cellules, `life`, grain, température), fenêtres décalées de +256
et de -512 identiques sur leurs colonnes communes, poches fermées, uranium
isolé, pas de héros, monde au repos, aucun tirage du bac consommé.

Écarts avec le plan :
- un lapin ne naît que si son corps (colonnes `x - 2 … x + 2`) tient dans son
  chunk **et** dans la tranche bâtie. Pour une tranche alignée sur `STRIP`,
  c'est sans effet ; une tranche coupée ailleurs perd les lapins de ses bords.
  Le reste du monde ne dépend pas du découpage, quel qu'il soit ;
- un arbre cède la place à un **candidat** des `4 * scale` colonnes à sa
  gauche (pas à un arbre) : la règle reste locale, sans chaîne de dépendances ;
- les grappes d'uranium sont sur des coordonnées paires : deux grains ne
  peuvent pas se toucher, même venus de deux grappes.

**Mesuré** (`npm run bench`, ligne « tranche du monde infini ») : **environ
35 ms** par tranche de 256×720, loin des 5 ms visés. Presque tout est le
bruit du sous-sol (`noise()`, environ la moitié d'après le profil, le reste dans les boucles de `land()` et `under()`), le même
calcul que `terrain()`. Conséquence pour l'étape 3 : la tranche suivante se
bâtit **d'avance**, pas au tick du décalage (voir plus bas). Ce n'est pas un
problème de justesse : `land()` est pur, on peut la calculer n'importe quand,
et même ailleurs que sur le fil du bac. Une piste si ça ne suffit pas :
garder les valeurs de `lattice()` d'une colonne à l'autre de la maille, sur
laquelle `noise()` recalcule quatre coins identiques des dizaines de fois.

Le plan d'origine :

Une fonction `land(e, seed, scale, x0, from, to)` bâtit les colonnes
`[from, to)` de la fenêtre, qui sont les colonnes `x0 + from …` du monde. Le
`terrain()` actuel ne change pas : les mondes générés de toujours restent
identiques au bit près.

Ce qui l'empêche aujourd'hui, et ce qu'il faut à la place :

| Aujourd'hui | Par tranches |
| --- | --- |
| `ground[]` calculé sur toute la largeur, et sa pente lue en `x ± 1` | `ground(x)` pour une colonne du monde, calculé à la demande (le bruit est déjà un hachage de la position, `lattice()`). |
| Scellement des poches : une deuxième passe qui lit les voisines déjà posées | Décider « poche ou pierre » à partir des seules valeurs générées (avant scellement) de la cellule et de ses quatre voisines, recalculées au besoin hors de la tranche. Le résultat ne dépend plus de l'ordre. |
| Uranium, arbres, lapins tirés **à la suite** par un seul xorshift | Un tirage par colonne (ou par chunk) semé par `(seed, x)`. L'espacement des arbres (`x += 4 * s`) devient une règle locale : pas d'arbre si une des colonnes précédentes en porte un. |
| Une couronne d'arbre déborde sur la tranche voisine | La tranche tient compte des troncs à moins de `crown` cellules de ses bords et n'en peint que sa part. |
| `noise` (grain du rendu) tiré par `engine.rand()` à la construction | Un hachage de la position dans le monde : un chunk revisité a le même grain, et générer ne touche pas au tirage du bac. |
| Le héros posé « au sec le plus près du centre » | Posé une fois, au départ de la partie, près de x = 0 du monde. |

**Doit prouver** (test/sim.ts) :
- les colonnes 0…1279 bâties d'un coup ou en cinq tranches de 256 dans
  n'importe quel ordre donnent la même grille au bit près ;
- deux fenêtres décalées d'un chunk coïncident sur leurs colonnes communes ;
- poches fermées, monde au repos, comme `terrain()` aujourd'hui ;
- mesurer le coût d'une tranche de 256×720 (cible : moins de 5 ms).

### 2. Décaler la fenêtre (`Engine.shift(dx)`) — fait

**Fait.** `Engine.shift(dx)` dans engine.ts, décrit dans
[simulation.md](simulation.md#blocs-de-veille). `dx` doit être un multiple de
`CHUNK` (16) et plus petit que la largeur, sinon il lève une erreur. Le mode
utilisera `STRIP` (256).

Prouvé :
- test/sim.ts : un aller-retour, la bande sortie reposée à la main, redonne
  matière, `life`, chaleur, pression et grain au bit près. Puis 200 ticks
  donnent la même partie qu'un bac resté en place, dont on a seulement
  réveillé la même bande. Une fenêtre décalée d'un chunk dont on bâtit la
  bande neuve (`land()`) est identique à la fenêtre d'à côté bâtie d'un coup.
  Le héros piloté glisse avec son index ; sorti par le bord, il est perdu ;
- test/pool.ts : 300 ticks d'une partie chargée (feu, explosions, pression)
  avec six décalages de ±128 : 4 fils = 1 fil, au bit près ;
- l'empreinte de test/sim.ts n'a pas bougé (`shift()` n'est jamais appelé
  hors du mode) ;
- `npm run bench`, ligne « décalage de la fenêtre » : **environ 4 ms** en
  1280×720, sous les 12 ms de `SLICE`. Avec la tranche bâtie d'avance
  (étape 3), le tick du décalage tient.

Écart avec le plan : il fallait glisser **les deux** tampons de `temp` et de
`press`, pas seulement le courant. Un bloc endormi a recopié sa chaleur dans
l'autre tampon et la relit au tick suivant ; une pression calmée est remise
à zéro dans les deux. N'en glisser qu'un rendait au réveil la chaleur ou la
pression de l'endroit d'avant.

Restent pour l'étape 3 : un héros ou un lapin coupé par la bande sortante y
perd des cellules et meurt au tick suivant. C'est au mode de décaler assez
tôt pour que le héros n'y soit jamais. Un héros d'un chunk rangé revient
avec son numéro : `seek` relance `enlist()`, qui renumérote en cas de
doublon.

Le plan d'origine :

`dx` est un multiple de 256, positif ou négatif. Entre deux ticks :

1. `copyWithin` sur chaque tableau par cellule, rangée par rangée : `cells`,
   `life`, `frozen`, `clock`, `noise`, `windX`, `windY`, et le tampon
   **courant** de `temp` et de `press` (l'autre n'est que du travail) ;
2. le même décalage, en blocs, sur `stir`, `awake`, `was`, `hush` ;
3. `hero -= dx` (ou -1 s'il sort, ce qui ne doit pas arriver) ;
4. la bande libérée est vidée (température `ambient`, pression nulle,
   `clock` neutre) : c'est l'appelant qui la remplit (étape 3) ;
5. la bande neuve et ses voisins sont réveillés, comme après un `paste()`.

**Doit prouver** :
- décaler puis revenir, en reposant la bande sortie, redonne la grille au bit
  près (test/sim.ts) ;
- le résultat ne dépend pas du nombre de fils : test/pool.ts, 1 contre 4 fils,
  sur une partie qui décale plusieurs fois ;
- l'empreinte de test/sim.ts ne bouge pas ;
- `npm run bench` : environ 28 Mo à recopier par décalage, à mesurer (cible :
  sous `SLICE`, 12 ms, génération comprise).

Points délicats à relire (aucun test ne les verrait tous) : la parité de
`clock` après le décalage, la pression qui touchait le bord sortant (passer
par `puff()` si on en réinjecte), les cellules de `HERO_SLOTS` (le corps du
héros ne doit jamais être coupé par la bande sortante : la marge de l'étape 3
y veille).

### 3. Le mode dans le bac (sandbox.ts, nouveau `sim/explore.ts`) — fait

**Fait.**
- `land()` est devenue `lay(raise(…))` : `raise()` bâtit hors du bac (pur),
  `join()` recolle des morceaux, `lay()` pose, `regrain()` refait le grain
  d'un chunk relu.
- [sim/explore.ts](../../src/client/sim/explore.ts) : la classe `Explore`.
  - `start()` bâtit la fenêtre (monde x de -512 à 768) et pose le héros au
    sec le plus près du milieu.
  - `slide()`, après chaque tick, glisse d'un chunk quand le héros a passé
    le quatrième chunk (`x ≥ 1024`) ou est dans le premier (`x < 256`). Le
    chunk sortant est encodé (codec : matière, figé, `life`, température)
    dans `kept` ; l'entrant est relu de `kept` (puis en est retiré) ou bâti.
  - `prepare()`, une fois par frame, bâtit 32 colonnes du chunk suivant dès
    que le héros est dans le deuxième ou le quatrième chunk.
- Dans sandbox.ts : l'ordre `explore` (architecture.md). Le prototype
  (`terrain` avec `scale`) n'existe plus ; le bouton Explorer envoie
  `explore`. La frame porte `origin`.

Prouvé (test/sandbox.ts) :
- la fenêtre ne bouge pas tant que le héros reste dans les trois chunks du
  milieu ;
- elle glisse d'un chunk au-delà, le chunk sortant est rangé, et le héros
  reste piloté ;
- un chunk jamais vu est celui que bâtit la graine ;
- un chunk rangé revient tel qu'il était parti, `life` compris ;
- bâti d'avance (huit morceaux) ou au dernier moment : la même fenêtre ;
- protocole : `origin` dans la frame, et les refus (annuler, enregistrer,
  bac d'une autre taille). Le mode s'arrête sur un salon ou un autre monde.

Le héros y est déplacé à la main : le faire marcher sur quatre cents cellules
prendrait des milliers de ticks. Le test « dix chunks aller-retour » du plan
se réduit donc à un aller-retour d'un chunk ; le mécanisme est le même.

**Mesuré** (en 1280×720, à la main ; pas encore dans le bench) :
- un glissement coûte **14 à 17 ms** quand le chunk entrant est bâti d'avance,
  37 ms sinon (62 ms au premier, JIT froid). C'est au-dessus des 12 ms de
  `SLICE` : une image saute à chaque chunk traversé. Pistes : `lay()` passe par
  `set()` cellule par cellule (184 000 appels) alors qu'une recopie de rangées
  suivie d'un réveil des blocs suffirait, et l'encodage du chunk sortant
  pourrait attendre l'image suivante ;
- un chunk rangé pèse **environ 20 Ko** (11 à 22), pas quelques centaines
  d'octets comme espéré : relief, grottes et température varient beaucoup sur
  256×720. Dix chunks traversés font 200 Ko, mille font 20 Mo. À reprendre
  avec la sauvegarde (étape 5) : ne ranger que les chunks touchés, et
  rebâtir les autres par la graine ;
- le Worker de simulation était passé de 75,8 à 81,6 Ko (plafond de la CI :
  80 Kio, soit 81 920 octets ; il restait 273 octets). **Réglé** : le
  générateur du monde infini (`land()`, `raise()`, `lay()`…) a quitté
  terrain.ts pour sim/explore.ts, que le Worker ne charge qu'au premier ordre
  `explore` (`import()`). Les Workers sont bâtis en modules ES
  (`worker.format` de vite.config.ts) : l'IIFE ne savait pas découper. Le
  moteur fait 77 456 octets (4,4 Ko de marge), `explore-*.js` 4 822, hors
  budget. Vérifié dans Chromium (`npm run browser`, et à la main sur le
  bundle de production servi par `wrangler dev` : module chargé au clic,
  héros posé, aucune erreur). Le code des étapes 4 et 5 côté Worker va dans
  ce module-là.

Écarts avec le plan :
- un héros ou un lapin coupé par la bande sortante y perd des cellules : le
  héros n'y est jamais (il déclenche le glissement à 768 colonnes du bord
  sortant), un lapin peut y mourir ;
- un héros rangé dans un chunk revient avec son numéro ; si un autre l'a pris
  entre-temps, `enlist()` en renumérote un, et son nom peut passer à l'autre ;
- la grille glissée part en entier dans la frame suivante, mais pas le grain :
  la page garde celui de la première frame (étape 4).

Le plan d'origine :

`sim/explore.ts`, pur : la graine, l'échelle, l'origine de la fenêtre dans le
monde (`x0`, en cellules), la table des chunks sortis, et `due(heroX)`, qui dit
s'il faut décaler et de combien.

Dans sandbox.ts :
- l'ordre `{t:"explore", seed}` remplace le prototype (`terrain` avec
  `scale`) : fenêtre 1280×720, `land()` sur toute la largeur, héros posé ;
- après chaque tick, `due()` ; s'il faut décaler, on encode la bande sortante
  (codec : matière, figé, `life`, température), puis `shift()`, puis on relit
  la bande entrante ou on pose celle qui est déjà bâtie ;
- bâtir d'avance : une tranche coûte environ 35 ms (étape 1), trois images à
  60 Hz. Dès que le héros entre dans le chunk qui précède un décalage, on bâtit
  le chunk suivant **hors de la fenêtre**, par morceaux répartis sur plusieurs
  ticks ou dans un fil auxiliaire. Il faut donc d'abord séparer `land()` en
  deux : un calcul qui rend un tampon de colonnes (et la liste des lapins), et
  la recopie dans le moteur. Le résultat ne dépend pas du moment du calcul ;
  seul le moment où il est **posé** (au tick du décalage) compte pour le
  salon ;
- la décision ne dépend que de la grille : au même tick sur toutes les
  machines, ce qui garde la porte ouverte au salon (étape 7).

Un chunk sorti est toujours rangé, même intact : comparer au monde généré
coûte plus que l'encodage, et un chunk au repos tient en quelques centaines
d'octets. La température perd sa précision au passage (un octet, pas de
8 °C) : une coulée de lave revisitée revient un peu plus froide ou plus chaude.
Si ça se voit, ranger `temp` en brut pour les seuls chunks chauds.

**Doit prouver** (test/sandbox.ts) : un héros qu'on fait marcher sur dix
chunks puis revenir retrouve chaque chunk tel qu'il l'a laissé ; la mémoire
de la table reste bornée (quelques Ko par chunk au repos).

### 4. La page suit l'origine (world.ts, view.ts, hero.ts) — fait

**Fait.**
- world.ts relève `origin` dans chaque frame. Quand elle change, il fait
  glisser son miroir d'autant (`glide()` de render.ts) avant d'y poser les
  bandes de la frame, et retient le glissement ; `shifted()` le rend, remis à
  zéro. (Première version : le bac renvoyait toute la grille, voir « Images
  sautées » plus bas.)
- Dans la boucle d'image de main.ts : `present()` d'abord, puis
  `slideBy(shifted())` (view.ts), puis `follow()`. La caméra se décale du
  glissement **dans l'image où il est dessiné**. Décalée à l'arrivée de la
  frame, elle aurait montré une image du bac d'avant au mauvais endroit ; pas
  décalée du tout, elle rattrapait le héros en une dizaine d'images, et la vue
  filait d'un chunk. Caméra décrochée comprise : le monde ne bouge pas à
  l'écran.
- La fiche du héros donne sa colonne dans le monde (`origin + x`).
- Pas de désactivation dans le panneau : sandbox.ts refuse déjà, avec un
  message, annuler, rétablir, enregistrer et rejouer, et le mode s'arrête sur
  un autre monde, un décor, un chargement, une autre taille ou un salon (étape
  3). Griser ces contrôles coûterait des octets à la page (marge : 1,5 Ko)
  pour ne rien dire de plus.

Prouvé :
- test/sandbox.ts : un miroir rebâti comme world.ts, de frame en frame
  (`glide()` puis les bandes), reste la grille du bac (matière, `life`,
  grain, chaleur) après quatre glissements dans les deux sens ;
- dans Chromium, à la main (script jetable, pas dans `npm run browser`) :
  caméra décrochée emmenée à droite, un héros posé à la colonne 1100 du bac.
  La fenêtre glisse au tick suivant, le canvas recule de 1 536 px (256 × 6) et
  le héros reste à 1 004 px à l'écran sur toutes les images suivantes. Faire
  marcher le héros jusque-là prendrait plusieurs minutes sous le Chromium
  logiciel de la CI : c'est pour ça que ce n'est pas un test permanent ;
- `npm run browser` toujours vert.

#### Images sautées — réglé

Première version : la frame du glissement coûtait **35 à 50 ms** côté
Worker (Node, un fil), et 26 à 45 ms avec quatre fils auxiliaires, contre
environ 5 ms pour une frame ordinaire. Deux ou trois images sautaient à chaque
chunk traversé. En cause : la grille entière renvoyée (11 Mo, grain compris),
et un glissement de 13 à 30 ms.

Ce qui a été fait, du plus au moins rentable :
- **La page fait glisser son miroir** (`glide()`) : `Engine.shift()` fait
  glisser `shown` au lieu de tout marquer, et `Tracker.grained()` ne joint le
  grain qu'aux bandes de la frame. Seules partent la bande neuve et les
  bandes qu'ont changées les ticks.
- **Un chunk sortant est rangé brut** (`Stash`) et encodé par `prepare()` une
  image plus tard ; **un chunk rangé qui va rentrer est décodé d'avance**.
  Le codec coûtait 5 ms à l'encodage et 5 ms au décodage, au tick du
  glissement. La température brute est arrondie comme le codec : brut ou
  encodé, le chunk revient identique (test/sandbox.ts).
- **`lay()` écrit directement** dans les tableaux (tables `BORN`, `WARM`) et
  réveille par colonnes de blocs (`Engine.wakeColumns()`) ; **`paste()`**
  écrit rangée par rangée et réveille par bloc.
- **Le grain se répète tous les 256 colonnes** : précalculé une fois, posé par
  recopie de rangées (2 ms de hachage par chunk en moins).
- **Pression et élan ne glissent que s'il a soufflé** (`CTL.gust`) : 16 des
  27 octets par cellule (le décalage passe de 4 à 1,1 ms au bench).
- **Plus de `seek` dans `shift()`** : deux relectures de toute la grille de
  moins.
- **Rien d'autre de lourd dans la frame du glissement** : ni `prepare()`, ni
  la copie de secours de la grille (`grid`, plusieurs ms en 1280×720), qui
  attendent la frame suivante.

**Mesuré** (Node, quatre fils auxiliaires, héros qui marche réellement
jusqu'au seuil, chunk préparé) : le glissement seul passe de 11 à 19 ms à
**5 à 6 ms** une fois le JIT chaud. La frame du glissement passe de 16 à 25 ms
à **9 à 13 ms**, sous les 16,7 ms d'une image à 60 Hz ; une frame ordinaire en
coûte 3 à 4. Les premiers glissements d'une session restent à 15 à 25 ms, le
temps que le JIT compile ces fonctions : une image peut encore sauter aux
deux ou trois premiers chunks traversés. Côté page, le glissement du miroir
recopie 11 Mo et le shader recolorie tout (`repaint`) ; mesuré dans Chromium
logiciel, l'image à l'écran ne change que de 2,2 % de ses pixels au
glissement (le héros posé, l'eau qui coule) : le miroir glissé est juste.

Le plan d'origine :

- La frame porte `x0`. Quand il change, la page recopie son miroir avec le
  même décalage et ne reçoit que la bande neuve. Première version permise :
  le bac renvoie toute la grille (comme à la première frame d'un moteur,
  environ 11 Mo en 1280×720) ; mesurer, puis optimiser si ça accroche.
- La caméra (`panX`) se décale du même nombre de cellules dans la même image :
  sinon la vue saute d'un chunk. `follow()` continue de lisser.
- Ce qui convertit cellule ↔ écran passe déjà par `cellBox()` : rien à
  changer pour le pinceau. La barre de statut et la fiche du héros peuvent
  afficher la position dans le monde (`x0 + x`).
- Le shader recolorie tout après un décalage (comme `heatmap`) ; l'éclairage
  se recalcule de lui-même.
- Désactiver dans ce mode : menu de taille, annuler/rétablir, enregistrer,
  défis, bac partagé, publier dans la galerie.

**Doit prouver** : `npm run browser` toujours vert ; un passage de chunk à la
main sans saut visible ni image figée, avec la durée du passage mesurée.

Budget : la page n'a plus qu'environ 1,7 Ko de marge (84 Kio). Le gros du code
va dans le Worker de simulation (80 Kio, plus large) ; côté page, le mode doit
tenir en quelques centaines d'octets, ou se charger à la demande comme
gallery.ts.

### 5. Sauvegarder (local d'abord)

Un monde infini, c'est la graine, `x0`, la fenêtre et la table des chunks.
C'est un **nouveau** format, pas un bloc de plus dans le codec : un monde
classique ne doit pas devenir illisible pour qui ne connaît que lui. Rangé par
`write()` d'ui.ts sous une nouvelle clé, à documenter dans architecture.md.
Borne : la limite de `localStorage` (environ 5 Mo). Au-delà, IndexedDB, ou ne
garder que les chunks modifiés par le héros.

### 6. Rendre la vue plus légère (si les mesures le demandent)

Ne colorier et n'éclairer que le rectangle visible, au lieu de toute la
fenêtre agrandie par CSS. Ça touche screen.ts, `Renderer` et `FlatLight`, donc
deux copies à tenir alignées (rendu.md). À ne faire que si les mesures de
l'étape 4 montrent que le rendu de la fenêtre entière coûte trop.

### 7. Plus tard

- **Salon** : le décalage est déjà déterministe (étape 3). Il manque d'envoyer
  la table des chunks dans le `start` de l'hôte, et un invité ne voit que la
  fenêtre de l'hôte.
- **Galerie** : une table D1 et une route à part (nouvelle migration), avec un
  plafond de chunks.
- **Infini vertical** : le même `shift` sur les rangées, des chunks carrés.
- **Gameplay** : réapparition du héros, objets à ramasser, biomes selon `x`.

## Questions encore ouvertes

- Hauteur du monde : 720 cellules suffisent-elles, ou faut-il l'infini vertical
  dès le départ ?
- Que devient le héros quand il meurt : il réapparaît au départ, ou à la
  dernière position sûre ?
- Faut-il la sauvegarde dans la galerie, ou le local suffit-il ?
