import {
  ACID, BATTERY, C4, CANDLE, EMBER, EMPTY, FALLOUT, FIRE, GLASS, ICE, LAVA, MATERIALS, METAL,
  FILINGS, HERO, HERO_BODY, HERO_HEAD, HERO_LEGS, MAGNET, MINE, MUD, NANITE, NITRO, PILOT, PLANT, RABBIT, RABBIT_BODY, RABBIT_EYE, RABBIT_TAIL,
  SALT, SALTWATER, SAND, SEED, SMOKE, SOURCE, SPARK, STEAM, STONE, SWITCH, THERMITE, TNT, URANIUM, WATER, WOOD, type MaterialId,
} from "./materials.ts";

/**
 * Les quatre voisines d'une cellule, en offsets. C'était un générateur : lisible,
 * mais une quinzaine de règles l'appellent pour **chaque** cellule et chaque
 * tick, et un générateur alloue son itérateur à chaque appel.
 */
const NX = new Int8Array([0, 0, -1, 1]);
const NY = new Int8Array([-1, 1, 0, 0]);

/** Température de l'air au repos, en °C. */
export const AMBIENT = 20;
/** Part de la différence avec les voisins échangée par tick. */
const CONDUCTION = 0.16;
/** Retour vers l'ambiante par tick (le bac à sable perd sa chaleur). */
const COOLING = 0.02;
/** Ticks pendant lesquels un métal qui vient de conduire refuse l'étincelle. */
const RECOVERY = 8;
/** Ticks entre deux étincelles d'une pile (plus long que `RECOVERY`, sinon le fil sature). */
const PULSE = 24;
/** Cellules de chute au-delà desquelles l'atterrissage détonne la nitroglycérine. */
const SHOCK = 4;
/** Ticks de combustion de la thermite : assez pour percer, pas pour vider la scène. */
const BURN = 150;
/** Voisins d'uranium à partir desquels un tas s'emballe (4 = enfoui dans un bloc). */
const CRITICAL = 3;
/** Ticks d'emballement avant la détonation : le temps de casser le tas. */
const MELTDOWN = 120;
/** Rayon du souffle nucléaire. */
const NUKE = 16;
/** Portée de l'aimant, en cellules. */
const PULL = 5;

/*
 * Le lapin : neuf cellules de taille fixe, que son cœur (`RABBIT`) déplace d'un
 * bloc. De profil, tourné vers la droite, en offsets depuis le cœur ◆ :
 *
 *     . . █ .      oreille
 *     . . █ ●      tête, œil
 *     ░ █ ◆ █      queue, dos, cœur, museau
 *     █ . █ .      pattes
 *
 * Tourné vers la gauche, on inverse les `dx`. Le cœur d'abord.
 * ponytail: la forme ne suit pas la gravité — retournée, le lapin tombe vers le
 * plafond en gardant les oreilles en haut, et y marche sur la tête. À revoir si
 * la gravité inversée devient autre chose qu'un gag.
 */
const RABBIT_DX = new Int8Array([0, 0, 0, 1, -2, -1, 1, -2, 0]);
const RABBIT_DY = new Int8Array([0, -2, -1, -1, 0, 0, 0, 1, 1]);
const RABBIT_ID = new Uint8Array([
  RABBIT, RABBIT_BODY, RABBIT_BODY, RABBIT_EYE, RABBIT_TAIL, RABBIT_BODY, RABBIT_BODY, RABBIT_BODY, RABBIT_BODY,
]);
const RABBIT_SIZE = RABBIT_ID.length;
/** Où il broute : devant la tête et le museau, sous le ventre et sous les pattes. */
const MOUTH_DX = new Int8Array([2, 2, 1, -1, 0, -2]);
const MOUTH_DY = new Int8Array([-1, 0, 1, 1, 2, 2]);

/*
 * `life` du cœur est la satiété : 200 posé au pinceau, elle baisse d'un cran
 * avec une chance `HUNGER` par tick (~1000 ticks, un quart de minute, sans
 * manger) et il meurt à zéro. Il ne cherche à manger que sous `HUNGRY`, et ne
 * se reproduit que repu. Les autres cellules du corps n'ont pas d'état.
 */
/** Satiété d'un lapin posé au pinceau. */
const FED = MATERIALS[RABBIT].life!;
/** Chance, par tick, de perdre un cran de satiété. */
const HUNGER = 0.2;
/** Sous ce seuil, le lapin cherche une plante des yeux. */
const HUNGRY = 150;
/** Ce que rapporte une bouchée de plante. */
const MEAL = 50;
/** Satiété à partir de laquelle deux voisins font un petit… */
const BREED = 180;
/** …ce qui coûte ce prix au parent : il lui faut deux repas pour recommencer. */
const LITTER_COST = 80;
/** Satiété du nouveau-né : sous `BREED`, sinon la portée repart aussitôt. */
const NEWBORN = 120;
/** Chance, par tick et à deux voisins repus, d'avoir un petit. */
const LITTER = 0.05;
/** Au-delà de cette température (°C), le lapin fuit vers le côté le plus frais. */
const FLEE = 45;
/** Portée du regard vers une plante, en cellules de chaque côté. */
const SIGHT = 8;
/** Chance, par tick, de faire un pas : en fuite, vers une plante vue, au hasard. */
const PACE_FLEE = 0.6;
const PACE_SEEK = 0.3;
const PACE_WANDER = 0.08;
/** Chance, par tick sous l'eau, de se noyer. */
const DROWN = 0.03;
/** Chance, en flânant, de faire demi-tour (sinon il marche droit devant lui). */
const TURN = 0.2;
/**
 * Cuisson et gel. Pas de `boil` / `freeze` ici : `thermal()` ne changerait que
 * le cœur, et le reste du corps disparaîtrait avec lui. Le lapin entier doit
 * passer d'un coup, en feu ou en glace — c'est donc une règle.
 */
const COOK = 110;
const FROST = -25;

/**
 * Une créature de taille fixe : offsets depuis le cœur, tournée vers la
 * droite (on inverse les `dx` pour la gauche), et la matière de chaque case,
 * le cœur d'abord. Le lapin et le héros partagent ainsi la pose, la marche,
 * la chute et la mort d'un bloc (`spawn`, `relocate`, `kill`…).
 */
interface Shape {
  dx: Int8Array;
  dy: Int8Array;
  id: Uint8Array;
}
const RABBIT_SHAPE: Shape = { dx: RABBIT_DX, dy: RABBIT_DY, id: RABBIT_ID };

/*
 * Le héros, de face, en offsets depuis le cœur ◆ (les hanches) :
 *
 *     . ● .      tête
 *     █ █ █      bras et buste
 *     . ◆ .      hanches
 *     ▌ . ▐      jambes
 *
 * Symétrique : son sens (où il creuse) se garde dans `life`, pas dans sa forme.
 */
const HERO_SHAPE: Shape = {
  dx: new Int8Array([0, 0, 0, -1, 1, -1, 1]),
  dy: new Int8Array([0, -2, -1, -1, -1, 1, 1]),
  id: new Uint8Array([HERO, HERO_HEAD, HERO_BODY, HERO_BODY, HERO_BODY, HERO_LEGS, HERO_LEGS]),
};
/** Ticks de montée d'un saut : de quoi franchir quatre à cinq cellules. */
const JUMP = 6;
/** Chance, par tick et touche tenue, de faire un pas : 30 cellules par seconde. */
const STRIDE = 0.5;
/** Chance, par tick et touche tenue, d'arracher ce qu'il creuse. */
const DIG = 0.3;
/** Chance, par tick dans un liquide, de s'y enfoncer d'une cellule : il coule, lentement. */
const SINK = 0.3;
/** Chance, par tick la tête sous un liquide, de se noyer : quelques secondes d'apnée. */
const BREATH = 0.004;
/** `life` du cœur du héros : bit 7 = tourné vers la gauche, bits 0-3 = élan de saut restant. */
const FACING_LEFT = 128;

/**
 * `thermal()` lit trois propriétés par cellule et par tick : autant les sortir
 * de `MATERIALS` une fois pour toutes. Un accès de tableau typé au lieu d'une
 * propriété d'objet, sur 57 600 cellules × 60 fois par seconde.
 * Les tables **dérivent** du registre : ajouter une matière ne change rien ici.
 */
/** `kind`, en numérique : 0 vide, 1 statique, 2 poudre, 3 liquide, 4 gaz. */
const KINDS = { empty: 0, static: 1, powder: 2, liquid: 3, gas: 4 } as const;
const KIND = new Uint8Array(256);
const DENSITY = new Float32Array(256);
const HEAT = new Float32Array(256).fill(NaN); // NaN = ne chauffe pas
const BOIL_AT = new Float32Array(256).fill(Infinity);
const BOIL_INTO = new Uint8Array(256);
const FREEZE_AT = new Float32Array(256).fill(-Infinity);
const FREEZE_INTO = new Uint8Array(256);
/** 1 = id présent dans `MATERIALS`. Pour ce qui lit un id ailleurs que dans `cells` (le `life` d'une source). */
const KNOWN = new Uint8Array(256);
/**
 * `spread`, `life` et `flammable`, lus par chaque liquide, chaque gaz et
 * chaque voisin d'une flamme à chaque tick : en 1920×1080, un lac qui
 * s'étale lisait `MATERIALS[id].spread` un demi-million de fois par tick.
 */
const SPREAD = new Uint8Array(256);
const LIFE = new Uint8Array(256);
const FLAMMABLE = new Float64Array(256);
for (const key of Object.keys(MATERIALS)) {
  const m = MATERIALS[Number(key)];
  KNOWN[m.id] = 1;
  SPREAD[m.id] = m.spread ?? 1;
  LIFE[m.id] = m.life ?? 0;
  FLAMMABLE[m.id] = m.flammable ?? 0;
  KIND[m.id] = KINDS[m.kind];
  DENSITY[m.id] = m.density;
  if (m.heat !== undefined) HEAT[m.id] = m.heat;
  if (m.boil) { BOIL_AT[m.id] = m.boil.at; BOIL_INTO[m.id] = m.boil.into; }
  if (m.freeze) { FREEZE_AT[m.id] = m.freeze.at; FREEZE_INTO[m.id] = m.freeze.into; }
}
/** 1 = matière de créature (le pinceau en pose une entière) ou cellule de son corps. */
const CREATURE = new Uint8Array(256);
for (const key of Object.keys(MATERIALS)) {
  const m = MATERIALS[Number(key)];
  if (m.creature || m.part !== undefined) CREATURE[m.id] = 1;
}

