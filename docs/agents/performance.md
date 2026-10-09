# Mesurer et optimiser

Le bac doit tenir 60 images par seconde avec un monde animé en 1920×1080. Ce
guide dit **quoi lancer** pour le savoir, **comment trouver** ce qui coûte, et
**ce qui a déjà payé** — la liste est utile autant pour ne pas refaire une
optimisation que pour ne pas défaire sans le voir.

Les plafonds de la CI et ce que couvre chaque script sont dans
[tests.md](tests.md) ; les invariants du chemin chaud dans
[simulation.md § Performance du chemin chaud](simulation.md#performance-du-chemin-chaud) ;
les mesures de Rust/WASM dans [rust.md](../rust.md).

## Quoi lancer selon la question

| La question | La commande |
| --- | --- |
| « Est-ce que le tick s'est effondré ? » | `npm run bench` — cinq tailles, budget sur 320×180 |
| « Est-ce plus lent que `main` ? » | `npm run drift` — bench et stress de la base contre ici, sur la même machine ; une dérive de 20 % que les budgets absolus laissent passer |
| « Est-ce que cette matière, cette règle coûte cher dans le pire cas ? » | `npm run stress` — un bac plein de **chaque** matière, explosions, pression, lave, aimants, et les bandes d'un 1920×1080 tout changé |
| « Où part le temps d'un tick ? » | `node --cpu-prof`, voir plus bas |
| « Qu'est-ce que rapporterait le multi-cœur, le GPU, un portage ? » | `npm run directions` (et `test/gpu.html` sous `npm run dev` pour WebGPU) — voir [tests.md § Choisir une direction](tests.md#choisir-une-direction) |
| « Est-ce que Rust y gagnerait ? » | `npm run rust` → [rust.md](../rust.md) |
| « Est-ce que la page a grossi ? » | `npm run build` — deux budgets, 84 Kio pour la page, 80 Kio pour le moteur |
| « Est-ce que ça rame **vraiment** ? » | `npm run dev`, un grand bac, et regarder. Les scripts mesurent le moteur, pas la fluidité ressentie |

Avant de conclure à une régression : la mesure dépend beaucoup de la charge de la
machine (le bench passe de 2,8 à 5 ms d'une exécution à l'autre sur un poste
occupé). Relancer, prendre le minimum de plusieurs exécutions, et comparer sur la
même machine.

**`npm run drift` lui-même se fait avoir sur un portable.** Il mesure la base
puis ici, l'une après l'autre : sur une machine qui chauffe, la seconde paie la
première. Un `drift` a annoncé quatre scènes à +34 à +66 % ; relancé, les
**mêmes** scènes sortaient à −15 à −36 %, et mesurées une par une dans des
processus séparés et alternés elles étaient neutres ou plus rapides. Deux
pièges à connaître :

- un rouge isolé de `drift` se **relance** avant de se croire ;
- ne pas comparer deux moteurs **dans le même processus** (deux imports du
  module) : les deux se partagent le cache et le tas, et le second mesuré
  paraît plus lent qu'il n'est. Un processus par mesure, en alternance.

Ce qui tranche vraiment : un rouge qui revient au même endroit, ou un profil
(`--cpu-prof`) où le temps propre a bougé **dans la fonction touchée** — un
écart réparti sur des fonctions qu'on n'a pas modifiées est du bruit.

## Trouver ce qui coûte

`node --cpu-prof` sur un script qui fait tourner une scène, puis additionner le
temps **propre** (`timeDeltas`) par fonction du `.cpuprofile`. Deux choses à
savoir pour lire le résultat :

- V8 **intègre** les petites règles dans `update()` : le temps propre d'`update()`
  est surtout celui des règles de matière, et une règle n'apparaît pas forcément
  sous son nom ;
- une scène ne mesure que ce qu'elle réveille. Les trois qui servent de référence
  (le chantier du bench, une mer de lave, une fonderie) n'ont pas les mêmes
  goulots du tout : sur la mer de lave la chaleur fait 40 % du tick, sur le
  chantier 12 %.

C'est ainsi que la lave a été vue relisant ses quatre voisines dans `ignite()`
sans rien d'inflammable autour : 40 % du tick d'un lac qui coule.

## Ce qui plafonne le tick : la mémoire, pas le calcul

Mesuré sur un Ryzen 5 7520U (4 cœurs, 8 fils) :

- `npm run directions` donne ×1,3 à ×1,5 seulement en passant de 1 à 4 ou 8
  cœurs, **sur le noyau sable nu** — où il n'y a ni barrière ni passe
  sérielle à blâmer. Ce n'est pas Amdahl : c'est la bande passante ;
- l'état par cellule fait 29 octets (`cells`, `life`, deux tampons de `temp`,
  deux de `press`, `windX`/`windY`, `flags`, `frozen`, `noise`, `asked`),
  plus les 4 de la file `later`. En 1920×1080 cela fait **près de 70 Mo**,
  pour 2 à 4 Mo de L3 : ce qu'un tick relit vient de la RAM, chaque fois ;
