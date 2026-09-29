# Rust et WebAssembly

Le dossier [rust/](../rust/) contient un **prototype** : la diffusion de la
chaleur du moteur (`thermal()` d'[engine.ts](../src/client/sim/engine.ts))
réécrite en Rust et compilée en WebAssembly (WASM). Il sert à mesurer ce
qu'un moteur en Rust ferait gagner. Il n'est **pas branché sur le bac** : le jeu
tourne toujours sur engine.ts, et rien de ce qui est décrit ici n'est
nécessaire pour `npm run dev`, `check` ou `build`.

## Installer Rust

À faire une fois par machine.

### Windows

Télécharger `rustup-init.exe` (lien « x86_64 » sur
[rustup.rs](https://rustup.rs), ou directement `https://win.rustup.rs/x86_64`),
puis, depuis le dossier où il est :

```powershell
.\rustup-init.exe -y --profile minimal --default-host x86_64-pc-windows-gnu
```

Il installe Rust dans `%USERPROFILE%\.rustup` et `%USERPROFILE%\.cargo`, sans
droits d'administrateur, et ajoute `%USERPROFILE%\.cargo\bin` au `PATH`.
Ouvrir ensuite un **nouveau** terminal, et dans VS Code fermer puis rouvrir la
fenêtre : sinon `cargo` reste introuvable.

Pourquoi `windows-gnu` : l'hôte par défaut de Windows (`msvc`) réclame Visual
Studio et ses outils de compilation, plusieurs gigaoctets, et `-y` lancerait
leur installation. Ce projet ne compile que vers WASM, qui a son propre
éditeur de liens, fourni avec Rust : Visual Studio ne servirait à rien.

`winget install Rustlang.Rustup` marche aussi, mais installe l'hôte `msvc` :
lancer ensuite `rustup set default-host x86_64-pc-windows-gnu` puis
`rustup default stable`.

### macOS, Linux

```bash
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal
```

### Ce qui s'installe tout seul

Rien d'autre à faire : [rust/rust-toolchain.toml](../rust/rust-toolchain.toml)
fixe la version de Rust (1.98.1) et la cible `wasm32-unknown-unknown`. Au
premier `cargo` lancé depuis `rust/`, rustup les télécharge. Tout le monde
compile donc avec la même version, sans `rustup target add`.

Pas de wasm-pack ni de wasm-bindgen : le module n'a aucune dépendance (voir
plus bas), `cargo` suffit.

Pour vérifier : `cargo --version` dans un nouveau terminal.
Pour tout désinstaller : `rustup self uninstall`.

**« 'cargo' n'est pas reconnu… »** alors que Rust est installé : le terminal
a gardé le `PATH` d'avant l'installation. Dans VS Code, ouvrir un nouveau
terminal ne suffit pas, car il hérite de l'environnement de VS Code lui-même.
Fermer les fenêtres ne suffit pas toujours non plus : le processus principal
de VS Code peut survivre (une autre fenêtre ouverte, une restauration de
session) et garder l'ancien `PATH`. Quitter par **Fichier → Quitter**
(`Ctrl+Q`) dans chaque fenêtre, vérifier dans le Gestionnaire des tâches qu'il
ne reste aucun « Visual Studio Code », puis relancer. En dépannage, pour le
seul terminal ouvert :

```powershell
$env:Path += ";$env:USERPROFILE\.cargo\bin"
```

## Lancer le prototype

```bash
npm run rust
```

Ce script compile `rust/` en WASM (`cargo build --release`, deux secondes la
première fois, instantané ensuite), puis lance [test/rust.ts](../test/rust.ts).
Celui-ci construit deux scènes en 1920×1080, un chantier (eau, sable, bois en
feu) et une mer de lave, et pour chacune :

1. mesure un tick complet du moteur JavaScript, et la part de `thermal()` ;
2. fait repartir `thermal()` du même état en JavaScript puis dans les trois
   versions Rust, sur un seul fil ;
3. compare chaque résultat à celui de JavaScript, cellule par cellule :
   température des deux tampons, matière, `life`, blocs de veille.

Le script échoue si le `.wasm` manque, ou si une version annoncée exacte ne
rend pas exactement ce que rend JavaScript. Il ne garde aucun budget de
temps : comme `npm run directions`, c'est un instrument de décision, pas un
test. Il ne tourne pas en CI, qui n'a pas Rust.

## Ce qu'il y a dans rust/

| Fichier | Rôle |
| --- | --- |
| `rust-toolchain.toml` | version de Rust et cible WASM, installées d'office par rustup |
| `Cargo.toml` | la bibliothèque `thermal`, compilée en `cdylib` (un `.wasm` chargeable), optimisée au maximum en `release` |
| `.cargo/config.toml` | cible par défaut `wasm32-unknown-unknown`, SIMD 128 bits activé. Lu seulement quand `cargo` est lancé **depuis** `rust/` : `npm run rust` s'y place |
| `src/lib.rs` | le code : `reserve()` et `thermal()` |
| `target/` | le résultat de la compilation (ignoré par git) : `target/wasm32-unknown-unknown/release/thermal.wasm`, 6 Ko |

## Comment JavaScript et Rust se parlent

Le module est en `no_std` : sans bibliothèque standard, sans dépendance, sans
wasm-bindgen. Il exporte deux fonctions et sa mémoire.

1. JavaScript appelle `reserve(octets)` pour chaque tableau (cellules, `life`,
   les deux tampons de température, blocs de veille, tables des matières).
   Rust agrandit sa mémoire et rend une adresse.
2. **Après toutes les réservations**, JavaScript pose ses vues
   (`Uint8Array`, `Float32Array`) sur `memory.buffer` à ces adresses. Une
   mémoire WASM qui grandit remplace son `ArrayBuffer` : les vues prises avant
   deviendraient vides.
3. `thermal(w, h, adresses…, ambiante, mode)` travaille directement dans ces
   tableaux. Aucune copie : dans un vrai portage, le `Tracker`, le codec et le
   rendu liraient la même mémoire que Rust.

Les tables des matières (`heat`, `boil`, `freeze`, `life`) ne sont pas
recopiées en Rust : test/rust.ts les dérive de
[materials.ts](../src/client/sim/materials.ts) et les passe au module. Le
registre reste la seule source.

## Déterminisme : pourquoi f64

Le salon fait tourner le même moteur chez chaque joueur et compare leurs
grilles : un bit d'écart et les parties divergent. JavaScript calcule en
`double` (f64) puis range le résultat dans un `Float32Array`. La version Rust
fait **exactement** pareil : lecture en f32, calcul en f64 dans le même ordre
d'opérations, arrondi en f32 au rangement. L'arithmétique IEEE ne dépend ni du
navigateur ni du processeur (WASM n'a pas de multiplication-addition fusionnée
sans qu'on la demande) : le résultat est identique au bit près.

Trois versions, choisies par `mode` :

| Mode | Calcul | Au bit près ? |
| --- | --- | --- |
| 0 | copie ligne à ligne de `diffuseChunk()`, f64 | oui |
| 1 | SIMD, deux cellules à la fois (f64×2) | oui : le SIMD fait les mêmes opérations IEEE, voie par voie |
| 2 | SIMD, quatre cellules à la fois, tout en f32 (f32×4) | **non** : écart de l'ordre de 10⁻⁴ °C. Invisible à l'œil, mais un salon où un joueur tourne en JS et l'autre en WASM divergerait. Envisageable seulement si **tous** les clients tournent en WASM |

## Résultats

Mesurés le 29 septembre 2026 avec Node 24, sur un seul fil. Les temps varient
de 10 à 20 % d'une exécution à l'autre ; relancer `npm run rust` pour sa
machine.

| Scène 1920×1080 | Tick JS | `thermal()` JS | Rust f64 | Rust SIMD f64×2 | Rust SIMD f32×4 |
| --- | --- | --- | --- | --- | --- |
| chantier, 34 % des blocs éveillés | 27 ms | 5,2 ms (20 % du tick) | ×1,4 à 1,5 | ×1,8 à 1,9 | ×2,1 à 2,2 |
| mer de lave, 69 % des blocs éveillés | 147 ms | 14,7 ms (10 % du tick) | ×1,5 à 1,7 | ×2,1 à 2,5 | ×2,4 à 3 |

Ce qu'on en tire :

- **Rust tient ses promesses sur la chaleur** : deux fois plus vite, au bit
  près, grâce au SIMD. Sans SIMD, le gain n'est que de 1,5 : V8 compile déjà
  bien les boucles sur tableaux typés.
- **Mais la chaleur n'est que 10 à 20 % du tick.** Sur la mer de lave, la
  porter en Rust ferait gagner environ 8 ms sur 147. Ce sont les **règles des
  cellules** (`block()`, le balayage) qui coûtent : c'est elles qu'il faudrait
  mesurer, puis porter, pour que le portage se sente en jeu.
- Les règles se prêtent moins au SIMD (branches selon la matière, tirages au
  sort) : en attendre plutôt le ×1,5 de la version sans SIMD, à confirmer par
  un prototype du même genre sur `block()`.

### Étape 0 : mesurer avant de porter (29 septembre 2026)

Avant d'aller plus loin en Rust, le coût du tick a été décortiqué. Deux
trouvailles en TypeScript, qui pèsent bien plus que tout portage :

- **La mer de lave ne s'endormait jamais.** Aucune cellule ne bougeait, mais
  66 % des blocs restaient éveillés : un bloc endormi ne tire pas ses sources
  vers leur `heat`, et ses voisins éveillés le lisaient 23 °C trop froid (voir
  `pulled()` dans engine.ts et
  [simulation.md](agents/simulation.md#blocs-de-veille)). Corrigé :
  **181,7 → 0,6 ms par tick** en 1920×1080 une fois la lave posée. Le tick de
  147 ms du tableau ci-dessus était en fait ce bogue.
- **La règle de la lave relisait ses voisines pour rien** (`ignite()` sans
  combustible autour) : 40 % du tick d'un lac qui coule. Corrigé, mêmes
  tirages, même empreinte : **48,6 → 42,9 ms par tick** sur de la lave qui
  coule en 1920×1080.

Ce qui reste sur de la lave qui coule (profil `node --cpu-prof`, part du
temps propre) : la règle de la lave et le choix de la règle (`update`,
~32 %), la chaleur (`diffuseChunk`, ~22 %), l'étalement des liquides
(`updateLiquid`, ~16 %), la boucle de balayage (`block`, ~10 %), les
déplacements (`swap`, `tryMove`, ~11 %). C'est ce profil qui dira quoi
porter si Rust revient sur la table.

## Brancher Rust sur le vrai moteur (pas fait)

Si les mesures le justifient, voici ce qu'il faudrait :

1. **engine.ts** devient une coquille : ses tableaux sont des vues sur la
   mémoire WASM (réservée une fois par taille de bac), ses méthodes appellent
   le module. Le reste du code ne change pas.
2. **Multi-fils** ([pool.ts](../src/client/sim/pool.ts)) : chaque fil
   instancie le même module sur une `WebAssembly.Memory` partagée. La
   répartition des travaux peut rester en JavaScript.
3. **Politique de sécurité** ([app.ts](../src/worker/app.ts)) : ajouter
   `script-src 'self' 'wasm-unsafe-eval'`, sans quoi le navigateur refuse
   d'instancier le module.
4. **Vite** : un petit plugin dans vite.config.ts qui lance `cargo build` au
   démarrage et à chaque modification d'un `.rs`, pour que `npm run dev` reste
   la seule commande.
5. **CI** : installer Rust (l'action `dtolnay/rust-toolchain` lit
   `rust-toolchain.toml`), compiler avant `npm run check`, compter le `.wasm`
   dans le budget du moteur.
6. **Salon** : une version du moteur dans le protocole, pour qu'une page JS
   restée en cache ne rejoigne pas une partie WASM, au cas où elles
   différeraient.
7. **Empreinte** : celle de test/sim.ts doit rester la même. C'est elle qui
   prouve que le moteur Rust est le même moteur.