/**
 * Blocs de veille : la grille est découpée en carrés de `CHUNK` cellules de
 * côté, et un bloc où rien ne bouge n'est ni balayé ni diffusé. Un lac étale,
 * un tas de sable posé, un mur de pierre ne coûtent alors plus rien — c'est ce
 * qui laisse grandir la grille sans que le tick grandisse avec elle.
 */
const SHIFT = 4;
const CHUNK = 1 << SHIFT;
/**
 * Variation de température (°C par tick) sous laquelle un bloc est tenu pour
 * refroidi. Il s'endort alors à STILL / COOLING ≈ 0,05 °C de son équilibre :
 * ni la vue thermique ni un seuil de `boil` ne voit la différence.
 */
const STILL = 0.001;
/**
 * 1 = matière qui agit d'elle-même, sans que rien ne change autour : un
 * compteur (gaz, braise, pile, thermite, uranium, lapin) ou un tirage qui
 * finira par réussir (l'acide qui ronge, le sel qui fond la glace). Son bloc
 * ne s'endort pas. Les autres — sable posé, eau étale, TNT qui attend sa
 * flamme — ne font rien tant que leurs voisines ne bougent pas, et toute
 * écriture réveille le bloc qu'elle touche. La plante et la lave sont entre
 * les deux : elles ne tiennent leur bloc éveillé (`wake`) que lorsqu'elles
 * ont de quoi agir — de l'eau à boire, du sable ou du bois à côté.
 */
const ACTIVE = new Uint8Array(256);
for (const key of Object.keys(MATERIALS)) {
  const id = Number(key);
  if (KIND[id] === KINDS.gas || CREATURE[id]) ACTIVE[id] = 1;
}
for (const id of [ACID, THERMITE, URANIUM, SALT, NANITE, SOURCE, BATTERY, EMBER, SPARK, MAGNET]) ACTIVE[id] = 1;

/**
 * Offsets d'un disque de rayon `radius`, du bord vers le centre — l'ordre dans
 * lequel le souffle doit traiter ses cellules. Mis en cache : les explosions
 * n'utilisent qu'une poignée de rayons.
 */
const DISCS = new Map<number, [number, number, number][]>();

function disc(radius: number): [number, number, number][] {
  const known = DISCS.get(radius);
  if (known) return known;
  const cells: [number, number, number][] = [];
  for (let y = -radius; y <= radius; y++) {
    for (let x = -radius; x <= radius; x++) {
      const d = Math.hypot(x, y);
      if (d <= radius) cells.push([x, y, d]);
    }
  }
  cells.sort((a, b) => b[2] - a[2]);
  DISCS.set(radius, cells);
  return cells;
}

/** Morceau de grille découpé puis reposé ailleurs (copier / coller). */
export interface Clip {
  width: number;
  height: number;
  cells: Uint8Array;
  life: Uint8Array;
  frozen: Uint8Array;
}

/**
 * Automate cellulaire type « falling sand ».
 *
 * Quatre tableaux plats de la taille de la grille :
 *  - `cells` : l'identifiant du matériau
 *  - `life`  : compteur de vie (feu, fumée, vapeur) ; pour une `SOURCE`, la
 *              matière qu'elle émet
 *  - `temp`  : température en °C, diffusée à chaque tick
 *  - `clock` : parité de la frame où la cellule a déjà bougé (évite qu'une
 *              cellule descende plusieurs fois dans le même tick)
 *  - `frozen`: cellules figées à la main, que la simulation saute
 *
 * Le balayage part du bas et alterne le sens en x d'une frame à l'autre, sinon
 * la matière dérive visiblement vers la gauche.
 */
export class Engine {
  readonly width: number;
  readonly height: number;
  readonly cells: Uint8Array;
  readonly life: Uint8Array;
  /** Réassigné à chaque tick : les deux tampons de diffusion s'échangent. */
  temp: Float32Array;
  private tempNext: Float32Array;
  /** Publique pour le rejeu : sans elle, une partie ne repart pas au même tick. */
  readonly clock: Uint8Array;
  /** 1 = cellule figée : elle ne bouge plus et rien ne peut la pousser. */
  readonly frozen: Uint8Array;
  private parity = 0;
  /** Bruit fixe par cellule : donne du grain sans scintiller. */
  readonly noise: Int8Array;
  private fall: 1 | -1 = 1;
  /** Vent horizontal, de -1 (plein ouest) à 1 (plein est). */
  wind = 0;
  private air = AMBIENT;
  /** Côté d'un bloc de veille, en cellules : le rendu redessine par blocs lui aussi. */
  readonly chunk = CHUNK;
  /** Blocs de veille par rangée et par colonne (voir `CHUNK`). */
  readonly cols: number;
  readonly rows: number;
  /** Blocs traités par un tick depuis le dernier `changed()`. */
  private readonly shown: Uint8Array;
  /** Blocs traités à ce tick : ceux de `stir`, et leurs huit voisins. */
  private readonly awake: Uint8Array;
  /** `awake` du tick d'avant : dit quels blocs viennent de se réveiller. */
  private readonly was: Uint8Array;
  /** Blocs écrits, ou tenus éveillés par une matière active ou une chaleur qui bouge, depuis le dernier tick. */
  private readonly stir: Uint8Array;
  /** Matière émise par les cellules `SOURCE` déposées ensuite. */
  emit: MaterialId = WATER;
  /** État du tirage au sort. Voir `rand()`. */
  private state: number;
  /** Cases de départ et d'arrivée d'une créature qui bouge, et ce qu'elle déplace : alloués une fois, à la taille de la plus grande. */
  private readonly moveFrom = new Int32Array(RABBIT_SIZE);
  private readonly moveTo = new Int32Array(RABBIT_SIZE);
  private readonly carryId = new Uint8Array(RABBIT_SIZE);
  private readonly carryLife = new Uint8Array(RABBIT_SIZE);
  /** Cellules de la créature en train de bouger (`relocate`), lues par `owns()`. */
  private moving = 0;
  /** Commandes tenues par le joueur (bits de `PILOT`) : tous les héros du bac y obéissent. */
  pilot = 0;
  /** Index du cœur du dernier héros mis à jour, -1 s'il n'y en a jamais eu : la caméra le suit. À vérifier (`cells[hero] === HERO`), il a pu mourir depuis. */
  hero = -1;

  constructor(width: number, height: number, seed = (Math.random() * 0x1_0000_0000) >>> 0) {
    // Un xorshift32 meurt sur 0 : toute graine nulle devient 1.
    this.state = seed >>> 0 || 1;
    this.width = width;
    this.height = height;
    const n = width * height;
    this.cells = new Uint8Array(n);
    this.life = new Uint8Array(n);
    this.temp = new Float32Array(n).fill(this.ambient);
    this.tempNext = new Float32Array(n);
    this.clock = new Uint8Array(n);
    this.frozen = new Uint8Array(n);
    this.noise = new Int8Array(n);
    for (let i = 0; i < n; i++) this.noise[i] = ((this.rand() * 255) | 0) - 128;
    this.cols = Math.ceil(width / CHUNK);
    this.rows = Math.ceil(height / CHUNK);
    this.awake = new Uint8Array(this.cols * this.rows);
    this.was = new Uint8Array(this.cols * this.rows);
    this.shown = new Uint8Array(this.cols * this.rows);
    this.stir = new Uint8Array(this.cols * this.rows).fill(1);
  }

  /** Sens de la gravité : 1 vers le bas, -1 vers le haut. La retourner réveille tout le bac. */
  get gravity(): 1 | -1 {
    return this.fall;
  }

  set gravity(value: 1 | -1) {
    if (value === this.fall) return;
    this.fall = value;
    this.wakeAll();
  }

  /** Température de l'air au repos : tout y retourne (climat de la scène). La changer réveille tout le bac. */
  get ambient(): number {
    return this.air;
  }

  set ambient(value: number) {
    if (value === this.air) return;
    this.air = value;
    this.wakeAll();
  }

  /**
   * Réveille tout le bac au prochain tick. À appeler après toute écriture
   * dans les tableaux qui ne passe pas par le moteur (annuler, `put()` du
   * rejeu) : sinon un bloc endormi ignore ce qu'on vient d'y poser.
   *
   * C'est aussi ce qui tient le salon et le rejeu en phase : quels blocs
   * dorment dépend de toute la partie passée, qu'un invité ne connaît pas.
   * Chaque départ (`put()`) réveille tout, chez l'hôte comme chez l'invité,
   * et les deux repartent des mêmes blocs — donc des mêmes tirages. Tous
   * comptent alors pour réveillés (`rouse()`) : leurs horloges repartent de
   * zéro des deux côtés, quoi qu'aient dormi les uns et les autres.
   */
  wakeAll(): void {
    this.stir.fill(1);
    this.awake.fill(0);
  }

  /**
   * Les blocs qui ont pu changer d'aspect depuis l'appel précédent, écrits
   * dans `out` (1 = à redessiner) : ceux qu'un tick a traités, et ceux écrits
   * depuis — un geste bac en pause. Un bloc endormi n'a pas bougé d'un pixel,
   * ni sa matière ni sa température.
   */
  changed(out: Uint8Array): void {
    const { shown, stir } = this;
    for (let c = 0; c < shown.length; c++) out[c] = shown[c] | stir[c];
    shown.fill(0);
  }

  /** Le bloc de la cellule `i` a changé : il est diffusé à ce tick et balayé au suivant, avec ses voisins. */
  private wake(i: number): void {
    const y = (i / this.width) | 0;
    this.stir[(y >> SHIFT) * this.cols + ((i - y * this.width) >> SHIFT)] = 1;
  }

