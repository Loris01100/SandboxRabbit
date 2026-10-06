# Le moteur de simulation

[src/client/sim/engine.ts](../../src/client/sim/engine.ts) et son registre
[materials.ts](../../src/client/sim/materials.ts). À lire avant toute
modification d'une règle ou d'une matière : la plupart des invariants ci-dessous
ne sont gardés par **aucun** test visible, seulement par l'empreinte globale
(voir [tests.md](tests.md#lempreinte-du-moteur)).

## État

Les conversions vers un entier utilisent `Math.trunc()` : coordonnées de
cellules, indices de blocs, grain du rendu et réductions d'argument de libm.ts.
Ces valeurs restent dans la plage des entiers signés de 32 bits. Les masques
et décalages binaires restent utilisés pour les commandes du héros et le
générateur déterministe ; `Math.trunc()` ne remplace pas ces opérations.

Tableaux plats de taille `width * height`, **aucun objet par cellule** — c'est
délibéré, pour pouvoir remplacer l'intérieur d'`Engine` par du Rust/WASM en
gardant l'interface (`step`, `paint`, `cells`).

| Tableau | Type | Contenu |
| --- | --- | --- |
| `cells` | `Uint8Array` | id de matière (`MATERIALS`) |
| `life` | `Uint8Array` | compteur multi-usage, voir plus bas |
| `temp` | `Float32Array` | °C, **réassigné à chaque tick** (double tampon) |
| `press` | `Float32Array` | pression de l'air (≥ 0, nulle hors de l'air), **réassignée à chaque sous-pas** (double tampon). Voir [Pression et vent](#pression-et-vent) |
| `clock` | `Uint8Array` | parité du tick où la cellule a déjà bougé |
| `frozen` | `Uint8Array` | 1 = figée à la main |
| `noise` | `Int8Array` | grain fixe par cellule (rendu) |

Scalaires : `gravity` (±1), `wind` (-1..1), `ambient` (°C, réglage de scène —
`AMBIENT` = 20 n'est que le défaut), `emit` (matière des `SOURCE` posées
ensuite), `seed` et `scan` (état du xorshift, sens du balayage). `gravity` et
`ambient` sont des accesseurs : les changer réveille tout le bac.

Sans graine explicite, le constructeur tire un entier de 32 bits avec
`crypto.getRandomValues()` ; une graine nulle devient 1. Les tirages pendant
la simulation restent ceux de `engine.rand()` (xorshift32), reproductibles
à graine identique pour le rejeu et le salon.

`heard` (`{ booms, loudest, at, bolts, boltAt }`) : ce que le bac a fait
d'audible, rempli par `settle()` (sur le fil du bac seul, jamais pendant le
damier) et par l'éclair de la météo (gestures.ts) ; sandbox.ts le relève dans
chaque frame et le remet à zéro. **Aucune règle ne le lit** : il ne pèse ni sur
l'empreinte ni sur le salon — ne jamais en faire dépendre la simulation.

Blocs de veille (privés, un octet par bloc de 16×16) : `stir` (bloc écrit ou
tenu éveillé depuis le dernier tick), `awake` (blocs traités à ce tick),
`was` (`awake` du tick d'avant). Voir [Blocs de veille](#blocs-de-veille).

## Un tick (`step()`)

1. `parity ^= 1`, puis `rouse()` : les blocs de `stir` et leurs huit voisins
   forment `awake` (`busy` en compte le nombre) ; un bloc qui vient de se
   réveiller remet `clock` à `parity ^ 1`.
2. **Le damier** : la grille est découpée en blocs de 32×32 (`PART`), traités
   en quatre phases — (x pair, y pair), (impair, pair), (pair, impair),
   (impair, impair). Chaque bloc (`block()`) est balayé **dans le sens de la
   gravité**, le sens en x alternant avec `parity`, en sautant la portion de
   rangée d'un bloc de veille endormi. Pour chaque cellule non vide, non
   figée, dont `clock` ≠ `parity` : `clock = parity`, puis `update()`.
3. `update()` : d'abord un `switch` sur les ids à règle propre (feu, lave,
   acide, TNT, étincelle…), sinon mouvement générique selon `kind`
   (`powder` / `liquid` / `gas`, `static` ne bouge pas).
   Avant `update()`, `hold()` peut **différer** une poudre ou un liquide
   (`FALLS`, créatures exclues). Les rangées de blocs paires passent avant
   les impaires, donc à une frontière sur deux (y = 32, 96…) le bloc du haut
   est balayé avant celui du bas. Un grain posé sur une colonne qui tombe
   dans le bloc du bas, pas encore jouée, attend la fin du damier. Sans ça,
   il voyait la case pleine, glissait en diagonale, et la colonne tombait en
   une rangée sur deux. La colonne ne compte comme « en chute » que si du
   vide ou du gaz se trouve à moins de 15 cellules : au-delà, un fil d'une
   autre phase peut écrire. Une très longue colonne garde donc une rangée
   trouée toutes les 16 environ. Une cellule posée sur une cellule différée
   est différée aussi (`held`). `swap()` efface la marque de la place
   d'arrivée : une cellule différée qu'un liquide plus dense passe dessous a
   bougé, et sa place d'avant porte ce qui l'a remplacée — qui, rejoué par
   `release()`, faisait un pas de trop.
4. `release()` : les cellules différées, triées dans l'ordre du balayage
   (celles du bas d'abord) et jouées seules, avec une graine à elles
   (`mix(tick ^ 0x27d4eb2f)`) : ni le nombre de fils ni l'ordre où ils les
   ont posées (`waiting`, `CTL.held`) ne comptent. Une place dont `held` a
   été effacé est sautée.
5. `settle()` : les explosions mises de côté pendant le damier (`blast()`),
   jouées une à une dans l'ordre du balayage, au souffle de leur matière
   (`BLAST`). Une charge déjà emportée par une voisine ne saute plus.
6. `thermal()`, en trois passes par bloc de veille éveillé ou écrit : les
   sources (`heat`) tirent leur cellule vers leur température
   (`heatChunk`), puis diffusion (`CONDUCTION`), retour vers `ambient`
   (`COOLING`) et changements d'état `boil` / `freeze` (`diffuseChunk`),
   puis recopie des blocs refroidis (`settleChunk`). Les tampons s'échangent.
7. `breathe()` : la pression de l'air, sautée tant que rien n'a soufflé.
   Voir [Pression et vent](#pression-et-vent).

Chaque passe (une phase du damier, une passe de chaleur) est une liste de
travaux (`jobs`) que `run()` fait seul ou répartit entre les fils du `pool` —
voir [Plusieurs fils](#plusieurs-fils). Toucher à l'ordre du balayage ou à
`clock` introduit des dérives visibles.

## Plusieurs fils

Le moteur peut se faire aider par des fils auxiliaires
([pool.ts](../../src/client/sim/pool.ts)) qui partagent sa mémoire
(`engine.memory`, des `SharedArrayBuffer` quand la page est isolée par
COOP/COEP) et exécutent une part de chaque passe (`engine.job()`). Sur la
scène 1080p chargée : 25,7 ms par tick sur un fil, 7,6 ms sur quatre, 5,6 ms
sur huit.

**Invariant central : le résultat ne dépend pas du nombre de fils.** Un hôte
à huit cœurs et un invité à deux restent en phase ; un navigateur sans
mémoire partagée simule seul, à l'identique ; test/pool.ts compare 1 et 4 fils
au bit près. Ce qui le garantit — et ce qu'une nouvelle règle doit respecter :

- **Portée ≤ 15 cellules.** Deux blocs d'une même phase sont séparés d'un
  bloc entier (32 cellules) : une règle qui lit ou écrit à plus de 15
  cellules de sa cellule peut croiser celle d'un autre fil. Les plus longues
  aujourd'hui : regard du lapin (8), accouplement (6), aimant (6), lapin qui
  bouge ou naît (≤ 6). Au-delà — les explosions, qui projettent à `r × 2,5` —
  passer par `blast()` : la demande est mise de côté et jouée par `settle()`.
- **Tirage par bloc.** `block()` repart de `mix(graine du tick, bloc)` ;
  `settle()` d'une graine à lui ; l'état global avance d'un cran par tick
  (`xorshift`), quoi que les blocs aient tiré. Jamais d'état partagé tiré
  pendant le damier.
- **Écritures partagées idempotentes** : `stir` (des 1), `awake[c]` et
  `hush[c]` du seul bloc de veille traité, `hero`, le compteur d'explosions
  et `CTL.gust` (des 1) par `Atomics`.
- **Réglages publiés** : un fil auxiliaire relit gravité, vent, ambiante,
  matière des sources, commandes du héros, parité, graine, tampons de
  température et de pression courants et présence de pression (`gusty`)
  dans `params` (`sync()`) avant chaque travail.

Le pool s'attache quand ses fils sont prêts (`bind()`), et se rattache à
chaque nouveau moteur (changement de taille) ; en attendant, le moteur fait
tout seul. Une passe de moins de quatre travaux ne réveille personne.

### La mécanique, de près

Tout tient dans deux tampons partagés, sans un `postMessage` par passe — il y en
a sept par tick.

- **La mémoire** (`Memory`) : la taille du bac et dix-huit tampons nommés, en
  `SharedArrayBuffer` quand la plateforme le permet (Node, page isolée),
  en `ArrayBuffer` sinon. Un fil auxiliaire fait
  `new Engine(w, h, 1, memory)` : une **vue** sur la même mémoire, qui ne
  construit rien (ni grain, ni `stir` rempli) et ne fait que les travaux qu'on
  lui confie.
- **`control`** (`Int32Array`, cases de `CTL`), lue et écrite par `Atomics`
  seulement : `gen` (génération de passe, c'est là qu'on attend), `job` (le genre
  de travail, `JOB`), `count` (combien), `next` (prochain travail à prendre),
  `done` (fils qui ont fini), `later` et `held` (compteurs des explosions et des
  cellules différées — la file `later` a une place par cellule, et `asked`, un
  octet par cellule, n'y laisse entrer chaque cellule qu'une fois par tick), `hero` (le cœur du héros piloté), `gust` (« il y a de la
  pression quelque part »).
- **`params`** (`Float64Array`, cases de `PARAM`) : ce que le coordinateur
  **publie** avant le tick (`publish()`) et qu'un fil **relit** avant chaque
  travail (`sync()`) — parité, graine du tick, gravité, vent, ambiante, matière
  des sources, commandes du héros, héros choisi, lequel des deux tampons de
  température et de pression est courant, et `gusty`. `sync()` écrit les champs
  directement, **sans passer par les accesseurs** : changer la gravité par
  l'accesseur réveillerait tout le bac, et ce n'est pas à un auxiliaire de le
  faire.
- **`jobs`** (`Int32Array`, un par bloc) : la liste du travail de la passe
  courante, remplie par le coordinateur (les blocs de la phase qui ont un bloc de
  veille éveillé, ou les blocs de veille éveillés pour la chaleur et la
  pression). `run(kind, count)` en fait les `count` premiers.

Une passe, dans l'ordre : `signal()` pose `job`, `count`, remet `next` et `done`
à zéro, incrémente `gen` et `Atomics.notify` ; chaque fil sort de son
`Atomics.wait(gen)`, `sync()`, puis **prend les travaux un à un** par
`Atomics.add(next, 1)` jusqu'à épuisement (`take()`) ; il incrémente `done` et le
signale. Le coordinateur prend sa part lui aussi, puis attend que `done` atteigne
le nombre de fils. Prendre les travaux un à un plutôt que par tranches égales
évite qu'un bloc coûteux (une explosion, un nid de nanites) ne retienne les
autres.

Les sept genres de travaux (`JOB`) : `cells` (un bloc du damier), `heat`,
`diffuse`, `settle` (les trois passes de la chaleur), `air` et `gust` (la
pression, `gust` au dernier sous-pas), `hush` (l'endormissement des blocs).
`stop` n'est pas un travail : c'est le signal qui fait sortir un fil de sa
boucle.

`bind(engine)` sert un nouveau moteur (bac neuf, autre taille) : l'ancien est
lâché (`JOB.stop`), les fils reçoivent la mémoire du nouveau avec un numéro de
**génération**, et le pool ne s'attache (`engine.pool = this`) qu'une fois tous
les « prêt » de cette génération revenus — en attendant, le moteur fait tout
lui-même, au même résultat. Un fil qui reçoit une mémoire déjà lâchée (deux
`bind()` coup sur coup) le voit d'emblée et rend la main : sans ça il attendait
pour toujours une passe qui ne viendrait plus.

## Blocs de veille

La grille est découpée en blocs de 16×16 (`CHUNK`). Un bloc où rien ne bouge
n'est ni balayé ni diffusé : un bac au repos en 1920×1080 tient sous la
milliseconde par tick, au lieu de 30. Un bloc est traité si lui ou un voisin a
été « remué » (`stir`) depuis le dernier tick, par :

- **une écriture** : `set` / `become`, `swap` (donc `tryMove`), `hurl`,
  `relocate`, `convert`, `decay`, `charge`, `paste`, `setFrozen`, les bascules,
  l'amorçage du C4 par `explode`. Chacune appelle `wake(i)` ;
- **une matière active** (table `ACTIVE`) : elle agit à chaque tick quoi
  qu'il y ait autour — gaz, créatures, uranium, nanites, braise, étincelle
  (compteur de vie ou d'emballement) — plus le métal en repos (`life` > 0) ;
- **une matière qui a de quoi agir** appelle `wake(i)` elle-même, et seulement
  alors : la plante qui touche de l'eau, la lave qui touche du sable ou de
  l'inflammable, l'acide qui touche ce qu'il ronge, le sel qui touche de la
  glace, la thermite allumée ou qui vient de prendre, la source dont la case
  de sortie est vide, la pile qui touche du métal (ou l'étincelle qu'elle
  vient d'y mettre), l'aimant qui a de la limaille dans son disque (`near()`,
  rangée par rangée, avant le parcours ordonné de `disc()`). Hors de `ACTIVE`
  exprès : sans rien à faire, un bac **plein** de l'une d'elles s'endort. En
  1920×1080, plein d'aimants il coûtait 2 s par tick, plein de sel, de
  thermite ou de sources 70 à 150 ms ; 0 depuis. Chaque arbre, chaque poche de
  lave d'un monde généré tenait de même son coin de bac éveillé pour rien. Le
  `wake(i)` se pose **avant** le tirage qui peut échouer (acide, sel), et la
  source tire toujours en premier : éveillées, ces règles tirent la même
  suite qu'avant, et l'empreinte n'a pas bougé ;
- **une cellule qui passe son tour** à cause de `clock` (filet : un grain
  peint dans le vide garde l'horloge quelconque de la cellule vide) ;
- **un liquide bloqué d'un côté mais libre de l'autre** (`canMove()`) : il ne
  tente qu'un côté par tick, tiré au sort, et resterait suspendu ;
- **la pression** : un bloc qui garde de la pression au-dessus de `CALM_P`
  reste éveillé, et ne s'endort qu'une fois remis à zéro (voir
  [Pression et vent](#pression-et-vent)) ;
- **la chaleur** : un bloc dont une cellule varie de plus de `STILL`
  (0,001 °C/tick) reste éveillé. Un bloc refroidi recopie sa température dans
  l'autre tampon, pour lire la même chose endormi. Un bloc endormi ne fait
  pas le tirage de ses sources vers leur `heat` : quand la diffusion d'un bloc
  éveillé lit une voisine dans un bloc endormi (`awake` = 0), elle passe par
  `pulled()`, qui lui applique ce tirage. Sans ça, une mer de lave à
  l'équilibre (1153,7 °C avant tirage, 1176,9 après) montrait 23 °C d'écart à
  chaque frontière entre blocs endormi et éveillé, et restait éveillée pour
  toujours : 180 ms par tick en 1920×1080 sans qu'une cellule ne bouge, 0,6
  depuis. test/sim.ts le vérifie (mer de lave en 128×72, surface à mi-bloc).
  Tester `awake === 0` est sans risque en multi-fils : pendant la diffusion,
  un bloc ne passe que de 1 à 2, jamais par 0.
- **un bloc éveillé mais à l'ambiante** : si le bloc et sa bordure sont tous
  à l'ambiante exacte, sans source ni matière que l'ambiante ferait changer
  d'état (table `calm`, recalculée quand l'ambiante change), `flat()` fait
  sauter le calcul de la diffusion : il recopie la température et déclare le
  bloc refroidi. Le résultat est identique au bit près (`sum - 4t` vaut 0
  exactement). C'est le cas de presque tous les blocs réveillés par de l'eau
  ou du sable qui bougent : 3238 blocs éveillés sur 3254 dans le chantier en
  1920×1080. Une ambiante qui n'est pas un f32 exact (20,3) ne prend jamais
  ce raccourci : c'est plus lent, mais toujours juste.

Invariants :

- **Toute écriture dans `cells`, `life`, `temp` ou `frozen` hors des méthodes
  du moteur est suivie de `engine.wakeAll()`** (c'est ce que fait `restore()`
  dans sandbox.ts ; `put()` passe par `adopt()`, qui le fait). Sinon un bloc
  endormi ignore ce qu'on vient d'y poser. Même règle pour une nouvelle
  écriture directe dans le moteur : `this.wake(i)`.
- **Une matière qui agit d'elle-même** (compteur dans `life`, tirage qui finit
  par réussir, lecture au-delà des voisines immédiates) tient son bloc
  éveillé : par `wake(i)` quand elle a de quoi agir (de préférence — un bac
  plein d'elle s'endort alors), sinon en entrant dans `ACTIVE`. Sans l'un ni
  l'autre, son bloc s'endort et elle se fige. Au-delà de 15 cellules, un
  voisin qui change ne réveille plus le bloc : la portée de l'aimant (5) y
  tient.
- **Déterminisme** : quels blocs dorment dépend de toute la partie. `wakeAll()`
  remet tout à plat (tous réveillés, horloges remises), et chaque départ de
  rejeu ou de salon passe par `put()` → `adopt()` → `wakeAll()`, chez l'hôte
  comme chez l'invité. Un départ qui ne passerait pas par là ferait diverger
  les tirages.
- **`shift(dx)`** (mode exploration, [exploration.md](exploration.md)) fait
  glisser la fenêtre de `dx` colonnes, multiple de `CHUNK`, entre deux ticks
  seulement. Tout glisse avec la grille : `cells`, `life`, `frozen`, `clock`,
  `noise`, l'élan, et **les deux** tampons de `temp` et de `press` (un bloc
  endormi lit l'un ou l'autre) ; `stir`, `awake`, `was`, `hush` d'autant de
  blocs. La bande neuve est vide, à l'ambiante, sans pression ni grain,
  `stir` à 1 et `awake` à 0 : `rouse()` la traite en bloc fraîchement
  réveillé et y remet les horloges. `shown` (les blocs à redessiner) glisse
  aussi, sans être remis à 1 : la page fait glisser son miroir d'autant
  (`glide()` de render.ts) et ne reçoit que la bande neuve et ce qu'ont
  changé les ticks. Pression et élan ne glissent que si `CTL.gust` vaut 1 :
  à 0, ils sont nuls partout, dans les deux tampons (un bloc calmé est remis
  à zéro, un bloc endormi l'est déjà, `puff()` lève le drapeau) — vérifié sur
  1 102 ticks calmes après 398 ticks d'explosions. `hero` glisse (ou passe à
  -1 s'il sort, et `find()` le cherche au tick suivant) ; pas de `seek`, qui
  relisait toute la grille deux fois à chaque glissement — un héros apporté
  par la bande neuve passe par `paste()`, qui le demande. Un nouveau tableau par cellule ou par bloc qui vit
  d'un tick à l'autre doit être ajouté à `shift()`, sinon il reste en place
  sous la grille qui glisse : test/sim.ts (aller-retour, puis 200 ticks
  comparés à un bac resté en place) et test/pool.ts (1 fil contre 4, fenêtre
  qui glisse) l'attraperaient.
- Un bac au repos a `busy` = 0 : plus un bloc balayé. C'est ce que vérifie
  test/sim.ts (le tirage, lui, avance d'un cran par tick quoi qu'il arrive).

## Invariants

### Reproductibilité

- **Tout tirage passe par `engine.rand()`** (xorshift32 : semé au
  constructeur entre les ticks, par bloc pendant le damier — voir
  [Plusieurs fils](#plusieurs-fils)), jamais `Math.random()`. Un `Math.random()` dans une règle casse le rejeu et
  la comparaison avec un futur moteur WASM. L'empreinte de test/sim.ts ne
  l'attrape que si sa scène réveille la règle fautive ; sinon **aucun test ne
  le voit**. Même règle hors du moteur pour ce qui fait partie de la partie
  (`weather()`). Seule exception : la graine par défaut du constructeur.
  Le générateur de mondes ([terrain.ts](../../src/client/terrain.ts), et
  celui du monde infini dans [sim/explore.ts](../../src/client/sim/explore.ts))
  tire, lui, sur un xorshift à lui semé par la graine du monde : un monde est une
  grille posée d'un coup (`stamp()`), un invité le reçoit tout fait et ne
  rejoue pas sa construction — elle ne doit donc rien prendre au tirage du bac.
- **Mêmes calculs dans tous les navigateurs.** + − × ÷ et `Math.sqrt` sont
  arrondis exactement par IEEE 754 ; `hypot`, `sin`, `exp`, `pow`, `log`…
  sont « approchés selon l'implémentation » et peuvent différer d'un bit
  entre Chrome et Firefox. Interdits dans engine.ts, terrain.ts et sim/explore.ts : `disc()`
  employait `hypot`, et un salon mixte pouvait diverger à la première
  explosion. Les tests tournent tous sous V8 et ne le verraient pas — test/sim.ts
  lit donc la source.
- **Besoin d'un angle, d'une onde, d'une décroissance ?**
  [sim/libm.ts](../../src/client/sim/libm.ts) : `sin`, `cos`, `atan`,
  `atan2(y, x)`, `exp`, `log`, écrites en + − × ÷ et lectures de bits, donc
  les mêmes bits partout. C'est la copie ligne à ligne de musl, telle que la
  porte la crate Rust `libm` (0.2.16) : `npm run rust` exige les mêmes bits
  sur un million d'arguments par fonction, et un moteur Rust appellerait la
  crate. Mesuré : `sin` et `cos` de V8 diffèrent de musl d'un ulp sur 1 % des
  arguments — deux implémentations correctes, pas les mêmes bits. Limites :
  pas de `pow` (`exp(y * log(x))` est déterministe aussi, à ~1e-13 près), et
  `sin` / `cos` rendent NaN au-delà de |x| ≈ 1,6 million (`ponytail:` de
  `remPio2`). Environ 30 à 60 ns par appel sous V8 : de quoi en semer dans
  une règle, pas dans chaque cellule de chaque tick. libm.ts ne se retouche
  qu'avec la crate : une constante ou un ordre d'opérations changé, et
  `npm run rust` échoue.
- Changer **l'ordre** des tirages d'une règle change l'empreinte, même à
  comportement visible identique. C'est voulu.
- Rejouer en cours de partie exige les tableaux **plus** `seed`, `scan` et
  `clock` (une cellule fraîchement peinte garde l'horloge de ce qui l'occupait).
  C'est pour ça que `clock` est publique et que replay.ts la sérialise. Depuis
  les blocs de veille, `put()` remet toutes les horloges au premier tick : la
  sérialiser ne coûte rien et reste juste si ce réveil change un jour.

### Mouvement

- Toute règle de déplacement passe par `y + this.gravity` et `drift()` (vent).
  Exceptions : `MAGNET`, qui tire la limaille d'un cran vers lui en ignorant
  la gravité, le lapin, dont les neuf cellules bougent d'un bloc par
  `relocate()` (voir [Créatures](#créatures--le-lapin)), et le gaz ou la
  poudre que pousse la pression (`blown()`, `swept()`, voir
  [Pression et vent](#pression-et-vent)).
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
  règle dans `Engine`**. Seule exception : une créature, qui doit changer
  d'état en entier — `thermal()` ne changerait que son cœur. Pas de cycle (`A → B → A` sur des seuils qui se
  chevauchent) : l'assert du registre le refuse.
- Seuils calibrés à ne pas « simplifier » :
  - pétrole `boil` à 200 °C : à 80 une flamme voisine suffisait ;
  - pierre `boil` à 1400 °C : la lave ne chauffe la roche qu'à ~800, seule la
    thermite (2800) creuse. Baisser ce seuil fait fondre le décor de toutes
    les scènes de lave.

### Performance du chemin chaud

Ce qui a déjà été optimisé, et de combien : [performance.md](performance.md).

Ce que la boucle lit par cellule et par tick est **dérivé** de `MATERIALS` au
chargement, en tableaux typés indexés par id : `KIND`, `DENSITY`, `HEAT`,
`BOIL_AT` / `BOIL_INTO`, `FREEZE_AT` / `FREEZE_INTO`, `SPREAD`, `LIFE`,
`FLAMMABLE` (engine.ts), `palette` et `grain` (render.ts). `FLAMMABLE` est en
`Float64Array` : en 32 bits, 0,6 devient 0,60000002 et déplace les seuils de
tirage. Lire `MATERIALS[id].density` dans `displaces()` ou
`.noise` dans `draw()` annule le gain (le tick est passé de 1,6 à 0,7 ms en
320×180). Une nouvelle propriété lue dans le chemin chaud mérite sa table.

Pour savoir ce qui coûte : `node --cpu-prof` sur un script qui fait tourner
une scène, puis additionner le temps propre (`timeDeltas`) par fonction du
`.cpuprofile`. V8 intègre les petites règles dans `update()` : son temps
propre est surtout celui des règles de matière. C'est ainsi que la lave a été
vue relisant ses quatre voisines dans `ignite()` sans rien d'inflammable
autour (40 % du tick d'un lac qui coule) : elle ne l'appelle plus que si une
voisine brûle, à tirages identiques.

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

- `adopt()` ne filtre que `cells`. `life` arrive tel quel (bloc 3 du codec,
  `paste()` d'un `clip`) : une règle qui y lit un **id de matière** (la
  `SOURCE`) le passe par la table `KNOWN`. Un id inconnu dans le `life` d'une
  source arrêtait le bac sur un lien de cinquante caractères.
- Un geste venu d'un pair peut porter des coordonnées non entières :
  `applyGesture` les refuse (`whole()`), et `fill()` se garde aussi — en
  x = 1,5 ses écritures tombaient à côté du tableau et sa pile ne se vidait
  jamais.
- Un rejeu importé (lien, fichier) passe en entier par `vet()` de replay.ts
  avant d'atteindre le bac : ses grilles et ses gestes sont rejoués plus tard,
  en plein tick, là où une levée (`atob` sur un caractère hors base64, par
  exemple) couperait le rejeu. Un nouveau champ de `Recording`, de `Scene` ou
  de geste s'ajoute aussi à ce crible (`FIELDS` pour un geste). Le salon
  s'y soumet aussi : l'hôte passe chaque geste d'invité par `isGesture()`
  avant de l'appliquer et de le relayer, l'invité passe le départ de l'hôte
  par `vet()` et chaque `turn` par `vetBeats()` (sans redécoder la grille de
  départ). Un `clip` au base64 abîmé faisait sinon jeter l'hôte.
- Si le moteur jette malgré tout, la boucle de sim/worker.ts repose son
  échéance dans un `finally` : l'erreur remonte, le bac ne s'arrête plus.

## Les usages de `life`

`Uint8Array` : donc `life` ≤ 250 dans `MATERIALS`. **Ne jamais le
réinitialiser à l'aveugle**, chaque matière en fait autre chose.

| Matière | `life` signifie |
| --- | --- |
| gaz (feu, fumée, vapeur, grisou, retombées), nanites, braise | ticks restant à vivre |
| `NITRO` | cellules de chute (au-delà de `SHOCK` = 4, l'atterrissage détonne) |
| `C4` | amorçage (1 = saute au tick suivant) |
| `THERMITE` | ticks de combustion |
| `SOURCE` | la matière émise (0 ou id inconnu : de l'eau) |
| `CANDLE` | mèche allumée |
| `METAL` | ticks de repos après une étincelle (`RECOVERY`) |
| `RUST` | humidité (`WET` = 250 contre l'eau, `SEEP` de moins par voisine, sèche d'un cran par tick) |
| `SWITCH` | 1 = fermé |
| `URANIUM` | compteur d'emballement |
| `MAGNET` | pôle (1 = repousse) |
| `RABBIT` | satiété du cœur (0 au chargement d'un monde sans état vivant = repart pleine) ; les cellules du corps n'en ont pas |
| `HERO` | bit 7 = tourné vers la gauche (où il creuse), bits 0-3 = élan de saut restant ; perdu, il repart debout vers la droite. Le corps n'en a pas |
| `HERO_HEAD`, `HERO_BODY`, `HERO_LEGS` | la fiche du héros, une donnée par cellule (`HERO_SLOTS` de materials.ts) : tête = numéro (1-250, 0 = pas encore tiré), buste = dégâts (mort à `HERO_HARM`), bras gauche = âge au-delà de 18 ans, bras droit = matière du sac (0 = vide), jambe gauche = cellules creusées (plafonnées à 250), jambe droite = cellules dans le sac (`BAG` = 250 au plus ; c'était le compteur des cellules posées, relu comme un sac de matière 0, donc vide). Tout à zéro = héros neuf en pleine santé |

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
| `SODIUM` | eau (douce ou salée) au contact ; le feu ne lui fait rien. Densité 3 : il flotte, donc la touche toujours. Petit souffle (`SPLASH` = 4) : c'est le nombre de grains qui fait le dégât, chaque grain projeté qui retombe dans l'eau repart |
| `FIREDAMP` | volume (gaz `flammable` 1) |
| `URANIUM` | masse (≥ `CRITICAL` voisins identiques), sans rien d'extérieur |
| `THERMITE` | l'anti-explosif : perce au lieu de souffler |

- Une règle ne fait jamais sauter directement : elle **demande** l'explosion
  (`blast(x, y)`), jouée à la fin du damier par `settle()`. Un souffle porte
  bien au-delà des 15 cellules que le damier garantit (voir
  [Plusieurs fils](#plusieurs-fils)).
- Le souffle dépend de la **matière**, pas de qui le demande : `BLAST` (rayon,
  + 256 avec les retombées de `nuke()`) — l'étincelle fait sauter le TNT au
  même rayon que la flamme. Un nouvel explosif y ajoute sa ligne, sinon sa
  demande est ignorée (`EXPLOSIVE` en est dérivée). C'est ce qui permet de
  ne garder qu'**une demande par cellule et par tick** (`asked`, remis à zéro
  par `settle()`) : la file `later` a une place par cellule et ne peut plus
  déborder. Plafonnée au quart de la grille, elle perdait les demandes en trop
  quand un quart du bac sautait au même tick — et lesquelles dépendait des
  fils. test/sim.ts en fait sauter la moitié.
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

### Pression et vent

Un champ `press` (voir `breathe()` dans engine.ts) : de la pression dans
l'air, qui pousse les gaz de la haute vers la basse. Seul l'air la porte
(table `OPEN` : vide et gaz) ; toute autre cellule vaut 0 et l'arrête comme un
mur, et une voisine qui n'est pas de l'air compte pour la cellule elle-même
(rien ne passe à travers).

- **Une seule porte d'entrée : `puff(i, montant)`.** Elle n'écrit que dans
  l'air, plafonne à `MAX_P`, réveille le bloc et lève `CTL.gust`. Une écriture
  directe dans `press` laisserait un bloc endormi avec de la pression, ou
  `breathe()` sauté. Sources aujourd'hui : `explode()` (l'onde, voir
  ci-dessous) et l'eau vaporisée par la lave (`STEAM_PUFF`, à une cellule).
- **L'onde d'un souffle** (`wave()`, appelée à la fin d'`explode()`) : un
  volume de gaz fixe, `gas(portée)` — ce que la pente `BLOW` dépose sur tout
  le disque de portée `REACH` rayons —, réparti par un parcours en largeur
  **à travers l'air seulement**, depuis l'air du cratère. Elle contourne les
  coins mais ne traverse pas un mur ; dans une pièce close, le même gaz n'a
  que la pièce et la pression monte d'autant (jusqu'à `CONFINED` fois).
  Posée d'un coup : à 60 ticks par seconde, une onde de choc traverse le bac
  en moins d'un tick. Jouée par `settle()`, seul : elle dépasse le damier.
  Son parcours (`seen`, `queue`) est à ce fil-là.
- **Ce que la pression casse et soulève**, deux règles du damier qui ne lisent
  rien tant que le tick a commencé sans pression (`gusty`) :
  - `shatter()` (règle du `GLASS`) : au-delà de `SHATTER` dans l'air qui le
    touche, le verre devient du sable, avec une chance qui croît avec
    l'excès. Du sable, faute de matière « éclats » : c'est du verre broyé, qui
    refond en verre à la chaleur et que l'onde emporte ensuite ;
  - `swept()` (en tête d'`updatePowder()`) : chaque côté vaut la plus forte
    pression de l'air parmi ses trois cellules, diagonales comprises (`side()`
    ; un côté sans air prend la valeur d'en face). Au-delà de `SWEEP_MIN` —
    bien plus que pour un gaz, sinon chaque dune d'un monde glissait —, la
    poudre part avec une chance divisée par sa densité ; poussée de côté mais
    bloquée, elle est soulevée en biais. Lecture à une cellule : sans risque
    en multi-fils.
- **L'air a de l'élan** : `windX[i]` sur la face entre i et sa voisine de
  droite, `windY[i]` entre i et celle du dessous (positif vers la droite, vers
  le bas), un `Float32Array` partagé chacun. Une onde **voyage** (un souffle
  au bout d'un couloir y arrive en front, et rebondit), au lieu de s'étaler
  comme la diffusion d'avant.
- **`breathe()`**, après la chaleur : `AIR_STEPS` sous-pas sur les blocs
  éveillés, chacun en deux passes partagées entre les fils :
  - `JOB.wind` (`windChunk()`) : chaque face que tient le bloc prend `WIND_K`
    (0,25 ; stable sous 0,5) fois la différence de pression de part et
    d'autre, puis garde `DRAG` (0,97) de son élan. Une face qui touche autre
    chose que de l'air, ou le bord, est nulle. Le bloc n'écrit que ses faces
    et ne lit que `press`, que personne n'écrit pendant cette passe. Sauté
    quand `still()` : pression nulle sur le bloc **et sa bordure**, élan nul
    **sur le bloc seul** — l'élan de la bordure, un bloc voisin l'écrit
    pendant cette même passe (le lire faisait diverger 1 et 4 fils) ;
  - `JOB.air` (`JOB.gust` au dernier, `airChunk()`) : la pression de chaque
    cellule prend ce que ses quatre faces apportent ou emportent, puis `DAMP`,
    bornée à 0. Au dernier sous-pas, un bloc sous `CALM_P` en pression et
    `CALM_V` (0,005) en élan est remis à zéro (`hush`) ; un bloc agité se
    tient éveillé, **réveille ses quatre voisins** (l'onde y entre au tick
    suivant au lieu de buter sur un bloc endormi) et relève `CTL.gust` ;
  - `JOB.hush` vide l'autre tampon **et l'élan** des blocs calmés. Pas
    `airChunk()` : ses voisins lisent encore cet élan pendant la passe.

  `CTL.gust` à 0 : toute la passe est sautée, un bac sans explosion ne paie rien.
- **Invariant : un bloc endormi a une pression nulle dans les deux
  tampons, et un élan nul.** Il ne s'endort qu'une fois remis à zéro, et
  `puff()` le réveille. Ses voisins le lisent donc sans équivalent de
  `pulled()`.
- `hushed()` saute le calcul d'un bloc sans pression ni élan, bordure
  comprise : le sous-pas y rendrait 0 au bit près, la pression n'étant
  jamais négative (pas de -0). Sans lui, une salve dans le chantier coûtait
  42 ms par tick.
- **Le vent** : `blown()`, en tête de `moveGas()`, pousse le gaz d'une cellule
  dans le sens de l'élan de l'air (moyenne de ses faces, divisée par
  `WIND_K` pour retrouver l'échelle d'un gradient), avec une chance `GUST` ×
  cet élan. Sous
  `GUST_MIN`, ou si le tick a commencé sans pression (`gusty`), il ne lit ni
  ne tire rien : sans souffle, les gaz montent aux mêmes tirages qu'avant.
- **La pression ne voyage pas** : ni codec, ni rejeu, ni salon. `wakeAll()`
  la remet à zéro, élan compris, donc tout départ (`put()` → `adopt()`), annulation,
  gravité ou ambiante changée repart sans pression, chez l'hôte comme chez
  l'invité. Elle ne vit qu'une seconde : personne ne le voit.
- Calcul en f64 rangé en f32, même ordre d'additions que la chaleur : le port
  Rust (`air()` de rust/src/lib.rs) le reproduit au bit près, voir
  [docs/rust.md](../rust.md). Un changement de `windChunk()`, `airChunk()`,
  `still()` ou `hushed()` se reporte dans lib.rs.
- Ce n'est toujours pas un fluide complet : l'air n'a ni convection ni
  transport, il ne porte ni la fumée ni la chaleur — seulement une onde qui
  pousse les gaz et les poudres.
- **La vue pression** (touche `b`) lit `press` par palier (`airLevel()` de
  render.ts, 1/8 d'unité, un octet par cellule dans les bandes) : voir
  [Rendu](#rendu).

### Électricité

- `SPARK` ne se propage que dans `METAL`, et le métal traversé garde
  `RECOVERY` ticks de repos (sinon l'étincelle repart en arrière et le circuit
  ne s'éteint jamais).
- Tout ce qui met un fil sous tension passe par `charge()` (étincelle,
  `BATTERY`, `SWITCH` fermé).
- `METAL` mouillé (eau douce ou salée au contact) rouille : `updateMetal()`
  tire `RUST_FRESH` (1/2400) ou `RUST_SALT` (1/480) par tick et devient `RUST`,
  qui ne conduit pas. Le tirage n'a lieu **que** contre l'eau (un fil sec ne
  tire rien), et le métal mouillé appelle `wake(i)` : sinon un fil au fond
  d'un lac étale s'endort et ne rouille jamais.
- **L'eau passe par la rouille** : `RUST` garde son humidité dans `life`
  (`updateRust()`) — `WET` au contact de l'eau, sinon celle de sa voisine la
  plus humide moins `SEEP` (25), et elle sèche d'un cran par tick. Le métal
  qui touche une rouille humide rouille avec la chance `RUST_FRESH × humidité
  / WET` : une poutre trempée est rongée jusqu'à dix cellules du bord, pas
  seulement en surface. Humide, la rouille réveille son bloc et le métal
  voisin (c'est elle qui agit) ; sèche, elle ne tire rien et dort.
- `SWITCH` ne devient **jamais** une étincelle : il la relaie. Sinon il
  redeviendrait `METAL` à l'extinction et disparaîtrait.

### Créatures : le lapin

Une créature est une **forme** (`Shape` dans engine.ts : offsets `dx` / `dy`
depuis le cœur et matière de chaque case, le cœur d'abord). Pose, corps
entier, mort, déplacement d'un bloc et cellules du corps sont communs :
`spawn()`, `intact()`, `kill()`, `maim()`, `relocate()`, `updatePart()`
prennent la forme en premier argument. Une nouvelle créature = une forme, ses
matières (`creature` pour le cœur, `part` pour le reste) et sa règle de cœur.

Un lapin = **neuf cellules de forme fixe** (`RABBIT_SHAPE`, tirée de
`RABBIT_DX` / `RABBIT_DY` / `RABBIT_ID`). Le cœur (`RABBIT`) porte la satiété et décide de
tout ; le reste du corps (`RABBIT_BODY`, `RABBIT_EYE`, `RABBIT_TAIL`, hors
palette, `part` dans `MATERIALS`) n'a aucun état. Ordre d'un tick du cœur :
vérifier le corps, cuisson, gel, étouffement (un liquide ou une poudre sur la
tête : `airway()` et `stifling()`, partagés avec le héros), faim, chute, puis
— posé — manger, se reproduire, se déplacer.

- **Le corps ne dépend pas de `life`.** Le sens (gauche / droite) se lit sur
  le corps (`intact()` compte les cellules en place pour chaque sens), et une
  cellule du corps vit tant qu'un cœur est là où la forme l'attend
  (`updatePart()`). Voulu : le salon n'envoie que `cells` et `frozen`, et
  `put()` remet `life` à zéro pour une grille sans état vivant — un invité
  promu hôte garde ainsi ses lapins.
- Couleurs de l'œil et de la queue = matières à part, pas une teinte tirée de
  `life` : le salon et les vignettes ne voient que `cells`.
- Cœur seul (posé par `set()`) : il se refait un corps s'il a la place, sinon
  il meurt. Corps incomplet : le lapin meurt en entier (en feu si une partie
  brûle).
- `relocate()` bouge les neuf cellules ensemble ou pas du tout. Cases
  d'arrivée : les siennes, du vide, un gaz, ou — en tombant — un liquide plus
  léger ; ce qu'il déplace reprend les cases quittées (matière conservée). Il
  ne **marche** que vers du vide ou un gaz : il n'entre pas dans l'eau de
  lui-même, il y tombe.
- Cuisson (`COOK`) et gel (`FROST`) sont des règles, pas `boil` / `freeze`.
- Pose : `paint()` et `rect()` appellent `spawnRabbit()` (un lapin, quel que
  soit le rayon) ; `fill()` ignore les créatures (table `CREATURE`).
- La fuite compare `temp` des deux cases qui encadrent le corps et passe avant
  la faim.
- La reproduction coûte `LITTER_COST` au parent et le petit naît sous `BREED` :
  sans ces deux freins, un enclos de lapins repus double à chaque tick.
- Acide et retombées le tuent via `CREATURE`, le feu via `flammable`.
- Coût : ~70 lectures par lapin et par tick (corps, parties, regard). Si des
  centaines de lapins pèsent au bench, `sniff()` et `intact()` d'abord.
- **La forme suit la gravité** : `tall(shape)` rend le sens des `dy`
  (`fall` pour le lapin, 1 pour le héros, que la page lit à des places
  fixes) dans `spawn()`, `intact()`, `kill()`, `maim()`, `relocate()`,
  `updatePart()`, comme la bouche, la naissance, `airway()` et `sniff()`.
  Gravité inversée, il a les pattes au plafond. Le setter `gravity` retourne
  ceux qui sont déjà là (`turnRabbits()`, entre deux ticks, avant de changer
  `fall`) **dans leur boîte** : le cœur se décale d'une rangée, la satiété
  suit. Retourné autour du cœur, un lapin posé avait les oreilles dans le sol
  et mourait écrasé. Une case de la boîte prise par autre chose laisse le
  corps incomplet : il meurt au tick suivant.

### Créatures : le héros

Sept cellules (`HERO_SHAPE` : tête, buste et bras, hanches = cœur `HERO`,
jambes), symétriques — son sens se garde dans `life`. **Il n'a pas de volonté**
: il obéit à `engine.pilot`, six bits (`PILOT` dans materials.ts : gauche,
droite, saut, creuser dessous, creuser devant, poser) et, bits 8-15, la matière
qu'il pose. **Seul le héros piloté obéit** (`engine.chosen`, son numéro) ;
les autres attendent debout, mais vivent (chute, dégâts, âge).

- `pilot` n'est posé **que** par le geste `pilot` (gestures.ts) : c'est ce qui
  l'enregistre dans le rejeu et le relaie à l'hôte d'un salon. Il figure aussi
  dans la `Scene` du rejeu, pour un enregistrement lancé touche enfoncée.
- Ordre d'un tick : corps entier, dégâts — `SCALD` par tick au-delà de
  `COOK` ou sous `FROST`, `CHOKE` la tête dans un liquide ou une poudre
  (`airway()`, `stifling()`), sinon un de guéri avec la chance `MEND` ; mort à
  `HERO_HARM`, en feu, en glace ou noyé —,
  numéro tiré s'il n'en a pas, un an avec la chance `YEAR` (une journée du
  cycle, 240 s), creuser, puis un mouvement vertical — saut (`JUMP` ticks
  de montée), nage (saut tenu dans un liquide), chute (lente dans un liquide,
  `SINK`) — et un pas de côté (`STRIDE`), qui grimpe une marche d'une cellule.
- **Ce qu'on respire** se lit par `airway()`, commun aux deux créatures : la
  cellule au-dessus de la tête, sinon — si c'est une créature — les côtés de
  la tête, où le corps ne tient qu'une cellule, sinon la colonne au-dessus
  (15 cellules au plus, la portée que le damier garantit). Sans ces deux
  replis, des créatures empilées ne voyaient au-dessus de leur tête que le
  corps du voisin : seule celle du haut se noyait. Les côtés passent avant la
  colonne, qui ferait du voisin un tuba ; une pile serrée (les corps se
  chevauchent d'une rangée) les occupe, d'où le troisième essai.
- `stifling()` dit de quoi on étouffe : un liquide (noyade) **ou une poudre**
  (enseveli sous une dune, sous la neige, sous ce qu'on vient de creuser). Le
  héros y perd `CHOKE` par tick, le lapin meurt d'un coup avec la chance
  `DROWN`. La nage, elle, ne tient qu'au liquide (`wet`) : on ne nage pas dans
  le sable.
- Contrairement au lapin il **marche dans l'eau** (`relocate(…, wet)` partout)
  : plus dense qu'elle, il y coule et nage en sautant.
- Il creuse le solide (statique ou poudre) par `become()`, sauf `METAL` et les
  créatures ; une cellule figée tient bon.
- Il pose (`lay()`) la matière de `pilot >> 8` dans du vide ou un gaz : devant
  ses pieds (une marche), ou saut tenu sous lui (un pilier). À **chaque** tick,
  avant le pas — au hasard, il marchait plus vite qu'il ne posait et tombait de
  son escalier. La matière est filtrée par `placeable()` (materials.ts) dans
  `applyGesture`, seule porte d'entrée de `pilot` (rejeu compris) : le moteur
  ne la revérifie pas, 0 = rien à poser.
- **Le sac** : ce qu'il creuse va au sac (`stash()`) s'il est vide ou porte
  déjà cette matière, et qu'elle se pose (`PLACEABLE`), jusqu'à `BAG` = 250 ;
  sinon elle est perdue. Il pose (`put()`) du sac d'abord, de la palette
  quand il est vide. Le sac vit dans la fiche (`HERO_SLOTS.bag` et `.load`)
  et, le temps du tour, dans `bagId` / `bagN` — des champs du moteur, mais
  propres à chaque fil (le moteur d'un fil ne joue que ses héros), relus en
  tête d'`updateHero()` et rangés à la fin.
- **Sa fiche vit dans son corps** (`HERO_SLOTS`) : le `life` du cœur est
  plein (sens, saut) et rien ne se garde hors des cellules (plusieurs fils,
  salon). `relocate()` emporte le `life` de chaque case — le lapin n'y a que
  des zéros, son empreinte n'a pas bougé. Écrite en fin de tick, à la
  position d'arrivée ; `dig()` rend ce qu'il a creusé pour le
  compteur.
- Son **nom** n'est pas dans la grille : le numéro en choisit un dans `NAMES`
  (gestures.ts), sauf nom donné par le geste `name`, rangé dans
  `engine.names` (que le moteur ne lit pas) et sauvé en 5ᵉ bloc du codec.
- **Son numéro est unique** (`enlist()`). `chosen` *est* un numéro : deux héros
  qui le partagent obéissent ensemble aux touches, portent le même nom et
  `find()` rend l'un ou l'autre. `enlist()` balaie le bac deux fois — qui porte
  quoi, un doublon perdant le sien (le premier du balayage le garde, pour que
  le piloté reste piloté), puis le premier numéro libre à partir de la place
  du cœur, sans `rand()` : `terrain()` n'a pas le droit d'en consommer. Il
  tourne **hors du damier** (il lit tout le bac, un fil ne voit que sa part) :
  à la pose (`pick()`) et en tête de `step()` quand `seek` est levé. Une règle
  ne peut donc pas en tirer un : un héros né pendant le damier (un cœur posé
  par `set()` qui se refait un corps) vit sans numéro — il n'obéit à personne,
  `name !== 0` le garde — jusqu'au prochain `enlist()`. Au-delà de **250 héros
  vivants**, les suivants restent à 0 pour la même raison.
- `engine.chosen` ne change **qu'entre deux ticks** — il est publié aux fils
  (`PARAM.chosen`) : héros posé par `paint` / `rect` / `spawnHero` (`pick()`,
  qui le numérote s'il n'en a pas), geste `hero` (`nextHero()`,
  suivant dans l'ordre de la grille), ou `find()` en tête de `step()`. Celui-ci
  retrouve le piloté **par son numéro** quand la grille a été remplacée
  (`seek`, levé par `adopt` et `paste` : `hero`, un index, ne voyage ni avec
  un rejeu ni avec un salon) ou qu'il a disparu, et passe sinon au premier
  héros du balayage. Il ne balaye le bac que dans ces cas-là. `chosen` est
  dans la `Scene` du rejeu, comme `pilot`.
- `engine.hero` = index du cœur du héros piloté, tenu par son `updateHero()`
  (avant : le dernier héros mis à jour, et la caméra sautait de l'un à
  l'autre au gré du balayage et du nombre de fils). Sandbox le joint à
  chaque frame (`hero`), vérifié (`cells[hero] === HERO`), et la page fait
  suivre la caméra.
- `terrain()` (terrain.ts) en pose un au sec, au plus près du centre.

## Rendu

Les **règles d'aspect** ci-dessous valent pour les deux coloriages ; la
mécanique de celui de la page (textures, programmes, éclairage global) est dans
[rendu.md](rendu.md).

1 cellule = 1 pixel, mise à l'échelle par CSS `image-rendering: pixelated`.
**Pas de dessin par cellule.** Le Worker ne colorie plus : c'était 6 ms par
tick en 1920×1080 chargé (`npm run directions`).

- **Worker** : `Tracker` ([render.ts](../../src/client/sim/render.ts)) suit
  les [blocs de veille](#blocs-de-veille). À chaque frame il découpe les blocs
  que `engine.changed()` désigne (traités par un tick, ou écrits depuis — un
  geste bac en pause), une bande (`Patch`) par rangée de blocs changés, en
  données brutes : matière, `life`, figé, température et pression en
  flottants, telles que le moteur les tient. Toutes les bandes d'une frame
  sont des vues d'un seul tampon, pris parmi ceux que la page a rendus
  (`claim()`). Un bac au repos n'envoie rien ; la première frame d'un moteur est
  entière et porte le grain (`noise`, fixe pour un moteur).
- **Page** : le miroir de world.ts est colorié par
  [screen.ts](../../src/client/screen.ts), un shader WebGL2 sur des textures
  entières, plus deux flottantes (R32F) pour la température et la pression
  (`texSubImage2D` du rectangle changé), ou sans WebGL2 par `Renderer` puis
  `putImageData`. Le miroir est la copie exacte du moteur (température et
  pression brutes) : `Renderer` colorie pareil le moteur et le miroir, et la
  vue pression ramène elle-même la pression à son palier (`airLevel()`, et
  `floor(p·8 + 0,5)` dans le shader).
- **Trois vues** (`View` de render.ts) : la matière, la vue thermique
  (`shadeHeat`) et la vue pression (`shadeAir` : l'air du bleu profond au
  blanc, le reste assombri aux 77/256). Les deux dernières sans éclairage ni
  heure. La rampe de pression est calculée **en entiers** des deux côtés :
  en flottants, le GPU arrondissait autrement 2 % des paliers.
- **Deux copies d'une même règle** : `Renderer.shade()` / `shadeHeat()` /
  `shadeAir()` et le shader de screen.ts. Mêmes constantes (`GLOW`,
  `GLOWING`, `AIR_LEVELS`, `palette()` partagées), mêmes arrondis. Changer
  un aspect (couleur tirée de `life`, lumière, vues thermique et pression) =
  changer les deux. `Renderer` sert au secours, aux
  tests et à `npm run directions` ; le test du miroir (test/sandbox.ts)
  vérifie qu'un miroir se colorie comme le moteur.
- **Seule exception : l'éclairage global** (*radiance cascades*, screen.ts),
  en WebGL2, et par `FlatLight` (sim/flatlight.ts, calculé dans un Worker à lui) dans le secours 2D, qui lui
  ressemble sans en être une copie (voir [rendu.md](rendu.md#le-secours-2d)).
  Les deux ajoutent leur lumière par-dessus le coloriage commun, avec le même
  mélange (`LIGHT_HALO`, `LIGHT_GAIN` de render.ts).
  Ce qu'une matière émet et arrête vit dans `lighting()` (render.ts), une
  table de 256 × RGBA comme `palette()` ; le rougeoiement des corps chauds
  (au-delà de `RED_HOT` = 450 °C) est ajouté par `SCENE` et par `FlatLight`. Une matière qui
  émet doit arrêter un peu de lumière (opacité > 0), sinon elle n'éclaire
  rien : test/sim.ts le vérifie. Une nouvelle matière lumineuse = une ligne
  `set(…)` dans `lighting()`. Une matière opaque qui brille n'est pas
  éclairée en plus (passe `FLUENCE`) : sans ça, le bord d'une mer de lave
  reprenait sa propre lumière et virait au jaune saturé.
- **L'heure** (`HOURS`, `hourTint()` de render.ts) multiplie la couleur, grain
  compris, avant chaleur et éclairage, et épargne les matières qui émettent
  dans `lighting()` : une matière lumineuse ajoutée là reste vive la nuit.
  Deux copies elle aussi : `dim()` de `Renderer` (tronquée) et `floor(c * tint)`
  du shader.
- Ce qui change l'aspect **sans écriture ni tick** : la vue thermique ne
  regarde que la page (`order()` de world.ts la relève et fait tout
  recolorier), l'éclairage, l'heure et la vue pression aussi (`light()`,
  `hour()`, `airView()` de world.ts) ; l'ambiante (seuil de lumière, pivot de la vue thermique)
  passe par `wakeAll()` et voyage avec la frame. Un nouveau réglage d'aspect
  doit faire l'un ou l'autre.
- `engine.changed()` remet à zéro ce qu'il a rendu : un seul `Tracker` par
  moteur.
- Le grain (`noise`) ne part qu'avec la première frame d'un moteur (entière),
  ou dans les bandes d'une frame que demande `Tracker.grained()`. sandbox.ts
  l'appelle après chaque glissement de la fenêtre d'exploration
  (`Engine.shift()`) et au départ du mode : la page fait glisser son miroir,
  grain compris, mais n'a pas celui de la bande neuve. Renvoyer toute la
  grille à la place coûtait 11 Mo par chunk traversé.
- `wakeColumns(from, to)` réveille les blocs d'une bande de colonnes, pour qui
  écrit directement dans les tableaux hors du moteur (`lay()` du mode
  exploration). `paste()` écrit rangée par rangée et réveille par bloc, au
  même résultat que cellule par cellule (2,7 ms de moins par chunk relu).
- `thumbnail()` sert aux vignettes de la galerie ; la lumière autour des
  sources chaudes reste un sous-produit de `temp` (aucun flou).

## Où vit quoi dans `Sandbox`

[sim/sandbox.ts](../../src/client/sim/sandbox.ts) est le **seul** endroit qui
appelle `engine.step()` (via `tick()`, météo comprise) et `Renderer.draw()`.
Il porte aussi l'annulation (10 crans de copies des quatre tableaux, moins
en grande grille : `UNDO_BYTES` borne les copies à 64 Mo), le
défi en cours, l'enregistrement et le rejeu.

Tout ce qui change la grille **sans passer par un geste** (annuler, vider,
charger, bâtir une scène) doit appeler `this.rec?.stamp()`, sinon le rejeu
diverge à partir de là. Un changement de taille abandonne l'enregistrement.

Pendant un rejeu, le `Player` possède la grille : les gestes sont ignorés, la
pause l'arrête, `step` l'avance d'un tick, et tout ordre qui **remplace** la
grille (`clear`, `undo`, `redo`, `load`, `scene`, `size`) l'arrête d'abord par
`this.play(false)` — il continuait sinon sur une grille qu'il n'avait pas
enregistrée. `play(false)` remet dans le moteur les réglages du panneau
(`knobs`), que le rejeu avait remplacés par les siens.

La condition de victoire (`won`) est désarmée par `clear`, `load` et `size` :
un bac vidé ou neuf remplissait d'avance plus d'un objectif.