- le vrai moteur coûte 128,8 ns par cellule éveillée, le noyau sable nu 17,6.

D'où deux consignes pour qui optimise le chemin chaud : **réduire le nombre de
flux de mémoire** qu'une passe lit par cellule (c'est ce qu'a fait `flags`), et
se méfier d'un gain de parallélisme attendu sur une grosse grille — il n'y est
pas.

## Les deux leviers qui ont tout changé

Dans l'ordre des gains, et de loin : **ne pas calculer**, puis **calculer en
parallèle**. Le reste (micro-optimisations, portage) vient après.

1. **Les blocs de veille** ([simulation.md](simulation.md#blocs-de-veille)) : un
   bac au repos en 1920×1080 tient sous la milliseconde par tick au lieu de 30.
   Toute la question est qu'un bloc **s'endorme vraiment** — les trois plus gros
   gains du projet sont trois blocs qui ne s'endormaient pas.
2. **Les fils auxiliaires** ([simulation.md](simulation.md#plusieurs-fils)) : une
   scène 1080p chargée passe de 25,7 ms par tick à 7,6 sur quatre fils, 5,6 sur
   huit.

## Ce qui a déjà payé

| Optimisation | Gain mesuré | Détail |
| --- | --- | --- |
| Blocs de veille 16×16 | 30 → < 1 ms par tick, bac au repos en 1920×1080 | [simulation.md](simulation.md#blocs-de-veille) |
| `pulled()` : une mer de lave à l'équilibre s'endort (ses voisins la lisaient 23 °C trop froid) | **181,7 → 0,6 ms** par tick | [rust.md](../rust.md#étape-0--mesurer-avant-de-porter-29-septembre-2026) |
| `flat()` : un bloc à l'ambiante exacte saute la diffusion, au bit près | 3238 blocs sur 3254 sautés dans le chantier | [simulation.md](simulation.md#blocs-de-veille) |
| Matières qui se réveillent elles-mêmes au lieu d'être dans `ACTIVE` | bac plein d'aimants 2 s → 0 par tick ; plein de sel, de thermite ou de sources 70–150 ms → 0 | [simulation.md](simulation.md#blocs-de-veille) |
| `gusty` : la passe de pression sautée tant que rien n'a soufflé | une salve dans le chantier coûtait 42 ms par tick | [simulation.md](simulation.md#pression-et-vent) |
| La lave n'appelle `ignite()` que si une voisine brûle (mêmes tirages) | 48,6 → 42,9 ms par tick sur un lac qui coule | [rust.md](../rust.md#étape-0--mesurer-avant-de-porter-29-septembre-2026) |
| Tables dérivées de `MATERIALS` indexées par id (`KIND`, `DENSITY`…) | tick 1,6 → 0,7 ms en 320×180 | [simulation.md](simulation.md#performance-du-chemin-chaud) |
| Voisines par offsets `NX` / `NY`, sans générateur ni itérateur | 30 % du tick | [simulation.md](simulation.md#mouvement) |
| Le coloriage sorti du Worker, fait par le shader | −6 ms par tick en 1920×1080 chargé | [rendu.md](rendu.md) |
| Bandes brutes dans **un seul** tampon recyclé (plus d'arrondi, plus d'allocation par couche) | 11 ms (bac) et 15 ms (page) → ~2 ms chacune par frame | [architecture.md](architecture.md#trois-fils-dexécution) |
| `SLICE` : une frame s'accorde 12 ms de simulation et abandonne son retard | la boucle montait à huit ticks par frame, 130 ms entre deux images | [architecture.md](architecture.md#trois-fils-dexécution) |
| Échéance fixe plutôt qu'un délai **après** le travail | ~37 → 60 images par seconde | `loop()` de sim/worker.ts |
| Son chargé au premier geste (`import()` d'audio.ts) et polyfill `modulepreload` retiré (vite.config.ts) | page 84 122 → 82 792 octets (son compris ; 81 014 sans) | [architecture.md](architecture.md#côté-page--qui-fait-quoi) |
| Galerie chargée à sa première ouverture (gallery.ts par `import()` de share.ts) | page 87 997 → 84 457 octets, pseudos, curseurs, remix et votes compris | [architecture.md](architecture.md#galerie-et-mondes-défis) |
| Éclairage du secours 2D (`FlatLight`) : calendrier des pas précalculé, lecture bilinéaire en ligne, texels opaques sautés, collecte sous-échantillonnée, mélange par rangée | lumière 13,6 → 4,5 ms (320×180), 22,9 → 4,4 ms (1920×1080) ; coloriage éclairé 1920×1080 73 → 32 ms (27 sans lumière) | [rendu.md](rendu.md#le-secours-2d) |
| Salon chargé au premier clic (room.ts par `import()` de lobby.ts) | page 86 221 → 81 754 octets | [architecture.md](architecture.md#salon-partagé-bac-multijoueur) |
| `FlatLight` chargé à la demande (sim/flatlight.ts) | page 89 186 → 85 274 octets | [rendu.md](rendu.md#le-secours-2d) |
| Rayons de `FlatLight` dans un fil à lui (sim/flatlight-worker.ts) : la page ne garde que la collecte | page : ~4,5 ms de rayons à chaque éclairage → collecte 0,3 à 0,9 ms ; la grille passe de 80 à 160 texels de large (rayons ~50 ms, hors de la page) | [rendu.md](rendu.md#le-secours-2d) |
| Glissement de la fenêtre d'exploration : la page fait glisser son miroir (`glide()`) au lieu de tout recevoir, chunk sortant encodé une image plus tard et chunk rangé décodé d'avance, `lay()` et `paste()` par rangées, grain précalculé, pression glissée seulement s'il a soufflé | frame du glissement (4 fils, héros qui marche) 16–25 → 9–13 ms ; glissement seul 11–19 → 5–6 ms ; décalage au bench 4 → 1,1 ms ; plus de 11 Mo par chunk traversé | [exploration.md](exploration.md#images-sautées--réglé) |
| Mode exploration chargé à la demande (sim/explore.ts, `import()` dans le Worker, Workers bâtis en modules ES) | moteur 81 647 → 77 456 octets (plafond 81 920) ; `explore-*.js` 4 822 octets, au premier clic sur Explorer | [exploration.md](exploration.md) |
| `flags` : `clock` et `held` fondus en un octet de drapeaux par cellule (un flux de mémoire de moins par cellule balayée) ; `block()` ne relit plus `awake` et `stir` qu'une fois par portion de `CHUNK` cellules au lieu d'une fois par cellule (21 % du temps propre du tick était dans ce balayage, dont 44 % des cellules visitées sont vides) ; `release()` retrouve l'ordre du balayage en relisant deux tableaux de drapeaux (`heldRow`, `heldSeg`) au lieu de trier la liste des différés — 28 000 par tick en 1280×720, 1,8 ms de tri et un `Atomics.add` chacun | tick 320×180 2,34 → 1,95 ms, 640×360 7,9 → 5,4, 1280×720 22,7 → 20,9, 1920×1080 50,5 → 43,5 (`npm run drift`, même machine, les trois ensemble) ; `waiting` (1,8 Mo en 1080p) et un octet par cellule en moins | [simulation.md](simulation.md#un-tick-step) |
| Plafond de fils porté de 7 à 14 | bac plein de nanites en 1080p : 28 ms à 7 fils → 19 à 15 (16 cœurs) | `helpers()` de sim/worker.ts |

## Les pistes mesurées et laissées de côté

- **Le GPU** (WebGPU, `test/gpu.html`) : les noyaux y vont très vite, mais le
  sable doit être reformulé en blocs de Margolus — sans balayage ni horloge, donc
  sans les règles actuelles. Réécriture du moteur entier.
- **Rust/WASM** ([rust.md](../rust.md)) : ×2 environ sur `thermal()` et sur la
  pression, au bit près. Mais la chaleur ne pèse lourd que là où le reste du tick
  s'est effondré (40 % de la mer de lave = 2 ms). Ce sont **les règles des
  cellules** qu'il faudrait porter pour que ça se sente — et le prototype n'est
  pas branché sur le bac.

La leçon des deux : avant de porter quoi que ce soit, chercher le calcul qu'on
peut **ne pas faire**. Les trois blocs qui ne s'endormaient pas ont rapporté plus
que tout ce qui précède.

## Ce qui a coûté, et pourquoi on l'a gardé

- **L'élan de l'air** (`windX`, `windY`, [simulation.md](simulation.md#pression-et-vent)) :
  `breathe()` passe de 11 à 13 ms à 23 ms dans la salve 1920×1080 de
  `npm run rust` (32 % d'un tick de 74 ms), pendant la seconde qui suit les
  souffles ; rien sans explosion. Le prix d'une onde qui voyage au lieu de
  s'étaler. Piste : un drapeau « au calme » par bloc, en double tampon, pour
  que `hushed()` et `still()` ne relisent plus trois tableaux sur toute la
  bordure ([rust.md](../rust.md#la-pression-avec-élan-2-octobre-2026)).
- **La correction bilinéaire des cascades** (`CASCADE`,
  [rendu.md](rendu.md#léclairage-global-scene-cascade-fluence)) : quatre
  marches par texel au lieu d'une, sur toutes les cascades sauf la plus
  lointaine. Pas mesurée à part ; « Finesse de l'éclairage » (Graphismes)
  reste le levier si une carte faible peine.

## Ce qu'une optimisation ne doit pas changer

- **L'empreinte du moteur.** Une optimisation qui change l'empreinte de
  test/sim.ts a changé un tirage ou un ordre : à justifier, pas à recopier
  ([tests.md § L'empreinte du moteur](tests.md#lempreinte-du-moteur)). Les trois
  grosses optimisations de blocs de veille ci-dessus ont été faites **à empreinte
  identique**, en posant le `wake(i)` avant le tirage qui peut échouer.
- **Le résultat à un fil et à quatre.** `npm run check` lance test/pool.ts, qui
  les compare au bit près.
- **Les deux copies du coloriage.** `npm run browser` compare le shader et
  `Renderer` ([rendu.md](rendu.md)).