  /**
   * Blocs à traiter à ce tick : ceux de `stir` et leurs huit voisins — une
   * cellule ne lit que ses voisines immédiates, un changement au bord d'un
   * bloc peut donc faire bouger le bloc d'à côté (le sable qui glisse en
   * diagonale vers le trou d'un coin).
   *
   * Un bloc qui vient de se réveiller remet ses horloges au tick d'avant :
   * endormi, il n'y a plus touché, et réveillé un tick sur deux il retombait
   * toujours sur la même parité — toutes ses cellules passaient leur tour.
   */
  private rouse(): void {
    const { awake, was, stir, cols, rows, clock, width: w, height: h } = this;
    was.set(awake);
    awake.fill(0);
    for (let cy = 0; cy < rows; cy++) {
      for (let cx = 0; cx < cols; cx++) {
        if (!stir[cy * cols + cx]) continue;
        for (let y = Math.max(0, cy - 1); y <= Math.min(rows - 1, cy + 1); y++) {
          for (let x = Math.max(0, cx - 1); x <= Math.min(cols - 1, cx + 1); x++) awake[y * cols + x] = 1;
        }
      }
    }
    stir.fill(0);
    const before = this.parity ^ 1;
    for (let c = 0; c < awake.length; c++) {
      if (!awake[c] || was[c]) continue;
      const x0 = (c % cols) << SHIFT, y0 = ((c / cols) | 0) << SHIFT;
      const x1 = Math.min(w, x0 + CHUNK), y1 = Math.min(h, y0 + CHUNK);
      for (let y = y0; y < y1; y++) clock.fill(before, y * w + x0, y * w + x1);
    }
  }

  /**
   * Le seul tirage au sort du moteur : xorshift32, semé par le constructeur.
   * `Math.random()` n'est pas reproductible, donc deux moteurs — celui-ci et
   * un futur portage Rust/WASM — ne pourraient pas être comparés, et un bug
   * observé ne pourrait pas être rejoué. Toute règle qui tire au sort passe
   * par ici : un `Math.random()` de plus dans ce fichier rouvrirait le trou.
   */
  rand(): number {
    let s = this.state;
    s ^= s << 13; s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5; s >>>= 0;
    this.state = s;
    return s / 0x1_0000_0000;
  }

  /**
   * De quoi repartir d'un point précis de la partie : l'état du tirage et le
   * sens du balayage. C'est le strict complément des tableaux (`cells`,
   * `life`, `temp`, `frozen`) pour rejouer une suite de ticks à l'identique —
   * un rejeu qui oublierait le sens du balayage ferait dériver la matière du
   * mauvais côté dès le premier tick.
   */
  get seed(): number {
    return this.state;
  }

  set seed(value: number) {
    this.state = value >>> 0 || 1;
  }

  get scan(): number {
    return this.parity;
  }

  /** À poser avec `clock` : les deux ensemble disent qui a déjà bougé. */
  set scan(value: number) {
    this.parity = value & 1;
  }

  index(x: number, y: number): number {
    return y * this.width + x;
  }

  inBounds(x: number, y: number): boolean {
    return x >= 0 && x < this.width && y >= 0 && y < this.height;
  }

  get(x: number, y: number): MaterialId {
    return this.inBounds(x, y) ? this.cells[this.index(x, y)] : STONE; // hors grille = mur
  }

  set(x: number, y: number, id: MaterialId): void {
    if (!this.inBounds(x, y)) return;
    const i = this.index(x, y);
    this.wake(i);
    this.cells[i] = id;
    this.frozen[i] = 0; // repeindre par-dessus libère la cellule
    // Une source garde dans `life` la matière qu'elle crache.
    this.life[i] = id === SOURCE ? this.emit : (MATERIALS[id].life ?? 0);
    const spawn = MATERIALS[id].spawn ?? MATERIALS[id].heat;
    if (spawn !== undefined) this.temp[i] = spawn;
  }

  /**
   * Transformation décidée par une règle (le feu prend, l'acide ronge, le sel
   * fond) : elle passe son tour sur une cellule figée. `set()` libère au
   * contraire ce qu'il touche — c'est le geste du pinceau, pas de la
   * simulation.
   */
  private become(x: number, y: number, id: MaterialId): void {
    if (this.inBounds(x, y) && this.frozen[this.index(x, y)]) return;
    this.set(x, y, id);
  }

  clear(): void {
    this.cells.fill(EMPTY);
    this.life.fill(0);
    this.frozen.fill(0);
    this.temp.fill(this.ambient);
    this.wakeAll();
  }

  /**
   * Le carré englobant d'un disque, ramené dans la grille : les boucles en
   * disque n'ont alors plus à tester les bords, et surtout leur coût est celui
   * de la grille, jamais celui du rayon demandé. Un rayon monstrueux venu d'un
   * pair de salon (`applyGesture`) figeait sinon l'onglet de l'hôte sur une
   * boucle en (2r+1)².
   */
  private disc(cx: number, cy: number, radius: number): [number, number, number, number] {
    // Un rayon négatif ou NaN laisse les bornes croisées : la boucle ne tourne pas, comme avant.
    const r = Math.min(radius, this.width + this.height);
    return [
      Math.max(0, Math.ceil(cx - r)), Math.min(this.width - 1, Math.floor(cx + r)),
      Math.max(0, Math.ceil(cy - r)), Math.min(this.height - 1, Math.floor(cy + r)),
    ];
  }

