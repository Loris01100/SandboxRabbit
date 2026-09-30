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
ensuite), `seed` et `scan` (état du xorshift, sens du balayage). `gravity` et
`ambient` sont des accesseurs : les changer réveille tout le bac.

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
   est différée aussi (`held`).
4. `release()` : les cellules différées, triées dans l'ordre du balayage
   (celles du bas d'abord) et jouées seules, avec une graine à elles
   (`mix(tick ^ 0x27d4eb2f)`) : ni le nombre de fils ni l'ordre où ils les
   ont posées (`waiting`, `CTL.held`) ne comptent.
5. `settle()` : les explosions mises de côté pendant le damier (`blast()`),
   jouées une à une dans l'ordre du balayage. Une charge déjà emportée par
   une voisine ne saute plus (`EXPLOSIVE`).
6. `thermal()`, en trois passes par bloc de veille éveillé ou écrit : les
   sources (`heat`) tirent leur cellule vers leur température
   (`heatChunk`), puis diffusion (`CONDUCTION`), retour vers `ambient`
   (`COOLING`) et changements d'état `boil` / `freeze` (`diffuseChunk`),
   puis recopie des blocs refroidis (`settleChunk`). Les tampons s'échangent.

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
- **Écritures partagées idempotentes** : `stir` (des 1), `awake[c]` du seul
  bloc de veille traité, `hero` et le compteur d'explosions par `Atomics`.
- **Réglages publiés** : un fil auxiliaire relit gravité, vent, ambiante,
  matière des sources, commandes du héros, parité, graine et tampon de
  température courant dans `params` (`sync()`) avant chaque travail.

Le pool s'attache quand ses fils sont prêts (`bind()`), et se rattache à
chaque nouveau moteur (changement de taille) ; en attendant, le moteur fait
tout seul. Une passe de moins de quatre travaux ne réveille personne.

## Blocs de veille

La grille est découpée en blocs de 16×16 (`CHUNK`). Un bloc où rien ne bouge
n'est ni balayé ni diffusé : un bac au repos en 1920×1080 tient sous la
milliseconde par tick, au lieu de 30. Un bloc est traité si lui ou un voisin a
été « remué » (`stir`) depuis le dernier tick, par :

- **une écriture** : `set` / `become`, `swap` (donc `tryMove`), `hurl`,
  `relocate`, `convert`, `decay`, `charge`, `paste`, `setFrozen`, les bascules,
  l'amorçage du C4 par `explode`. Chacune appelle `wake(i)` ;
- **une matière active** (table `ACTIVE`) : elle agit sans que rien ne change
  autour — gaz, créatures, acide, thermite, uranium, sel, nanites, source,
  pile, braise, étincelle, aimant — plus le métal en repos (`life` > 0) ;
- **une matière qui a de quoi agir** : la plante qui touche de l'eau, la lave
  qui touche du sable ou de l'inflammable appellent `wake(i)` elles-mêmes.
  Hors de `ACTIVE` exprès : sans eau ni combustible elles ne font rien, et
  chaque arbre, chaque poche de lave d'un monde généré tenait sinon son coin
  de bac éveillé pour rien ;
- **une cellule qui passe son tour** à cause de `clock` (filet : un grain
  peint dans le vide garde l'horloge quelconque de la cellule vide) ;
- **un liquide bloqué d'un côté mais libre de l'autre** (`canMove()`) : il ne
  tente qu'un côté par tick, tiré au sort, et resterait suspendu ;
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
  par réussir, lecture au-delà des voisines immédiates) va dans `ACTIVE`. Sinon
  son bloc s'endort et elle se fige.
- **Déterminisme** : quels blocs dorment dépend de toute la partie. `wakeAll()`
  remet tout à plat (tous réveillés, horloges remises), et chaque départ de
  rejeu ou de salon passe par `put()` → `adopt()` → `wakeAll()`, chez l'hôte
  comme chez l'invité. Un départ qui ne passerait pas par là ferait diverger
  les tirages.
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
  Le générateur de mondes ([terrain.ts](../../src/client/terrain.ts)) tire,
  lui, sur un xorshift à lui semé par la graine du monde : un monde est une
  grille posée d'un coup (`stamp()`), un invité le reçoit tout fait et ne
  rejoue pas sa construction — elle ne doit donc rien prendre au tirage du bac.
- **Mêmes calculs dans tous les navigateurs.** + − × ÷ et `Math.sqrt` sont
  arrondis exactement par IEEE 754 ; `hypot`, `sin`, `exp`, `pow`, `log`…
  sont « approchés selon l'implémentation » et peuvent différer d'un bit
  entre Chrome et Firefox. Interdits dans engine.ts et terrain.ts : `disc()`
  employait `hypot`, et un salon mixte pouvait diverger à la première
  explosion. Les tests tournent tous sous V8 et ne le verraient pas — test/sim.ts
  lit donc la source.
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
  la gravité, et le lapin, dont les neuf cellules bougent d'un bloc par
  `relocate()` (voir [Créatures](#créatures--le-lapin)).
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
  de geste s'ajoute aussi à ce crible (`FIELDS` pour un geste).
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
| `SWITCH` | 1 = fermé |
| `URANIUM` | compteur d'emballement |
| `MAGNET` | pôle (1 = repousse) |
| `RABBIT` | satiété du cœur (0 au chargement d'un monde sans état vivant = repart pleine) ; les cellules du corps n'en ont pas |
| `HERO` | bit 7 = tourné vers la gauche (où il creuse), bits 0-3 = élan de saut restant ; perdu, il repart debout vers la droite. Le corps n'en a pas |

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

- Une règle ne fait jamais sauter directement : elle **demande** l'explosion
  (`blast(x, y, r)`, `blast(…, NUKE, true)` pour le nucléaire), jouée à la fin
  du damier par `settle()`. Un souffle porte bien au-delà des 15 cellules que
  le damier garantit (voir [Plusieurs fils](#plusieurs-fils)). Un nouvel
  explosif ajoute sa matière à `EXPLOSIVE`, sinon sa demande est ignorée.
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
vérifier le corps, cuisson, gel, noyade (eau, eau salée ou boue au-dessus des
oreilles), faim, chute, puis — posé — manger, se reproduire, se déplacer.

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
- La forme ne suit pas la gravité inversée (`ponytail:` dans le code).

### Créatures : le héros

Sept cellules (`HERO_SHAPE` : tête, buste et bras, hanches = cœur `HERO`,
jambes), symétriques — son sens se garde dans `life`. **Il n'a pas de volonté**
: il obéit à `engine.pilot`, six bits (`PILOT` dans materials.ts : gauche,
droite, saut, creuser dessous, creuser devant, poser) et, bits 8-15, la matière
qu'il pose. Tous les héros du bac obéissent aux mêmes touches.

- `pilot` n'est posé **que** par le geste `pilot` (gestures.ts) : c'est ce qui
  l'enregistre dans le rejeu et le relaie à l'hôte d'un salon. Il figure aussi
  dans la `Scene` du rejeu, pour un enregistrement lancé touche enfoncée.
- Ordre d'un tick : corps entier, cuisson, gel, noyade (tête sous un liquide,
  `BREATH` par tick), creuser, puis un mouvement vertical — saut (`JUMP` ticks
  de montée), nage (saut tenu dans un liquide), chute (lente dans un liquide,
  `SINK`) — et un pas de côté (`STRIDE`), qui grimpe une marche d'une cellule.
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
- `engine.hero` = index du cœur du dernier héros posé (`spawn`) ou mis à jour :
  Sandbox le joint à chaque frame (`hero`), vérifié (`cells[hero] === HERO`),
  et la page fait suivre la caméra. Il n'est pas remis à -1 à la mort : c'est
  la vérification qui le rend `null`.
- `terrain()` (terrain.ts) en pose un au sec, au plus près du centre.

## Rendu

1 cellule = 1 pixel, mise à l'échelle par CSS `image-rendering: pixelated`.
**Pas de dessin par cellule.** Le Worker ne colorie plus : c'était 6 ms par
tick en 1920×1080 chargé (`npm run directions`).

- **Worker** : `Tracker` ([render.ts](../../src/client/sim/render.ts)) suit
  les [blocs de veille](#blocs-de-veille). À chaque frame il découpe les blocs
  que `engine.changed()` désigne (traités par un tick, ou écrits depuis — un
  geste bac en pause), une bande (`Patch`) par rangée de blocs changés, en
  données brutes : matière, `life`, figé, température arrondie au degré
  (`Int16`). Un bac au repos n'envoie rien ; la première frame d'un moteur est
  entière et porte le grain (`noise`, fixe pour un moteur).
- **Page** : le miroir de world.ts est colorié par
  [screen.ts](../../src/client/screen.ts), un shader WebGL2 sur des textures
  entières (`texSubImage2D` du rectangle changé), ou sans WebGL2 par
  `Renderer` puis `putImageData`.
- **Deux copies d'une même règle** : `Renderer.shade()` / `shadeHeat()` et le
  shader de screen.ts. Mêmes constantes (`GLOW`, `GLOWING`, `palette()`
  partagées), mêmes arrondis. Changer un aspect (couleur tirée de `life`,
  lumière, vue thermique) = changer les deux. `Renderer` sert au secours, aux
  tests et à `npm run directions` ; le test du miroir (test/sandbox.ts)
  vérifie qu'un miroir se colorie comme le moteur.
- **Seule exception : l'éclairage global** (*radiance cascades*, screen.ts),
  qui n'existe qu'en WebGL2. Il ajoute sa lumière par-dessus le coloriage
  commun et `Renderer` n'en a pas de copie (`ponytail:` de `lighting()`).
  Ce qu'une matière émet et arrête vit dans `lighting()` (render.ts), une
  table de 256 × RGBA comme `palette()` ; le rougeoiement des corps chauds
  (au-delà de 450 °C) est ajouté dans le shader `SCENE`. Une matière qui
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
  recolorier), l'éclairage et l'heure aussi (`light()`, `hour()` de world.ts) ; l'ambiante (seuil de lumière, pivot de la vue thermique)
  passe par `wakeAll()` et voyage avec la frame. Un nouveau réglage d'aspect
  doit faire l'un ou l'autre.
- `engine.changed()` remet à zéro ce qu'il a rendu : un seul `Tracker` par
  moteur.
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
