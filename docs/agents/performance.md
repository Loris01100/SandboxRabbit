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
