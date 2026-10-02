# Mode exploration : monde infini (plan)

**État : étape 1 faite** (`land()`, voir plus bas), étapes 2 et suivantes à
faire. Le bouton Explorer 🧭
(main.ts) fixe l'échelle : décor à `EXPLORE_SCALE` (terrain.ts), vue à
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

### 1. Générer par tranches de colonnes (terrain.ts, pur) — fait

**Fait.** `land()` et `STRIP` (256) dans terrain.ts. Sous-sol et relief
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

### 2. Décaler la fenêtre (`Engine.shift(dx)`)

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

### 3. Le mode dans le bac (sandbox.ts, nouveau `sim/explore.ts`)

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

### 4. La page suit l'origine (world.ts, view.ts, hero.ts)

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