  /**
   * Dépose un disque de matière (pinceau).
   * `overwrite = false` : on ne peint que le vide, la matière déjà là est
   * préservée. La gomme, elle, efface toujours.
   * `only` : ne touche que les cellules de cette matière (gomme sélective).
   */
  paint(cx: number, cy: number, radius: number, id: MaterialId, density = 1, overwrite = true, only?: MaterialId): void {
    // Une créature a sa taille : un coup de pinceau en pose une, quel que soit le rayon.
    if (CREATURE[id]) { this.spawn(id === HERO ? HERO_SHAPE : RABBIT_SHAPE, Math.round(cx), Math.round(cy), 1, overwrite); return; }
    const r2 = radius * radius;
    const [x0, x1, y0, y1] = this.disc(cx, cy, radius);
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const dx = x - cx, dy = y - cy;
        if (dx * dx + dy * dy > r2) continue;
        if (density < 1 && this.rand() > density) continue;
        const at = this.cells[this.index(x, y)];
        if (only !== undefined && at !== only) continue;
        if (!overwrite && id !== EMPTY && at !== EMPTY) continue;
        this.set(x, y, id);
      }
    }
  }

  /**
   * Remplit un rectangle (bornes comprises, remises dans l'ordre) — l'outil
   * Rectangle. Le pinceau à main levée ne trace pas un mur droit, et il en faut
   * un pour bâtir un réservoir ou un moule.
   */
  rect(x0: number, y0: number, x1: number, y1: number, id: MaterialId, overwrite = true): void {
    // Un rectangle de cœurs sans place pour leurs corps mourrait aussitôt : un lapin, au milieu.
    if (CREATURE[id]) { this.spawn(id === HERO ? HERO_SHAPE : RABBIT_SHAPE, Math.round((x0 + x1) / 2), Math.round((y0 + y1) / 2), 1, overwrite); return; }
    const left = Math.max(0, Math.min(x0, x1));
    const right = Math.min(this.width - 1, Math.max(x0, x1));
    const top = Math.max(0, Math.min(y0, y1));
    const bottom = Math.min(this.height - 1, Math.max(y0, y1));
    for (let y = top; y <= bottom; y++) {
      for (let x = left; x <= right; x++) {
        // Même règle que le pinceau : « ne pas écraser » préserve ce qui est là.
        if (!overwrite && id !== EMPTY && this.cells[this.index(x, y)] !== EMPTY) continue;
        this.set(x, y, id);
      }
    }
  }

  /**
   * Découpe un rectangle de la grille (bornes comprises, remises dans l'ordre).
   * `life` part avec : sans lui un interrupteur collé perdrait son état et une
   * source la matière qu'elle crache. La température, elle, reste au bac.
   */
  copy(x0: number, y0: number, x1: number, y1: number): Clip {
    const left = Math.max(0, Math.min(x0, x1));
    const top = Math.max(0, Math.min(y0, y1));
    // Bornes remises dans la grille : un rectangle entièrement dehors donnerait
    // une largeur négative, et `new Uint8Array(-3)` jette.
    const width = Math.max(1, Math.min(this.width - 1, Math.max(x0, x1)) - left + 1);
    const height = Math.max(1, Math.min(this.height - 1, Math.max(y0, y1)) - top + 1);
    const clip: Clip = {
      width, height,
      cells: new Uint8Array(width * height),
      life: new Uint8Array(width * height),
      frozen: new Uint8Array(width * height),
    };
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const from = this.index(left + x, top + y);
        const to = y * width + x;
        clip.cells[to] = this.cells[from];
        clip.life[to] = this.life[from];
        clip.frozen[to] = this.frozen[from];
      }
    }
    return clip;
  }

  /**
   * Pose une grille venue d'ailleurs (monde sauvegardé, lien partagé, salon).
   * Un id absent de `MATERIALS` — matière retirée depuis, ou octet inventé —
   * retombe sur le vide : sans ça `MATERIALS[id].heat` jette à chaque tick et
   * le bac s'arrête pour de bon.
   */
  adopt(cells: Uint8Array): void {
    // `cells` peut être plus court que la grille (flux RLE tronqué) : on ne
    // pose que ce qui est décrit, le reste du bac garde sa matière d'avant.
    for (let i = 0; i < cells.length; i++) {
      this.cells[i] = MATERIALS[cells[i]] ? cells[i] : EMPTY;
    }
    this.wakeAll();
  }

  /** Repose un morceau, coin haut-gauche en (cx, cy). Ce qui dépasse est ignoré. */
  paste(clip: Clip, cx: number, cy: number): void {
    for (let y = 0; y < clip.height; y++) {
      for (let x = 0; x < clip.width; x++) {
        if (!this.inBounds(cx + x, cy + y)) continue;
        const to = this.index(cx + x, cy + y);
        const from = y * clip.width + x;
        this.wake(to);
        // Un morceau peut venir d'un pair : même filtre que `adopt`.
        this.cells[to] = MATERIALS[clip.cells[from]] ? clip.cells[from] : EMPTY;
        this.life[to] = clip.life[from];
        this.frozen[to] = clip.frozen[from];
      }
    }
  }

  /** Fige (ou libère) un disque : la matière garde son identité mais ne bouge plus. */
  setFrozen(cx: number, cy: number, radius: number, on: boolean): void {
    const r2 = radius * radius;
    const [x0, x1, y0, y1] = this.disc(cx, cy, radius);
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const dx = x - cx, dy = y - cy;
        if (dx * dx + dy * dy > r2) continue;
        const i = this.index(x, y);
        if (this.cells[i] === EMPTY) continue;
        this.frozen[i] = on ? 1 : 0;
        this.wake(i);
      }
    }
  }

  /**
   * Remplit la poche de matière identique sous (x,y) — clic droit.
   * Parcours en largeur avec une pile de scalaires : pas d'objets, la poche
   * peut faire toute la grille.
   */
  fill(x: number, y: number, id: MaterialId): void {
    // En x = 1,5, les écritures tombent à côté du tableau typé : la poche ne
    // se remplit jamais, la pile ne se vide plus, et l'onglet gèle.
    if (!Number.isInteger(x) || !Number.isInteger(y) || !this.inBounds(x, y)) return;
    const start = this.index(x, y);
    const from = this.cells[start];
    if (from === id || CREATURE[id]) return; // une poche ne se remplit pas de lapins
    const stack = [start];
    while (stack.length > 0) {
      const i = stack.pop()!;
      if (this.cells[i] !== from || this.frozen[i]) continue;
      this.become(i % this.width, (i / this.width) | 0, id);
      const cx = i % this.width;
      if (cx > 0) stack.push(i - 1);
      if (cx < this.width - 1) stack.push(i + 1);
      if (i >= this.width) stack.push(i - this.width);
      if (i < this.cells.length - this.width) stack.push(i + this.width);
    }
  }

  /**
   * Une cellule pleine peut-elle prendre la place d'une autre ? Appelée à
   * chaque tentative de déplacement, soit plusieurs fois par cellule et par
   * tick : elle lit les tables plutôt que le registre.
   */
  private displaces(moverId: MaterialId, targetId: MaterialId): boolean {
    if (targetId === EMPTY) return true;
    const kind = KIND[targetId];
    if (kind === KINDS.static || kind === KINDS.powder) return false;
    return DENSITY[moverId] > DENSITY[targetId];
  }

  private swap(a: number, b: number): void {
    const c = this.cells[a]; this.cells[a] = this.cells[b]; this.cells[b] = c;
    const l = this.life[a]; this.life[a] = this.life[b]; this.life[b] = l;
    const t = this.temp[a]; this.temp[a] = this.temp[b]; this.temp[b] = t;
    this.clock[a] = this.parity;
    this.clock[b] = this.parity;
    this.wake(a);
    this.wake(b);
  }

  /** Tente le déplacement vers (x,y) ; renvoie true si la cellule a bougé. */
  private tryMove(from: number, x: number, y: number, id: MaterialId): boolean {
    if (!this.inBounds(x, y)) return false;
    const to = this.index(x, y);
    if (this.frozen[to]) return false;
    if (!this.displaces(id, this.cells[to])) return false;
    this.swap(from, to);
    return true;
  }

  /** Sens horizontal tiré au sort, biaisé par le vent. */
  private drift(): number {
    return this.rand() < 0.5 + this.wind / 2 ? 1 : -1;
  }

  /**
   * Un tick. Le balayage garde son ordre — sens de la gravité, x alterné —
   * mais saute la portion de rangée d'un bloc endormi (`rouse()`).
   *
   * Une cellule qui passe son tour à cause de `clock` tient son bloc éveillé
   * au tick suivant. Un bloc qui a dormi n'a plus touché à ses horloges, et
   * une cellule vide n'y touche jamais : au réveil (gravité retournée, grain
   * peint dans le vide), la moitié du temps tout le bloc passait son tour,
   * n'écrivait rien, et se rendormait — le sable restait collé au plafond.
   */
  step(): void {
    this.parity ^= 1;
    this.rouse();
    const { width: w, height: h, cells, frozen, clock, life, awake, stir, cols, parity } = this;
    const leftToRight = parity === 0;
    const down = this.fall === 1;
    // On balaie dans le sens de la gravité : la matière tombe d'abord.
    for (let k = 0; k < h; k++) {
      const y = down ? h - 1 - k : k;
      const row = (y >> SHIFT) * cols;
      for (let j = 0; j < w; j++) {
        const x = leftToRight ? j : w - 1 - j;
        const c = row + (x >> SHIFT);
        if (!awake[c]) {
          j = leftToRight ? x | (CHUNK - 1) : w - 1 - (x & ~(CHUNK - 1));
          continue;
        }
        const i = y * w + x;
        const id = cells[i];
        if (id === EMPTY) continue;
        if (frozen[i]) continue; // figée : aucune règle ne s'applique
        if (clock[i] === parity || ACTIVE[id] || (id === METAL && life[i] > 0)) stir[c] = 1;
        if (clock[i] === parity) continue;
        clock[i] = parity;
        this.update(i, x, y, id);
      }
    }
    this.thermal();
    for (let c = 0; c < awake.length; c++) if (awake[c]) this.shown[c] = 1;
  }

  private update(i: number, x: number, y: number, id: MaterialId): void {
    switch (id) {
      case FIRE: this.updateFire(i, x, y); return;
      case LAVA: this.updateLava(i, x, y); return;
      case ACID: this.updateAcid(i, x, y); return;
      case PLANT: this.updatePlant(i, x, y); return;
      case TNT: this.updateTnt(x, y); return;
      case NITRO: this.updateNitro(i, x, y); return;
      case C4: this.updateC4(i, x, y); return;
      case MINE: this.updateMine(x, y); return;
      case THERMITE: this.updateThermite(i, x, y); return;
      case URANIUM: this.updateUranium(i, x, y); return;
      case FALLOUT: this.updateFallout(i, x, y); return;
      case SALT: this.updateSalt(i, x, y); return;
      case SEED: this.updateSeed(i, x, y); return;
      case NANITE: this.updateNanite(i, x, y); return;
      case SOURCE: this.updateSource(i, x, y); return;
      case CANDLE: this.updateCandle(i, x, y); return;
      case BATTERY: this.updateBattery(i, x, y); return;
      case SWITCH: this.updateSwitch(i, x, y); return;
      case EMBER: this.updateEmber(i, x, y); return;
      case SPARK: this.updateSpark(i, x, y); return;
      case MAGNET: this.updateMagnet(i, x, y); return;
      case RABBIT: this.updateRabbit(i, x, y); return;
      case RABBIT_BODY: case RABBIT_EYE: case RABBIT_TAIL: this.updatePart(RABBIT_SHAPE, x, y, id); return;
      case HERO: this.updateHero(i, x, y); return;
      case HERO_HEAD: case HERO_BODY: case HERO_LEGS: this.updatePart(HERO_SHAPE, x, y, id); return;
      // Le métal ne fait que sortir de sa période de repos.
      case METAL: if (this.life[i] > 0) this.life[i]--; return;
    }
    switch (KIND[id]) {
      case KINDS.powder: this.updatePowder(i, x, y, id); return;
      case KINDS.liquid: this.updateLiquid(i, x, y, id); return;
      case KINDS.gas: this.updateGas(i, x, y, id); return;
      default: return; // statique
    }
  }

  private updatePowder(i: number, x: number, y: number, id: MaterialId): void {
    const down = y + this.gravity;
    if (this.tryMove(i, x, down, id)) return;
    const dir = this.drift();
    if (this.tryMove(i, x + dir, down, id)) return;
    this.tryMove(i, x - dir, down, id);
  }

  private updateLiquid(i: number, x: number, y: number, id: MaterialId): void {
    const down = y + this.gravity;
    if (this.tryMove(i, x, down, id)) return;
    const dir = this.drift();
    if (this.tryMove(i, x + dir, down, id)) return;
    if (this.tryMove(i, x - dir, down, id)) return;
    // Étalement : on glisse aussi loin que possible du même côté.
    const spread = SPREAD[id];
    let cur = i, cx = x;
    for (let s = 0; s < spread; s++) {
      if (!this.tryMove(cur, cx + dir, y, id)) break;
      cx += dir;
      cur = this.index(cx, y);
    }
    if (spread > 0 && cur === i && this.canMove(x - dir, y, id)) this.wake(i);
  }

  /**
   * `tryMove()` sans bouger. Un liquide ne tente qu'un côté par tick, tiré au
   * sort : bloqué de ce côté-là mais libre de l'autre, il n'a rien écrit et
   * son bloc s'endormirait avec de l'eau suspendue au bord d'une marche.
   */
  private canMove(x: number, y: number, id: MaterialId): boolean {
    if (!this.inBounds(x, y)) return false;
    const to = this.index(x, y);
    return !this.frozen[to] && this.displaces(id, this.cells[to]);
  }

  private updateGas(i: number, x: number, y: number, id: MaterialId): void {
    if (this.decay(i, id, EMPTY)) return;
    this.moveGas(i, x, y, id);
  }

  /** Montée d'un gaz, sans le vieillissement (le feu gère sa propre fin de vie). */
  private moveGas(i: number, x: number, y: number, id: MaterialId): void {
    const up = y - this.gravity;
    const dir = this.drift();
    if (this.rand() < 0.7 && this.tryMove(i, x, up, id)) return;
    if (this.tryMove(i, x + dir, up, id)) return;
    this.tryMove(i, x + dir, y, id);
  }

  /** Décrémente la vie ; à zéro remplace par `into`. */
  private decay(i: number, id: MaterialId, into: MaterialId): boolean {
    const max = LIFE[id];
    if (max === 0) return false;
    if (this.life[i] === 0) this.life[i] = max;
    if (--this.life[i] > 0) return false;
    this.wake(i);
    this.cells[i] = into;
    this.life[i] = LIFE[into];
    return true;
  }

  private updateFire(i: number, x: number, y: number): void {
    // L'eau tue la flamme, et se change en vapeur.
    for (let k = 0; k < 4; k++) {
      const nx = x + NX[k], ny = y + NY[k];
      const n = this.get(nx, ny);
      if (n === WATER || n === SALTWATER) {
        this.become(nx, ny, STEAM);
        this.become(x, y, STEAM);
        return;
      }
    }
    this.ignite(x, y);
    if (this.decay(i, FIRE, SMOKE)) return;
    if (this.rand() < 0.6) this.moveGas(i, x, y, FIRE);
  }

  /**
   * La lave fond le sable voisin et enflamme ce qui brûle, par tirage : elle
   * ne tient son bloc éveillé (`wake`) que si elle a l'un ou l'autre à côté.
   * Une poche enfermée dans la pierre dort — sa chaleur, elle, reste diffusée
   * par `thermal()` tant qu'elle n'est pas à l'équilibre.
   */
  private updateLava(i: number, x: number, y: number): void {
    let busy = false;
    for (let k = 0; k < 4; k++) {
      const nx = x + NX[k], ny = y + NY[k];
      const n = this.get(nx, ny);
      if (n === WATER || n === SALTWATER) {
        this.become(nx, ny, STEAM);
        this.become(x, y, STONE);
        return;
      }
      if (n === SAND || FLAMMABLE[n] > 0) busy = true;
      if (n === SAND && this.rand() < 0.01) this.become(nx, ny, LAVA);
    }
    if (busy) this.wake(i);
    this.ignite(x, y, 2);
    this.updateLiquid(i, x, y, LAVA);
  }

  /** Met le feu aux voisins inflammables. */
  private ignite(x: number, y: number, boost = 1): void {
    for (let k = 0; k < 4; k++) {
      const nx = x + NX[k], ny = y + NY[k];
      const n = this.get(nx, ny);
      const chance = FLAMMABLE[n];
      if (!chance || this.rand() > chance * boost) continue;
      // Le bois ne disparaît pas en fumée : il passe par la braise.
      this.become(nx, ny, n === WOOD && this.rand() < 0.5 ? EMBER : FIRE);
    }
  }

  private updateAcid(i: number, x: number, y: number): void {
    for (let k = 0; k < 4; k++) {
      const nx = x + NX[k], ny = y + NY[k];
      const n = this.get(nx, ny);
      const dissolvable = n === STONE || n === WOOD || n === SAND || n === PLANT
        || n === GLASS || n === ICE || n === SEED || CREATURE[n] === 1;
      if (dissolvable && this.rand() < 0.06) {
        this.become(nx, ny, EMPTY);
        if (this.rand() < 0.5) { this.become(x, y, SMOKE); return; } // l'acide s'use
      }
    }
    this.updateLiquid(i, x, y, ACID);
  }

  /**
   * La plante boit l'eau voisine et pousse. Sans eau à côté elle n'a rien à
   * faire : elle ne tient son bloc éveillé (`wake`) que si elle en touche —
   * sinon chaque arbre d'un monde généré gardait sa colline éveillée pour rien.
   */
  private updatePlant(i: number, x: number, y: number): void {
    let water = -1;
    for (let k = 0; k < 4 && water < 0; k++) if (this.get(x + NX[k], y + NY[k]) === WATER) water = k;
    if (water < 0) return;
    this.wake(i);
    if (this.rand() > 0.08) return;
    this.become(x + NX[water], y + NY[water], PLANT);
    // Une pousse peut partir vers le haut ou en biais.
    const dx = (this.rand() * 3 | 0) - 1;
    const up = y - this.gravity;
    if (this.get(x + dx, up) === EMPTY && this.rand() < 0.5) this.become(x + dx, up, PLANT);
  }

  /** Le TNT n'attend que la flamme ; la chaîne se propage par le feu de l'explosion. */
  private updateTnt(x: number, y: number): void {
    for (let k = 0; k < 4; k++) {
      const nx = x + NX[k], ny = y + NY[k];
      const n = this.get(nx, ny);
      if (n === FIRE || n === LAVA) { this.explode(x, y); return; }
    }
  }

  /**
   * Nitroglycérine : le choc, pas la chaleur. `life` compte les cellules de
   * chute (le `swap` l'emmène avec elle) ; l'atterrissage au-delà de `SHOCK`
   * détonne. Posée à la main, elle est inoffensive.
   */
  private updateNitro(i: number, x: number, y: number): void {
    for (let k = 0; k < 4; k++) {
      const nx = x + NX[k], ny = y + NY[k];
      const n = this.get(nx, ny);
      if (n === FIRE || n === LAVA) { this.explode(x, y, 5); return; }
    }
    const down = y + this.gravity;
    if (this.tryMove(i, x, down, NITRO)) {
      const j = this.index(x, down);
      if (this.life[j] < SHOCK) this.life[j]++;
      return;
    }
    if (this.life[i] >= SHOCK) { this.explode(x, y, 5); return; }
    this.life[i] = 0; // elle s'est arrêtée : le compteur repart de zéro
    this.updateLiquid(i, x, y, NITRO);
  }

  /**
   * C4 : le feu ne lui fait rien, seule l'étincelle le déclenche. `life` = 1
   * marque une charge amorcée par la détonation d'une voisine, pour qu'un mur
   * parte en entier sans dépendre des flammes.
   */
  private updateC4(i: number, x: number, y: number): void {
    if (this.life[i] === 1) { this.explode(x, y, 9); return; }
    for (let k = 0; k < 4; k++) {
      const nx = x + NX[k], ny = y + NY[k];
      if (this.get(nx, ny) === SPARK) { this.explode(x, y, 9); return; }
    }
  }

  /** Mine : seul ce qui coule appuie dessus, on peut donc la murer sans la faire sauter. */
  private updateMine(x: number, y: number): void {
    const above = y - this.gravity;
    if (!this.inBounds(x, above)) return;
    const kind = MATERIALS[this.cells[this.index(x, above)]].kind;
    if (kind === "powder" || kind === "liquid") this.explode(x, y, 6);
  }

  /**
   * Thermite : elle ne souffle rien, elle perce. `life` = ticks de combustion
   * restants (0 = éteinte), pendant lesquels elle impose 2800 °C sur place —
   * au-dessus du point de fusion de la pierre, que rien d'autre n'atteint.
   */
  private updateThermite(i: number, x: number, y: number): void {
    if (this.life[i] > 0) {
      this.temp[i] = 2800;
      // `convert` plutôt que `set` : la braise garde la chaleur accumulée.
      if (--this.life[i] === 0) { this.convert(i, EMBER); return; }
      // Elle continue de tomber en brûlant : elle s'enfonce dans ce qu'elle
      // liquéfie (densité 8, elle passe sous la lave), et c'est ça qui perce.
      this.updatePowder(i, x, y, THERMITE);
      return;
    }
    for (let k = 0; k < 4; k++) {
      const nx = x + NX[k], ny = y + NY[k];
      const n = this.get(nx, ny);
      const lit = n === THERMITE && this.life[this.index(nx, ny)] > 0;
      if (n === FIRE || n === LAVA || n === SPARK || lit) { this.life[i] = BURN; return; }
    }
    this.updatePowder(i, x, y, THERMITE);
  }

  /**
   * Uranium. Son déclencheur n'est ni le feu ni le choc : c'est **sa propre
   * masse**. Isolé il tiédit et sert de chauffage ; en tas il s'emballe,
   * chauffe de plus en plus (visible en vue thermique), et finit par sauter.
   * Casser le tas fait redescendre le compteur : c'est la seule parade.
   */
  private updateUranium(i: number, x: number, y: number): void {
    let mass = 0;
    for (let k = 0; k < 4; k++) {
      const nx = x + NX[k], ny = y + NY[k];
      if (this.get(nx, ny) === URANIUM) mass++;
    }
    if (mass >= CRITICAL) {
      if (++this.life[i] >= MELTDOWN) { this.nuke(x, y); return; }
    } else if (this.life[i] > 0) this.life[i]--;
    this.temp[i] = Math.max(this.temp[i], 60 + this.life[i] * 6);
    this.updatePowder(i, x, y, URANIUM);
  }

  /** Le souffle, puis ce qui distingue le nucléaire : le nuage qui reste. */
  private nuke(cx: number, cy: number): void {
    this.explode(cx, cy, NUKE);
    for (const [ox, oy] of disc(NUKE)) {
      const x = cx + ox, y = cy + oy;
      if (!this.inBounds(x, y)) continue;
      if (this.cells[this.index(x, y)] === EMPTY && this.rand() < 0.2) this.become(x, y, FALLOUT);
    }
  }

  /** Les retombées : un gaz ordinaire, sauf que rien de vivant n'y tient. */
  private updateFallout(i: number, x: number, y: number): void {
    for (let k = 0; k < 4; k++) {
      const nx = x + NX[k], ny = y + NY[k];
      const n = this.get(nx, ny);
      if (n === PLANT || n === SEED || CREATURE[n] === 1) this.become(nx, ny, EMPTY);
    }
    this.updateGas(i, x, y, FALLOUT);
  }

  /**
   * Souffle. Le cœur est pulvérisé comme avant, mais la couronne est
   * **projetée vers l'extérieur** au lieu d'être effacée : la matière retombe
   * en débris. On traite les cellules de la plus lointaine à la plus proche,
   * pour que chacune parte vers une place déjà libérée.
   *
   * Ce qui n'a nulle part où aller (un mur plein) est pulvérisé : sans ce
   * repli, une explosion ne percerait plus la pierre.
   */
  explode(cx: number, cy: number, radius = 7): void {
    for (const [ox, oy, d] of disc(radius)) {
      const x = cx + ox, y = cy + oy;
      if (!this.inBounds(x, y)) continue;
      const i = this.index(x, y);
      const id = this.cells[i];
      // Une charge voisine survit à la déflagration et part au tick suivant :
      // le TNT par le feu qu'on vient de semer, le C4 amorcé par `life`.
      if ((id === TNT || id === C4) && d > 0) {
        if (id === C4) { this.life[i] = 1; this.wake(i); }
        continue;
      }
      if (this.frozen[i]) continue;
      // La portée décroît du centre vers le bord, où plus rien ne bouge.
      const range = Math.round((1 - d / radius) * radius * 1.5);
      // D'abord le rayon, puis — s'il est bouché — un jet vers le haut : c'est
      // ce qui fait sortir les débris d'une charge posée à même le sol, que le
      // seul rayon (dirigé vers le bas) laisserait sur place.
      const thrown = d > radius * 0.5 && range > 0
        && (this.hurl(i, x, y, ox / d, oy / d, range)
          || this.hurl(i, x, y, (ox / d) * 0.6, -this.gravity, range));
      if (!thrown) this.become(x, y, this.rand() < 0.5 ? FIRE : EMPTY);
      else if (this.rand() < 0.25) this.become(x, y, FIRE); // le cratère continue de brûler
    }
  }

  /**
   * Projette le contenu d'une cellule le long du rayon, jusqu'à `range`
   * cellules : elle se dépose sur la **dernière place libre** rencontrée. Les
   * débris d'une charge enterrée ressortent ainsi par le cratère au lieu de
   * s'écraser dans la matière voisine, et deux projections ne peuvent pas
   * atterrir au même endroit — la matière est conservée.
   *
   * Renvoie false si le rayon est bouché : à l'appelant de pulvériser.
   */
  private hurl(from: number, x: number, y: number, dx: number, dy: number, range: number): boolean {
    const id = this.cells[from];
    if (id === EMPTY) return true; // rien à projeter, rien à pulvériser non plus
    let to = -1;
    for (let s = 1; s <= range; s++) {
      const tx = x + Math.round(dx * s), ty = y + Math.round(dy * s);
      if (!this.inBounds(tx, ty)) break;
      const j = this.index(tx, ty);
      if (this.frozen[j]) break;
      if (this.cells[j] === EMPTY) to = j;
    }
    if (to < 0) return false;
    this.wake(from);
    this.wake(to);
    this.cells[to] = id;
    this.life[to] = this.life[from];
    this.temp[to] = this.temp[from];
    this.clock[to] = this.parity; // le débris a déjà bougé ce tick
    this.cells[from] = EMPTY;
    this.life[from] = 0;
    return true;
  }

  /** Le sel se dissout dans l'eau et fait fondre la glace. */
  private updateSalt(i: number, x: number, y: number): void {
    for (let k = 0; k < 4; k++) {
      const nx = x + NX[k], ny = y + NY[k];
      const n = this.get(nx, ny);
      if (n === WATER) { this.become(nx, ny, SALTWATER); this.become(x, y, EMPTY); return; }
      if (n === ICE && this.rand() < 0.25) { this.become(nx, ny, WATER); this.become(x, y, EMPTY); return; }
    }
    this.updatePowder(i, x, y, SALT);
  }

  private updateSeed(i: number, x: number, y: number): void {
    for (let k = 0; k < 4; k++) {
      const nx = x + NX[k], ny = y + NY[k];
      if (this.get(nx, ny) === WATER) { this.become(x, y, PLANT); return; }
    }
    this.updatePowder(i, x, y, SEED);
  }

  /** Gelée grise : dévore un voisin, se réplique, puis meurt de vieillesse. */
  private updateNanite(i: number, x: number, y: number): void {
    if (this.decay(i, NANITE, EMPTY)) return;
    for (let k = 0; k < 4; k++) {
      const nx = x + NX[k], ny = y + NY[k];
      const n = this.get(nx, ny);
      if (n === EMPTY || n === NANITE || n === GLASS || n === SOURCE) continue;
      if (this.rand() < 0.2) { this.become(nx, ny, NANITE); break; }
    }
    this.updatePowder(i, x, y, NANITE);
  }

  /** Générateur : crache sa matière (stockée dans `life`) dans la case libre voisine. */
  private updateSource(i: number, x: number, y: number): void {
    if (this.rand() > 0.5) return;
    // `life` arrive aussi d'ailleurs (lien, galerie, `clip` d'un pair), et
    // `adopt()` ne filtre que `cells` : un id inconnu faisait jeter
    // `MATERIALS[id]` au premier tick, et un lien de cinquante caractères
    // arrêtait le bac pour de bon. Il retombe sur l'eau, comme une source vide.
    const emitted = this.life[i];
    const id = emitted !== EMPTY && KNOWN[emitted] ? emitted : WATER;
    const dy = KIND[id] === KINDS.gas ? -this.gravity : this.gravity;
    if (this.get(x, y + dy) === EMPTY) this.become(x, y + dy, id);
  }

  /** Bougie : `life` sert de mèche allumée. Une fois prise, elle réalimente sa flamme. */
  private updateCandle(i: number, x: number, y: number): void {
    for (let k = 0; k < 4; k++) {
      const nx = x + NX[k], ny = y + NY[k];
      const n = this.get(nx, ny);
      if (n === FIRE || n === LAVA || n === EMBER || n === SPARK) this.life[i] = 1;
      else if (n === WATER || n === SALTWATER) this.life[i] = 0;
    }
    const up = y - this.gravity;
    if (this.life[i] === 1 && this.get(x, up) === EMPTY) this.become(x, up, FIRE);
  }

  /** Braise : plus de flamme, mais ça chauffe (via `heat`) et ça peut rallumer. */
  private updateEmber(i: number, x: number, y: number): void {
    if (this.decay(i, EMBER, SMOKE)) return;
    this.ignite(x, y, 0.5);
    this.updatePowder(i, x, y, EMBER);
  }

  /** Met le métal voisin sous tension, s'il est sorti de sa période de repos. */
  private charge(x: number, y: number): void {
    if (!this.inBounds(x, y)) return;
    const j = this.index(x, y);
    if (this.cells[j] !== METAL || this.life[j] !== 0) return;
    this.wake(j);
    this.cells[j] = SPARK;
    this.life[j] = MATERIALS[SPARK].life!;
  }

  /** Pile : une étincelle dans le métal voisin toutes les `PULSE` frames. */
  private updateBattery(i: number, x: number, y: number): void {
    if (this.life[i] > 0) { this.life[i]--; return; }
    this.life[i] = PULSE;
    for (let k = 0; k < 4; k++) {
      const nx = x + NX[k], ny = y + NY[k];
      this.charge(nx, ny);
    }
  }

  /**
   * Interrupteur : `life` = 1 quand il est fermé. Il ne devient jamais étincelle
   * lui-même — il la relaie de l'autre côté — sinon il perdrait son identité en
   * redevenant du métal.
   */
  private updateSwitch(i: number, x: number, y: number): void {
    if (this.life[i] !== 1) return;
    let live = false;
    for (let k = 0; k < 4; k++) {
      const nx = x + NX[k], ny = y + NY[k];
      if (this.get(nx, ny) === SPARK) live = true;
    }
    if (!live) return;
    for (let k = 0; k < 4; k++) {
      const nx = x + NX[k], ny = y + NY[k];
      this.charge(nx, ny);
    }
  }

  /** Ouvre / ferme l'interrupteur sous le curseur (clic sur un interrupteur déjà posé). */
  toggleSwitch(x: number, y: number): void {
    if (!this.inBounds(x, y)) return;
    const i = this.index(x, y);
    if (this.cells[i] === SWITCH) { this.life[i] ^= 1; this.wake(i); }
  }

  /**
   * Étincelle : ne circule que dans le métal, allume et fait sauter le reste.
   * Le métal traversé se repose `RECOVERY` ticks, sinon l'étincelle repart
   * aussitôt en arrière et le circuit ne s'éteint jamais.
   */
  private updateSpark(i: number, x: number, y: number): void {
    for (let k = 0; k < 4; k++) {
      const nx = x + NX[k], ny = y + NY[k];
      if (!this.inBounds(nx, ny)) continue;
      const n = this.cells[this.index(nx, ny)];
      if (n === TNT) this.explode(nx, ny);
      else if (n !== C4) this.charge(nx, ny); // le C4 se déclenche seul en voyant l'étincelle
    }
    this.ignite(x, y, 3);
    if (--this.life[i] > 0) return;
    this.wake(i);
    this.cells[i] = METAL;
    this.life[i] = RECOVERY;
  }

  /**
   * Diffusion de la chaleur, puis changements d'état.
   * Une seule loi remplace autant de cas particuliers : l'eau bout ou gèle, la
   * glace fond, le sable vitrifie, l'huile s'auto-enflamme.
   */
  /**
   * Diffusion, puis changements d'état — en deux balayages au lieu de quatre :
   * les sources de chaleur doivent toutes être posées avant que la diffusion ne
   * lise les voisines, mais le seuil d'ébullition, lui, se teste sur la
   * température qu'on vient de calculer. Et les deux tampons s'échangent plutôt
   * que de se recopier (230 ko par tick en 320×180, pour rien).
   */
  /**
   * Blocs de veille : seuls les blocs éveillés, et ceux écrits pendant ce tick
   * (une cellule qui bouge emporte sa `temp` dans ce tampon-ci), sont
   * diffusés. Un bloc dont aucune cellule n'a varié de plus de `STILL` est
   * refroidi : on recopie aussitôt sa nouvelle température dans l'autre
   * tampon, pour qu'endormi il lise la même chose à chaque échange. Sinon il
   * réveille ses voisins au tick suivant, et la chaleur continue de se
   * propager de bloc en bloc.
   *
   * La variation se mesure depuis la température **d'avant** la source
   * (`2t - heat`) : un glaçon à l'équilibre est tiré vers -20 puis rendu par
   * la diffusion, et mesuré après ce tirage il ne s'endormirait jamais.
   *
   * ponytail: une source endormie au bord d'un bloc éveillé est lue sans son
   * tirage — un demi-écart à sa `heat` sur une cellule de bord. Invisible
   * tant que l'équilibre est atteint ; à revoir si une matière chauffe sans
   * être active et loin de son équilibre.
   */
  private thermal(): void {
    const { width: w, height: h, cells, temp, tempNext, ambient, cols, awake, stir } = this;
    const n = awake.length;
    for (let c = 0; c < n; c++) awake[c] |= stir[c];
    for (let c = 0; c < n; c++) {
      if (!awake[c]) continue;
      const x0 = (c % cols) << SHIFT, y0 = ((c / cols) | 0) << SHIFT;
      const x1 = Math.min(w, x0 + CHUNK), y1 = Math.min(h, y0 + CHUNK);
      for (let y = y0; y < y1; y++) {
        for (let i = y * w + x0, end = y * w + x1; i < end; i++) {
          const heat = HEAT[cells[i]];
          // Une source tire vers sa température sans l'imposer : une flamme peut
          // encore faire fondre la glace qu'elle touche. (NaN = ne chauffe pas.)
          if (heat === heat) temp[i] += (heat - temp[i]) * 0.5;
        }
      }
    }
    for (let c = 0; c < n; c++) {
      if (!awake[c]) continue;
      const x0 = (c % cols) << SHIFT, y0 = ((c / cols) | 0) << SHIFT;
      const x1 = Math.min(w, x0 + CHUNK), y1 = Math.min(h, y0 + CHUNK);
      let still = true;
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          const i = y * w + x;
          const t = temp[i];
          const sum =
            (y > 0 ? temp[i - w] : t) + (y < h - 1 ? temp[i + w] : t) +
            (x > 0 ? temp[i - 1] : t) + (x < w - 1 ? temp[i + 1] : t);
          const next = t + CONDUCTION * (sum - 4 * t) + COOLING * (ambient - t);
          tempNext[i] = next;
          const id = cells[i];
          const heat = HEAT[id];
          const moved = next - (heat === heat ? 2 * t - heat : t);
          if (moved > STILL || moved < -STILL) still = false;
          if (next > BOIL_AT[id]) this.convert(i, BOIL_INTO[id]);
          else if (next < FREEZE_AT[id]) this.convert(i, FREEZE_INTO[id]);
        }
      }
      if (still) awake[c] = 2;
      else stir[c] = 1;
    }
    for (let c = 0; c < n; c++) {
      if (awake[c] !== 2) continue;
      const x0 = (c % cols) << SHIFT, y0 = ((c / cols) | 0) << SHIFT;
      const x1 = Math.min(w, x0 + CHUNK), y1 = Math.min(h, y0 + CHUNK);
      for (let y = y0; y < y1; y++) {
        for (let i = y * w + x0, end = y * w + x1; i < end; i++) temp[i] = tempNext[i];
      }
    }
    this.temp = tempNext;
    this.tempNext = temp;
  }

  /** Retourne le pôle de l'aimant sous le curseur : attirer ↔ repousser. */
  toggleMagnet(x: number, y: number): void {
    if (!this.inBounds(x, y)) return;
    const i = this.index(x, y);
    if (this.cells[i] === MAGNET) { this.life[i] ^= 1; this.wake(i); }
  }

  /**
   * Déplace la limaille d'un cran vers l'aimant (ou à l'opposé si son pôle est
   * inversé, `life` = 1) — le seul mouvement qui ignore la gravité.
   *
   * L'ordre de parcours du disque suit le sens du champ : les grains qui
   * arrivent les premiers doivent trouver la place libre. En attirant on part
   * donc du centre, en repoussant du bord — exactement comme le souffle.
   */
  private updateMagnet(i: number, x: number, y: number): void {
    const cells = disc(PULL);
    const push = this.life[i] === 1 ? 1 : -1;
    for (let k = 0; k < cells.length; k++) {
      const [dx, dy] = cells[push === 1 ? k : cells.length - 1 - k];
      if (dx === 0 && dy === 0) continue;
      if (!this.inBounds(x + dx, y + dy)) continue;
      const at = this.index(x + dx, y + dy);
      if (this.cells[at] !== FILINGS || this.frozen[at]) continue;
      this.tryMove(at, x + dx + push * Math.sign(dx), y + dy + push * Math.sign(dy), FILINGS);
    }
  }

  /** Pose un lapin entier (voir `spawn`). Public : les mondes générés en sèment. */
  spawnRabbit(x: number, y: number, f: number, over = false): number {
    return this.spawn(RABBIT_SHAPE, x, y, f, over);
  }

  /** Pose un héros entier (voir `spawn`). Public : un monde généré en pose un. */
  spawnHero(x: number, y: number): number {
    return this.spawn(HERO_SHAPE, x, y, 1);
  }

  /**
   * Pose une créature entière, cœur en (x, y), tournée vers `f`, si toutes ses
   * cases sont libres (ou liquides et gazeuses si `over`). Un cœur déjà là —
   * posé seul par `set()` — garde sa place et son état. Renvoie l'index du
   * cœur, -1 faute de place : une créature ne s'incruste pas dans la pierre.
   */
  private spawn(shape: Shape, x: number, y: number, f: number, over = false): number {
    const { dx, dy, id } = shape;
    for (let k = 0; k < id.length; k++) {
      const px = x + f * dx[k], py = y + dy[k];
      if (!this.inBounds(px, py)) return -1;
      const j = this.index(px, py);
      if (this.frozen[j]) return -1;
      const n = this.cells[j];
      if (n === EMPTY || (k === 0 && n === id[0])) continue;
      if (over && (KIND[n] === KINDS.liquid || KIND[n] === KINDS.gas)) continue;
      return -1;
    }
    for (let k = 0; k < id.length; k++) {
      const px = x + f * dx[k], py = y + dy[k];
      if (k === 0 && this.cells[this.index(px, py)] === id[0]) continue;
      this.become(px, py, id[k]);
    }
    const heart = this.index(x, y);
    if (shape === HERO_SHAPE) this.hero = heart;
    return heart;
  }

  /** Nombre de cellules de la créature de cœur (x, y) à leur place pour le sens `f`, cœur compris. */
  private intact(shape: Shape, x: number, y: number, f: number): number {
    const { dx, dy, id } = shape;
    let n = 0;
    for (let k = 0; k < id.length; k++) {
      if (this.get(x + f * dx[k], y + dy[k]) === id[k]) n++;
    }
    return n;
  }

  /** Change tout le corps (ce qu'il en reste) en `into` : mort, cuisson, gel. */
  private kill(shape: Shape, x: number, y: number, f: number, into: MaterialId): void {
    const { dx, dy, id } = shape;
    for (let k = 0; k < id.length; k++) {
      const px = x + f * dx[k], py = y + dy[k];
      if (this.get(px, py) === id[k]) this.become(px, py, into);
    }
  }

  /**
   * Un corps incomplet (souffle, acide, nanites, gomme) : la créature n'y
   * survit pas. Si une partie a pris feu, le reste brûle avec.
   */
  private maim(shape: Shape, x: number, y: number, f: number): void {
    let burning = false;
    for (let k = 1; k < shape.id.length; k++) {
      if (this.get(x + f * shape.dx[k], y + shape.dy[k]) === FIRE) burning = true;
    }
    this.kill(shape, x, y, f, burning ? FIRE : EMPTY);
  }

  /**
   * Lapin : une poignée de règles fixes, pas d'apprentissage. Le cœur vérifie
   * son corps, puis : cuisson, gel, noyade, faim, chute, et — posé — manger,
   * se reproduire, fuir la chaleur, chercher une plante ou flâner.
   */
  private updateRabbit(i: number, x: number, y: number): void {
    // Le sens se lit sur le corps lui-même : aucun état de plus à garder.
    const R = RABBIT_SHAPE;
    const right = this.intact(R, x, y, 1);
    const left = right === RABBIT_SIZE ? 0 : this.intact(R, x, y, -1);
    const f = right >= left ? 1 : -1;
    const whole = Math.max(right, left);
    if (whole === 1) {
      // Un cœur sans corps — posé par `set()`, ou venu d'une grille sans état
      // vivant qui a perdu le reste — se le refait s'il a la place.
      if (this.spawnRabbit(x, y, this.rand() < 0.5 ? 1 : -1) < 0) this.become(x, y, EMPTY);
      return;
    }
    if (whole < RABBIT_SIZE) { this.maim(R, x, y, f); return; }

    const t = this.temp[i];
    if (t > COOK) { this.kill(R, x, y, f, FIRE); return; }
    if (t < FROST) { this.kill(R, x, y, f, ICE); return; }
    // De l'eau par-dessus les oreilles : il se noie (plus dense qu'elle, il coule).
    const above = this.get(x, y - 3);
    if ((above === WATER || above === SALTWATER || above === MUD) && this.rand() < DROWN) {
      this.kill(R, x, y, f, EMPTY);
      return;
    }
    // Un lapin venu d'une grille sans état vivant arrive à satiété nulle : sans
    // ce repli, il mourrait de faim au premier tick.
    if (this.life[i] === 0) this.life[i] = FED;
    if (this.rand() < HUNGER && --this.life[i] === 0) { this.kill(R, x, y, f, EMPTY); return; }
    // Chute d'un bloc. Lui seul peut entrer dans un liquide plus léger : il y coule.
    if (this.relocate(R, x, y, f, x, y + this.gravity, f, true)) return;

    if (this.life[i] <= 250 - MEAL) {
      for (let k = 0; k < MOUTH_DX.length; k++) {
        const mx = x + f * MOUTH_DX[k], my = y + MOUTH_DY[k];
        if (this.get(mx, my) === PLANT) {
          this.become(mx, my, EMPTY);
          this.life[i] += MEAL;
          return; // manger prend le tour
        }
      }
    }
    if (this.life[i] >= BREED && this.rand() < LITTER && this.mate(x, y)) {
      // Le petit naît derrière lui, sinon par-dessus (il retombera).
      let baby = this.spawnRabbit(x - 4 * f, y, f);
      if (baby < 0) baby = this.spawnRabbit(x, y - 4, f);
      if (baby >= 0) {
        this.life[baby] = NEWBORN;
        this.life[i] -= LITTER_COST;
        return;
      }
    }

    // Où aller. La chaleur passe avant la faim : `temp` est déjà diffusé, donc
    // l'air se réchauffe avant que la flamme n'arrive — le lapin la sent venir.
    // On compare les deux cases qui encadrent le corps, pas ses propres cellules.
    let dir = 0, pace = PACE_WANDER;
    if (t > FLEE) {
      const outLeft = x + (f === 1 ? -3 : -2), outRight = x + (f === 1 ? 2 : 3);
      const hotLeft = this.inBounds(outLeft, y) ? this.temp[this.index(outLeft, y)] : Infinity;
      const hotRight = this.inBounds(outRight, y) ? this.temp[this.index(outRight, y)] : Infinity;
      dir = hotLeft < hotRight ? -1 : 1;
      pace = PACE_FLEE;
    } else if (this.life[i] < HUNGRY) {
      dir = this.sniff(x, y, f);
      if (dir !== 0) pace = PACE_SEEK;
    }
    if (this.rand() > pace) return;
    // En flânant, il va surtout droit devant : tiré à pile ou face à chaque
    // pas, il se retournait sans cesse sur place.
    if (dir === 0) dir = this.rand() < TURN ? -f : f;
    // Un pas, sinon une marche à grimper — en se tournant du côté où il va.
    // Seulement vers du vide ou un gaz : il n'entre pas dans l'eau de lui-même.
    if (this.relocate(R, x, y, f, x + dir, y, dir, false)) return;
    if (this.relocate(R, x, y, f, x + dir, y - this.gravity, dir, false)) return;
    if (dir !== f) this.relocate(R, x, y, f, x, y, dir, false); // bloqué : il se retourne
  }

  /**
   * Déplace le lapin entier du cœur (x, y) tourné vers `f` au cœur (nx, ny)
   * tourné vers `nf` — pas, marche, chute ou demi-tour. C'est, avec l'aimant,
   * la seule entorse à `tryMove()` : neuf cellules bougent ensemble ou pas du
   * tout. Chaque case d'arrivée doit être la sienne, vide, un gaz, ou — `wet`,
   * en tombant — un liquide plus léger que lui. Ce qu'il déplace reprend les
   * cases qu'il quitte : la matière est conservée, comme dans `hurl()`.
   */
  private relocate(shape: Shape, x: number, y: number, f: number, nx: number, ny: number, nf: number, wet: boolean): boolean {
    const { moveFrom: from, moveTo: to, cells, life, frozen } = this;
    const { dx, dy, id } = shape;
    const size = id.length;
    this.moving = size;
    for (let k = 0; k < size; k++) {
      const tx = nx + nf * dx[k], ty = ny + dy[k];
      if (!this.inBounds(tx, ty)) return false;
      from[k] = this.index(x + f * dx[k], y + dy[k]); // corps intact : dans la grille
      to[k] = this.index(tx, ty);
      if (frozen[from[k]]) return false; // une patte figée tient tout le lapin
    }
    let carried = 0;
    for (let k = 0; k < size; k++) {
      const j = to[k];
      if (frozen[j]) return false;
      const n = cells[j];
      if (n === EMPTY || this.owns(j)) continue;
      const kind = KIND[n];
      if (kind !== KINDS.gas && !(wet && kind === KINDS.liquid && DENSITY[n] < DENSITY[id[0]])) return false;
      this.carryId[carried] = n;
      this.carryLife[carried] = life[j];
      carried++;
    }
    const fed = life[from[0]];
    for (let k = 0; k < size; k++) { this.wake(from[k]); this.wake(to[k]); }
    for (let k = 0; k < size; k++) { cells[from[k]] = EMPTY; life[from[k]] = 0; }
    for (let k = 0; k < size; k++) {
      const j = to[k];
      cells[j] = id[k];
      life[j] = 0;
      this.clock[j] = this.parity; // il a bougé ce tick, ses cellules aussi
    }
    life[to[0]] = fed;
    for (let k = 0; k < size && carried > 0; k++) {
      const j = from[k];
      if (cells[j] !== EMPTY) continue;
      carried--;
      cells[j] = this.carryId[carried];
      life[j] = this.carryLife[carried];
      this.clock[j] = this.parity;
    }
    return true;
  }

  /** La case `j` fait-elle partie du corps en train de bouger (`moveFrom`) ? */
  private owns(j: number): boolean {
    for (let k = 0; k < this.moving; k++) if (this.moveFrom[k] === j) return true;
    return false;
  }

  /**
   * Une cellule du corps n'a pas d'état : elle vit tant qu'un cœur se trouve là
   * où la forme l'attend, dans un sens ou dans l'autre. Sinon — créature
   * morte, éclat d'un souffle — elle disparaît. Ne rien garder dans `life` est
   * voulu : le salon et les grilles d'avant n'en transmettent pas.
   */
  private updatePart(shape: Shape, x: number, y: number, id: MaterialId): void {
    const { dx, dy, id: ids } = shape;
    for (let k = 1; k < ids.length; k++) {
      if (ids[k] !== id) continue;
      if (this.get(x - dx[k], y - dy[k]) === ids[0]) return;
      if (this.get(x + dx[k], y - dy[k]) === ids[0]) return;
    }
    this.become(x, y, EMPTY);
  }

  /**
   * Le héros : une créature sans volonté propre, qui obéit à `pilot`. Même
   * vérifications que le lapin (corps entier, cuisson, gel, noyade), puis un
   * mouvement vertical — saut, nage, chute — et un pas de côté, qui grimpe une
   * marche s'il le faut. Il creuse devant lui (E) ou sous ses pieds (S) tout
   * ce qui est solide, sauf le métal : c'est ce qui laisse encore des murs.
   *
   * Dans un liquide il coule lentement (`SINK`), et saut tenu il remonte : il
   * nage. La tête dessous, il se noie en quelques secondes (`BREATH`).
   * Tous les héros du bac obéissent aux mêmes touches ; la caméra suit le
   * dernier mis à jour (`hero`).
   */
  private updateHero(i: number, x: number, y: number): void {
    const H = HERO_SHAPE;
    const whole = this.intact(H, x, y, 1);
    if (whole === 1) {
      if (this.spawn(H, x, y, 1) < 0) this.become(x, y, EMPTY);
      return;
    }
    if (whole < H.id.length) { this.maim(H, x, y, 1); return; }
    const t = this.temp[i];
    if (t > COOK) { this.kill(H, x, y, 1, FIRE); return; }
    if (t < FROST) { this.kill(H, x, y, 1, ICE); return; }
    const head = KIND[this.get(x, y - 3)] === KINDS.liquid;
    if (head && this.rand() < BREATH) { this.kill(H, x, y, 1, EMPTY); return; }

    const p = this.pilot, g = this.gravity;
    const dir = (p & PILOT.right ? 1 : 0) - (p & PILOT.left ? 1 : 0);
    let face = this.life[i] & FACING_LEFT ? -1 : 1;
    if (dir !== 0) face = dir;
    let jump = this.life[i] & 15;
    if (p & PILOT.dig && this.rand() < DIG) this.dig(x + 2 * face, y - 2, y + 1);
    if (p & PILOT.down && this.rand() < DIG) { this.dig(x - 1, y + 2, y + 2); this.dig(x, y + 2, y + 2); this.dig(x + 1, y + 2, y + 2); }

    const wet = head || KIND[this.get(x, y + 2)] === KINDS.liquid;
    let cy = y, grounded = false;
    if (jump > 0) {
      if (this.relocate(H, x, cy, 1, x, cy - g, 1, true)) { cy -= g; jump--; } else jump = 0;
    } else if (wet && p & PILOT.up) {
      if (this.relocate(H, x, cy, 1, x, cy - g, 1, true)) cy -= g;
    } else if ((!wet || this.rand() < SINK) && this.relocate(H, x, cy, 1, x, cy + g, 1, true)) {
      cy += g;
    } else grounded = !wet;
    if (grounded && p & PILOT.up) jump = JUMP;

    let cx = x;
    if (dir !== 0 && this.rand() < STRIDE) {
      if (this.relocate(H, cx, cy, 1, cx + dir, cy, 1, true)) cx += dir;
      else if (grounded && this.relocate(H, cx, cy, 1, cx + dir, cy - g, 1, true)) { cx += dir; cy -= g; }
    }
    const at = this.index(cx, cy);
    this.life[at] = (face < 0 ? FACING_LEFT : 0) | jump;
    this.hero = at;
  }

  /**
   * Le héros creuse la colonne `x`, de `y0` à `y1` : tout ce qui est solide —
   * statique ou poudre — part, sauf le métal et les créatures. `become` : une
   * cellule figée tient bon.
   */
  private dig(x: number, y0: number, y1: number): void {
    for (let y = y0; y <= y1; y++) {
      const n = this.get(x, y);
      const kind = KIND[n];
      if ((kind === KINDS.static || kind === KINDS.powder) && n !== METAL && !CREATURE[n] && this.inBounds(x, y)) this.become(x, y, EMPTY);
    }
  }

  /**
   * Un autre lapin repu à portée de museau : même hauteur à une rangée près,
   * de 3 à 6 cellules de cœur à cœur (plus près, les corps se chevauchent).
   */
  private mate(x: number, y: number): boolean {
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = 3; dx <= 6; dx++) {
        for (let s = -1; s <= 1; s += 2) {
          const mx = x + s * dx, my = y + dy;
          if (this.get(mx, my) === RABBIT && this.life[this.index(mx, my)] >= BREED) return true;
        }
      }
    }
    return false;
  }

  /**
   * Côté (-1 ou 1) de la plante la plus proche, de la tête au sol sous les
   * pattes, 0 si aucune n'est en vue. Il regarde d'abord devant lui : sinon, à
   * distance égale, tous les lapins partiraient du même côté.
   */
  private sniff(x: number, y: number, f: number): number {
    for (let d = 2; d <= SIGHT; d++) {
      for (let s = f, n = 0; n < 2; s = -s, n++) {
        const px = x + s * d;
        for (let dy = -1; dy <= 2; dy++) if (this.get(px, y + dy) === PLANT) return s;
      }
    }
    return 0;
  }

  /** Changement d'état sur place ; la température, elle, ne se réinitialise pas. */
  private convert(i: number, into: MaterialId): void {
    this.wake(i);
    this.cells[i] = into;
    this.life[i] = MATERIALS[into].life ?? 0;
  }

}
