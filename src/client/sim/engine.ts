import {
  ACID, BATTERY, C4, CANDLE, EMBER, EMPTY, FALLOUT, FIRE, GLASS, ICE, LAVA, MATERIALS, METAL,
  FILINGS, HERO, HERO_BODY, HERO_HARM, HERO_HEAD, HERO_LEGS, HERO_SLOTS, MAGNET, MINE, MUD, NANITE, NITRO, PILOT, PLANT, RABBIT, RABBIT_BODY, RABBIT_EYE, RABBIT_TAIL,
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
/**
 * Pression de l'air (voir `breathe()`). Elle se diffuse d'une cellule d'air à
 * l'autre en `AIR_STEPS` sous-pas par tick : en un seul, un souffle ne
 * poussait la fumée qu'à quatre cellules de son bord, trop lent pour se voir.
 */
const AIR_STEPS = 3;
/** Part de l'écart avec les voisines échangée par sous-pas (au-delà de 0,25 le calcul s'emballe). */
const FLOW = 0.2;
/** Ce qui reste de la pression après un sous-pas : elle retombe en une seconde environ. */
const DAMP = 0.98;
/** Sous ce seuil, partout dans un bloc, sa pression est remise à zéro et il peut s'endormir. */
const CALM_P = 0.02;
/**
 * Portée de l'onde d'un souffle, en rayons, et sa pente : la pression vaut
 * `BLOW` par cellule qui reste jusqu'au bord de l'onde, donc un gradient
 * constant qui pousse les gaz presque à chaque tick. Posée d'un coup : à 60
 * ticks par seconde, une onde de choc traverse le bac en moins d'un tick, et
 * la seule diffusion la laissait collée au cratère (quatre cellules en une
 * demi-seconde).
 */
const REACH = 3;
const BLOW = 1;
/** Ce qu'une pièce close multiplie au plus la pression d'une onde (voir `wave()`) : une niche d'une cellule ne la porte pas à l'infini. */
const CONFINED = 6;
/** Pression d'une bouffée de vapeur (eau sur la lave). */
const STEAM_PUFF = 6;
/** Pression plafond d'une cellule : des souffles en chaîne ne la font pas grimper sans fin. */
const MAX_P = 200;
/** Chance, par tick et par unité de gradient, qu'un gaz soit poussé par le vent. */
const GUST = 1.5;
/** Gradient sous lequel un gaz ne sent pas le vent (et ne tire rien au sort). */
const GUST_MIN = 0.03;
/**
 * Pression d'air au contact au-delà de laquelle le verre peut éclater ; la
 * chance par tick croît avec l'excès (1 au double). À l'air libre, l'onde d'un
 * TNT la dépasse à dix cellules du centre ; dans une pièce close, elle ne
 * s'échappe pas et tient au-dessus plus longtemps.
 */
const SHATTER = 6;
/**
 * Gradient sous lequel une poudre ne bouge pas : bien au-dessus de celui des
 * gaz (`GUST_MIN`), pour que seul le cœur d'une onde soulève le sable — sinon
 * chaque dune d'un monde généré glissait au moindre souffle lointain.
 */
const SWEEP_MIN = 0.5;
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
/** Dégâts par tick trop chaud ou trop froid (`COOK`, `FROST`) : moins d'une seconde dans les flammes. */
const SCALD = 4;
/** Dégâts par tick la tête sous un liquide : trois secondes d'apnée, un peu plus s'il était indemne. */
const CHOKE = 1;
/** Chance, par tick sans dégâts, d'en guérir un : une demi-minute pour se remettre de tout. */
const MEND = 0.1;
/** Chance, par tick, de prendre un an : une journée du cycle (`DAY` = 240 s de render.ts) à 60 ticks par seconde. */
const YEAR = 1 / (240 * 60);
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
/** 1 = cellule d'air, vide ou gaz : la seule qui porte une pression. Le reste l'arrête comme un mur. */
export const OPEN = new Uint8Array(256);
for (let id = 0; id < 256; id++) if (KNOWN[id] && (KIND[id] === KINDS.empty || KIND[id] === KINDS.gas)) OPEN[id] = 1;
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

/** 1 = poudre ou liquide, hors créatures : ce qui tombe d'une case par tick, et que `hold()` peut différer. */
const FALLS = new Uint8Array(256);
for (let id = 0; id < 256; id++) if ((KIND[id] === KINDS.powder || KIND[id] === KINDS.liquid) && !CREATURE[id]) FALLS[id] = 1;

/**
 * Côté d'un bloc du damier, en cellules : deux blocs de veille. Un tick traite
 * les blocs en quatre phases — (x pair, y pair), (impair, pair), (pair,
 * impair), (impair, impair) — et deux blocs d'une même phase sont séparés
 * d'au moins un bloc entier. Une règle qui lit et écrit à moins de
 * `PART / 2` cellules de la sienne ne peut donc jamais croiser celle d'un
 * autre bloc de sa phase : c'est ce qui permet de les confier à des fils
 * différents. Les plus longues portées (regard du lapin, 8 ; aimant, 6) y
 * tiennent ; les explosions, non — elles sont différées (`blast`).
 */
const PART_SHIFT = 5;
const PART = 1 << PART_SHIFT;

/** 1 = matière qui peut demander une explosion (`blast`) : si elle n'est plus là au moment de la jouer, l'explosion n'a plus lieu. */
const EXPLOSIVE = new Uint8Array(256);
for (const id of [TNT, NITRO, C4, MINE, URANIUM]) EXPLOSIVE[id] = 1;

/** Les travaux que `run()` répartit entre les fils, exécutés par `job()`. */
export const JOB = { cells: 1, heat: 2, diffuse: 3, settle: 4, air: 5, gust: 6, hush: 7, stop: 9 } as const;
/** Cases de `control` (Int32 partagé) : génération, travail, prochain, finis, nombre, différés, héros, de la pression quelque part. */
export const CTL = { gen: 0, job: 1, next: 2, done: 3, count: 4, later: 5, hero: 6, held: 7, gust: 8 } as const;
/** Cases de `params` (Float64 partagé) : ce qu'un fil auxiliaire recopie avant chaque travail (`sync`). */
const PARAM = { parity: 0, seed: 1, gravity: 2, wind: 3, ambient: 4, emit: 5, pilot: 6, flip: 7, chosen: 8, airFlip: 9, gusty: 10 } as const;

/**
 * La mémoire d'un bac, partageable entre fils : tout ce qu'un travail lit ou
 * écrit. `SharedArrayBuffer` quand la page est isolée (en-têtes COOP/COEP),
 * `ArrayBuffer` sinon — le moteur tourne alors sur un seul fil, **au même
 * résultat** : le partage ne change que la vitesse.
 */
export interface Memory {
  width: number;
  height: number;
  buffers: Record<"cells" | "life" | "tempA" | "tempB" | "pressA" | "pressB" | "hush" | "clock" | "frozen" | "noise" | "awake" | "stir" | "later" | "held" | "waiting" | "jobs" | "control" | "params", ArrayBufferLike>;
}

/** Le constructeur de tampon à employer : partagé si la plateforme le permet (Node, page isolée). */
const Shareable: new (bytes: number) => ArrayBufferLike =
  typeof SharedArrayBuffer !== "undefined" && (globalThis as { crossOriginIsolated?: boolean }).crossOriginIsolated !== false
    ? SharedArrayBuffer
    : ArrayBuffer;

/**
 * La température de la cellule `j` d'un bloc **endormi**, telle que la
 * verrait sa voisine s'il était éveillé : tirée vers la `heat` de sa source
 * comme le fait `heatChunk()`, et arrondie pareil (32 bits). Endormi, un bloc
 * ne fait pas ce tirage : une mer de lave à l'équilibre (1153,7 °C avant le
 * tirage, 1176,9 après) montrait 23 °C d'écart à chaque frontière entre bloc
 * endormi et bloc éveillé, qui ne se calmaient jamais et se réveillaient l'un
 * l'autre — 70 % du bac restait éveillé, sans qu'une cellule ne bouge.
 */
function pulled(cells: Uint8Array, temp: Float32Array, j: number): number {
  const heat = HEAT[cells[j]];
  const t = temp[j];
  return heat === heat ? Math.fround(t + (heat - t) * 0.5) : t;
}

/** Mélange 32 bits (finale de murmur3) : une graine par bloc et par tick, tirée de celle du tick, sans suite partagée. */
function mix(h: number): number {
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return (h >>> 0) || 1;
}

/** Un pas de xorshift32 : l'état global du tirage avance d'un cran par tick, quoi que les blocs aient tiré. */
function xorshift(s: number): number {
  s ^= s << 13; s >>>= 0;
  s ^= s >>> 17;
  s ^= s << 5;
  return (s >>> 0) || 1;
}

/**
 * Offsets d'un disque de rayon `radius`, du bord vers le centre — l'ordre dans
 * lequel le souffle doit traiter ses cellules. Mis en cache : les explosions
 * n'utilisent qu'une poignée de rayons.
 *
 * Appartenance et ordre se décident sur la distance **au carré**, un entier
 * exact ; le tri est stable, les égalités gardent l'ordre du balayage. La
 * distance elle-même vient de `Math.sqrt`, correctement arrondie partout.
 * C'était `hypot()`, que la norme laisse « approchée selon
 * l'implémentation » : un bit d'écart entre Chrome et Firefox déplaçait la
 * portée d'un débris, et un salon mixte divergeait à la première explosion.
 */
const DISCS = new Map<number, [number, number, number][]>();

function disc(radius: number): [number, number, number][] {
  const known = DISCS.get(radius);
  if (known) return known;
  const cells: [number, number, number, number][] = [];
  for (let y = -radius; y <= radius; y++) {
    for (let x = -radius; x <= radius; x++) {
      const d2 = x * x + y * y;
      if (d2 <= radius * radius) cells.push([x, y, Math.sqrt(d2), d2]);
    }
  }
  cells.sort((a, b) => b[3] - a[3]);
  const out = cells.map(([x, y, d]): [number, number, number] => [x, y, d]);
  DISCS.set(radius, out);
  return out;
}

/**
 * Le gaz d'une onde de portée `reach` : la somme de `reach - d` sur tout son
 * disque, ce qu'elle dépose à l'air libre avec la pente `BLOW`. Mis en cache,
 * comme `disc()`.
 */
const GAS = new Map<number, number>();

function gas(reach: number): number {
  let sum = GAS.get(reach);
  if (sum !== undefined) return sum;
  sum = 0;
  for (const [, , d] of disc(reach)) sum += reach - d;
  GAS.set(reach, sum);
  return sum;
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
  private readonly tempA: Float32Array;
  private readonly tempB: Float32Array;
  /**
   * Pression de l'air par cellule (voir `breathe()`), réassignée à chaque sous-pas
   * comme `temp`. Nulle hors de l'air et dans tout bloc endormi, dans les deux
   * tampons : un bloc voisin peut la lire sans savoir s'il dort.
   */
  press: Float32Array;
  private pressNext: Float32Array;
  private readonly pressA: Float32Array;
  private readonly pressB: Float32Array;
  /** 1 = bloc de veille dont la pression vient d'être remise à zéro (`airChunk`) : `hushChunk` vide aussi l'autre tampon. */
  private readonly hush: Uint8Array;
  /** Y avait-il de la pression quelque part au début du tick ? Sinon les gaz ne la lisent pas. */
  private gusty = false;
  /** Parcours de l'onde d'un souffle (`wave()`) : cellules vues et file, à la taille du bac au premier souffle. Le fil du bac seul s'en sert. */
  private seen = new Uint8Array(0);
  private queue = new Int32Array(0);
  /** Tout ce que les fils partagent (voir `Memory`) : à passer à `Pool.bind()`. */
  readonly memory: Memory;
  /** Coordination des fils (`CTL`), lue et écrite par `Atomics`. */
  readonly control: Int32Array;
  /** Réglages du tick recopiés par les fils auxiliaires (`PARAM`). */
  private readonly params: Float64Array;
  /** Liste des travaux de la passe en cours : blocs du damier, ou blocs de veille pour la chaleur. */
  readonly jobs: Int32Array;
  /** Explosions différées du tick : (cellule, rayon | 256 si nucléaire), jouées par `settle()`. */
  private readonly later: Int32Array;
  /** 1 = cellule différée à ce tick par `hold()` ; remis à 0 par `release()`. */
  private readonly held: Uint8Array;
  /** Les cellules différées du tick, dans l'ordre où les fils les ont posées ; `release()` les trie. */
  private readonly waiting: Int32Array;
  /**
   * Les fils auxiliaires, quand il y en a : posé par `Pool.bind()` une fois
   * qu'ils sont prêts. Sans lui, `run()` fait tout le travail ici, au même
   * résultat.
   */
  pool: { run(engine: Engine, kind: number, count: number): void } | null = null;
  /** Blocs de veille éveillés au dernier tick : 0 = bac au repos. */
  busy = 0;
  /** Graine du tick en cours, d'où chaque bloc tire la sienne (`block()`). */
  private tickSeed = 1;
  /** Blocs du damier par rangée et par colonne (voir `PART`). */
  private readonly parts: number;
  private readonly partRows: number;
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
  /** 1 = matière qui ne chauffe pas et ne change pas d'état à l'ambiante `calmAt` (voir `flat()`). */
  private readonly calm = new Uint8Array(256);
  private calmAt = NaN;
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
  private readonly moveLife = new Uint8Array(RABBIT_SIZE);
  /** Cellules de la créature en train de bouger (`relocate`), lues par `owns()`. */
  private moving = 0;
  /** Commandes tenues par le joueur (bits de `PILOT`) : seul le héros choisi (`chosen`) y obéit. */
  pilot = 0;
  /**
   * Numéro (`HERO_SLOTS.name`) du héros piloté, 0 = aucun. Le seul qui obéit
   * à `pilot` et que suit la caméra (`hero`). Il ne change qu'entre deux
   * ticks : héros posé (`paint`, `rect`, `spawnHero`), geste `hero`
   * (`nextHero()`), ou mort du piloté — `step()` passe alors au premier héros
   * du balayage. Sans ça, `hero` était le dernier héros mis à jour : la
   * caméra sautait de l'un à l'autre au gré du balayage, et du nombre de fils.
   */
  chosen = 0;
  /** Chercher un héros à piloter au prochain tick : grille remplacée, ou piloté perdu. Évite de balayer le bac à chaque tick quand il n'y en a pas. */
  private seek = true;
  /**
   * Noms donnés à la main, par numéro de héros (`HERO_SLOTS.name`) ; sans nom
   * donné, celui de `NAMES` (gestures.ts). Posés par le geste `name`, gardés
   * avec le monde (5ᵉ bloc du codec). Le moteur ne les lit pas.
   */
  names = new Map<number, string>();

  /**
   * Un bac neuf, ou — avec `memory` — une **vue** sur la mémoire d'un autre :
   * celle d'un fil auxiliaire (pool.ts), qui ne fait que les travaux qu'on lui
   * confie (`job()`), réglages recopiés de `params` (`sync()`).
   */
  constructor(width: number, height: number, seed = (Math.random() * 0x1_0000_0000) >>> 0, memory?: Memory) {
    // Un xorshift32 meurt sur 0 : toute graine nulle devient 1.
    this.state = seed >>> 0 || 1;
    this.width = width;
    this.height = height;
    const n = width * height;
    this.cols = Math.ceil(width / CHUNK);
    this.rows = Math.ceil(height / CHUNK);
    this.parts = Math.ceil(width / PART);
    this.partRows = Math.ceil(height / PART);
    const chunks = this.cols * this.rows;
    const b = memory?.buffers ?? {
      cells: new Shareable(n), life: new Shareable(n), tempA: new Shareable(n * 4), tempB: new Shareable(n * 4),
      pressA: new Shareable(n * 4), pressB: new Shareable(n * 4), hush: new Shareable(chunks),
      clock: new Shareable(n), frozen: new Shareable(n), noise: new Shareable(n),
      awake: new Shareable(chunks), stir: new Shareable(chunks),
      later: new Shareable(Math.max(64, n >> 2) * 8), jobs: new Shareable(chunks * 4),
      // Au pire, toutes les cellules des rangées paires de blocs : la moitié du bac, plus une rangée de blocs.
      held: new Shareable(n), waiting: new Shareable(((n >> 1) + PART * width) * 4),
      control: new Shareable(9 * 4), params: new Shareable(11 * 8),
    };
    this.memory = { width, height, buffers: b };
    this.cells = new Uint8Array(b.cells);
    this.life = new Uint8Array(b.life);
    this.tempA = new Float32Array(b.tempA);
    this.tempB = new Float32Array(b.tempB);
    this.temp = this.tempA;
    this.tempNext = this.tempB;
    this.pressA = new Float32Array(b.pressA);
    this.pressB = new Float32Array(b.pressB);
    this.press = this.pressA;
    this.pressNext = this.pressB;
    this.hush = new Uint8Array(b.hush);
    this.clock = new Uint8Array(b.clock);
    this.frozen = new Uint8Array(b.frozen);
    this.noise = new Int8Array(b.noise);
    this.awake = new Uint8Array(b.awake);
    this.stir = new Uint8Array(b.stir);
    this.later = new Int32Array(b.later);
    this.held = new Uint8Array(b.held);
    this.waiting = new Int32Array(b.waiting);
    this.jobs = new Int32Array(b.jobs);
    this.control = new Int32Array(b.control);
    this.params = new Float64Array(b.params);
    this.was = new Uint8Array(chunks);
    this.shown = new Uint8Array(chunks);
    if (memory) return;
    this.temp.fill(this.ambient);
    for (let i = 0; i < n; i++) this.noise[i] = ((this.rand() * 255) | 0) - 128;
    this.stir.fill(1);
    this.hero = -1;
  }

  /** Index du cœur du héros piloté (`chosen`), -1 s'il n'y en a pas : la caméra le suit. À vérifier (`cells[hero] === HERO`), il a pu mourir depuis. Partagé : un fil auxiliaire peut l'écrire. */
  get hero(): number {
    return Atomics.load(this.control, CTL.hero);
  }

  set hero(at: number) {
    Atomics.store(this.control, CTL.hero, at);
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
    // La pression ne voyage ni avec un monde, ni avec un rejeu, ni avec un
    // salon : elle repart de zéro des deux côtés. Elle ne vit qu'une seconde.
    this.pressA.fill(0);
    this.pressB.fill(0);
    Atomics.store(this.control, CTL.gust, 0);
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
    this.busy = 0;
    for (let c = 0; c < awake.length; c++) {
      if (awake[c]) this.busy++;
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
    if (CREATURE[id]) { this.pick(this.spawn(id === HERO ? HERO_SHAPE : RABBIT_SHAPE, Math.round(cx), Math.round(cy), 1, overwrite)); return; }
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
    if (CREATURE[id]) { this.pick(this.spawn(id === HERO ? HERO_SHAPE : RABBIT_SHAPE, Math.round((x0 + x1) / 2), Math.round((y0 + y1) / 2), 1, overwrite)); return; }
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
    this.seek = true;
  }

  /** Repose un morceau, coin haut-gauche en (cx, cy). Ce qui dépasse est ignoré. */
  paste(clip: Clip, cx: number, cy: number): void {
    for (let y = 0; y < clip.height; y++) {
      for (let x = 0; x < clip.width; x++) {
        if (!this.inBounds(cx + x, cy + y)) continue;
        const to = this.index(cx + x, cy + y);
        const from = y * clip.width + x;
        this.wake(to);
        this.seek = true;
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
   * Un tick, en passes que `run()` peut répartir entre plusieurs fils :
   *
   * 1. `rouse()` : quels blocs de veille sont éveillés ;
   * 2. le damier : quatre phases de blocs `PART`×`PART` (`block()`), deux
   *    blocs d'une même phase ne se touchant jamais ;
   * 3. `release()` : les chutes différées par `hold()`, dans l'ordre des
   *    cellules ;
   * 4. `settle()` : les explosions mises de côté, une à une, dans l'ordre des
   *    cellules — elles portent trop loin pour le damier ;
   * 5. la chaleur, en trois passes par bloc de veille (`thermal()`).
   *
   * **Le résultat ne dépend pas du nombre de fils** : chaque bloc a un seul
   * fil, tire au sort depuis sa propre graine (`mix(graine du tick, bloc)`),
   * et ne touche aucun bloc de sa phase. Un hôte à huit cœurs et un invité à
   * deux restent en phase ; un navigateur sans mémoire partagée fait tout ici,
   * à l'identique. L'état global du tirage avance d'un cran par tick
   * (`xorshift`), quoi que les blocs aient tiré.
   */
  step(): void {
    this.parity ^= 1;
    this.rouse();
    if (this.seek || (this.chosen !== 0 && !this.piloted())) this.find();
    const tick = this.state;
    this.tickSeed = mix(tick);
    Atomics.store(this.control, CTL.later, 0);
    Atomics.store(this.control, CTL.held, 0);
    this.gusty = Atomics.load(this.control, CTL.gust) === 1;
    this.publish();
    for (let p = 0; p < 4; p++) {
      const count = this.phase(p & 1, p >> 1);
      if (count > 0) this.run(JOB.cells, count);
    }
    this.state = mix(tick ^ 0x27d4eb2f);
    this.release();
    this.state = mix(tick ^ 0x5bd1e995);
    this.settle();
    this.state = xorshift(tick);
    this.thermal();
    this.breathe();
    const { awake, shown } = this;
    for (let c = 0; c < awake.length; c++) if (awake[c]) shown[c] = 1;
  }

  /**
   * Recopie dans `params` ce que les fils auxiliaires doivent connaître du
   * tick : parité, graine, gravité, vent, ambiante, matière des sources,
   * commandes du héros, et lequel des deux tampons de température est courant.
   */
  private publish(): void {
    const p = this.params;
    p[PARAM.parity] = this.parity;
    p[PARAM.seed] = this.tickSeed;
    p[PARAM.gravity] = this.fall;
    p[PARAM.wind] = this.wind;
    p[PARAM.ambient] = this.air;
    p[PARAM.emit] = this.emit;
    p[PARAM.pilot] = this.pilot;
    p[PARAM.chosen] = this.chosen;
    p[PARAM.flip] = this.temp === this.tempA ? 0 : 1;
    p[PARAM.airFlip] = this.press === this.pressA ? 0 : 1;
    p[PARAM.gusty] = this.gusty ? 1 : 0;
  }

  /**
   * Fil auxiliaire : reprend les réglages publiés (`publish`) avant un
   * travail. Sans passer par les accesseurs — changer la gravité ici
   * réveillerait tout le bac, et ce n'est pas à lui de le faire.
   */
  sync(): void {
    const p = this.params;
    this.parity = p[PARAM.parity];
    this.tickSeed = p[PARAM.seed];
    this.fall = p[PARAM.gravity] as 1 | -1;
    this.wind = p[PARAM.wind];
    this.air = p[PARAM.ambient];
    this.emit = p[PARAM.emit];
    this.pilot = p[PARAM.pilot];
    this.chosen = p[PARAM.chosen];
    const flip = p[PARAM.flip] === 1;
    this.temp = flip ? this.tempB : this.tempA;
    this.tempNext = flip ? this.tempA : this.tempB;
    const airFlip = p[PARAM.airFlip] === 1;
    this.press = airFlip ? this.pressB : this.pressA;
    this.pressNext = airFlip ? this.pressA : this.pressB;
    this.gusty = p[PARAM.gusty] === 1;
  }

  /**
   * Fait les `count` premiers travaux de `jobs` : ici, ou répartis entre les
   * fils du `pool` s'il y en a — et s'il y a de quoi : une passe de moins de
   * quatre travaux ne vaut pas de réveiller qui que ce soit.
   */
  private run(kind: number, count: number): void {
    if (this.pool && count >= 4) { this.pool.run(this, kind, count); return; }
    for (let k = 0; k < count; k++) this.job(kind, this.jobs[k]);
  }

  /** Un travail : un bloc du damier, ou un bloc de veille pour l'une des trois passes de la chaleur. Appelé par `run()` et par les fils du pool. */
  job(kind: number, item: number): void {
    switch (kind) {
      case JOB.cells: this.block(item); return;
      case JOB.heat: this.heatChunk(item); return;
      case JOB.diffuse: this.diffuseChunk(item); return;
      case JOB.settle: this.settleChunk(item); return;
      case JOB.air: this.airChunk(item, false); return;
      case JOB.gust: this.airChunk(item, true); return;
      case JOB.hush: this.hushChunk(item); return;
    }
  }

  /** Range dans `jobs` les blocs de la phase (px, py) qui ont au moins un bloc de veille éveillé ; en rend le nombre. */
  private phase(px: number, py: number): number {
    const { parts, partRows, cols, rows, awake, jobs } = this;
    let count = 0;
    for (let by = py; by < partRows; by += 2) {
      for (let bx = px; bx < parts; bx += 2) {
        const cx = bx << 1, cy = by << 1;
        const right = cx + 1 < cols, below = cy + 1 < rows;
        if (awake[cy * cols + cx] || (right && awake[cy * cols + cx + 1])
          || (below && awake[(cy + 1) * cols + cx]) || (right && below && awake[(cy + 1) * cols + cx + 1])) {
          jobs[count++] = by * parts + bx;
        }
      }
    }
    return count;
  }

  /**
   * Balaie le bloc `b` du damier : dans le sens de la gravité, le sens en x
   * alternant d'un tick à l'autre, en sautant la portion de rangée d'un bloc
   * de veille endormi. Le tirage repart de la graine du bloc.
   *
   * Une cellule qui passe son tour à cause de `clock` tient son bloc éveillé
   * au tick suivant. Un bloc qui a dormi n'a plus touché à ses horloges, et
   * une cellule vide n'y touche jamais : au réveil (gravité retournée, grain
   * peint dans le vide), la moitié du temps tout le bloc passait son tour,
   * n'écrivait rien, et se rendormait — le sable restait collé au plafond.
   */
  private block(b: number): void {
    const { width: w, height: h, cells, frozen, clock, life, awake, stir, cols, parity } = this;
    const x0 = (b % this.parts) << PART_SHIFT, y0 = ((b / this.parts) | 0) << PART_SHIFT;
    const x1 = Math.min(w, x0 + PART), y1 = Math.min(h, y0 + PART);
    this.state = mix(this.tickSeed ^ Math.imul(b + 1, 0x9e3779b1));
    const leftToRight = parity === 0;
    const down = this.fall === 1;
    for (let k = y0; k < y1; k++) {
      const y = down ? y1 - 1 - (k - y0) : k;
      const row = (y >> SHIFT) * cols;
      for (let j = x0; j < x1; j++) {
        const x = leftToRight ? j : x1 - 1 - (j - x0);
        const c = row + (x >> SHIFT);
        if (!awake[c]) {
          j = leftToRight ? x | (CHUNK - 1) : x1 - 1 - (x & ~(CHUNK - 1)) + x0;
          continue;
        }
        const i = y * w + x;
        const id = cells[i];
        if (id === EMPTY) continue;
        if (frozen[i]) continue; // figée : aucune règle ne s'applique
        if (clock[i] === parity || ACTIVE[id] || (id === METAL && life[i] > 0)) stir[c] = 1;
        if (clock[i] === parity) continue;
        clock[i] = parity;
        if (FALLS[id] && this.hold(i, x, y)) continue;
        this.update(i, x, y, id);
      }
    }
  }

  /**
   * Diffère une cellule qui tombe sur une matière en chute d'un bloc pas
   * encore balayé : elle sera jouée par `release()`, une fois tout le damier
   * passé. Les rangées de blocs paires passent avant les impaires ; à une
   * frontière sur deux (y = 32, 96…), le bloc du haut passe donc avant celui
   * du bas. Sans ça, le grain du bas du bloc voyait la case d'en dessous encore
   * pleine — son voisin n'avait pas encore bougé —, glissait en diagonale ou
   * restait sur place, puis le voisin descendait : un trou par tick. Une
   * colonne versée au pinceau tombait en une rangée sur deux, avec des traits
   * sur les côtés.
   *
   * La matière d'en dessous ne compte que si elle tombe vraiment : une colonne
   * de poudre ou de liquide pas encore jouée, avec du vide ou du gaz à moins de
   * 15 cellules (au-delà, un fil d'une autre phase peut y écrire). Un tas ou un
   * lac au repos ne diffère rien. Et une cellule posée sur une cellule
   * différée l'est aussi : elle ne peut tomber qu'après elle.
   */
  private hold(i: number, x: number, y: number): boolean {
    const { fall, width: w, cells, clock, frozen, parity } = this;
    const below = y + fall;
    if (below < 0 || below >= this.height) return false;
    const j = i + fall * w;
    if (!this.held[j]) {
      if ((y >> PART_SHIFT) & 1 || below >> PART_SHIFT === y >> PART_SHIFT) return false;
      if (!FALLS[cells[j]] || clock[j] === parity || frozen[j]) return false;
      for (let k = 1; ; k++) {
        const yy = below + k * fall;
        if (k === 15 || yy < 0 || yy >= this.height) return false;
        const c = yy * w + x, kind = KIND[cells[c]];
        if (kind === KINDS.empty || kind === KINDS.gas) break;
        if (!FALLS[cells[c]] || clock[c] === parity || frozen[c]) return false;
      }
    }
    this.held[i] = 1;
    this.waiting[Atomics.add(this.control, CTL.held, 1)] = i;
    return true;
  }

  /**
   * Joue les cellules différées par `hold()`, seul et dans l'ordre du
   * balayage (celles du bas d'abord) : ce qui ne dépend ni du nombre de fils
   * ni de l'ordre où ils les ont posées.
   *
   * ponytail: une cellule différée qu'une règle voisine a échangée entre-temps
   * (un liquide plus dense qui passe dessous) est jouée à sa nouvelle place
   * par ce qui l'a remplacée, qui a déjà bougé à ce tick : un pas de trop,
   * rare. Suivre `held` dans `swap()` le jour où ça se voit.
   */
  private release(): void {
    const count = Atomics.load(this.control, CTL.held);
    if (count === 0) return;
    const { width: w, height: h, held, cells, frozen } = this;
    const down = this.fall === 1, leftToRight = this.parity === 0;
    const order = this.waiting.subarray(0, count);
    for (let k = 0; k < count; k++) {
      const at = order[k], x = at % w, y = (at / w) | 0;
      order[k] = (down ? h - 1 - y : y) * w + (leftToRight ? x : w - 1 - x);
    }
    order.sort();
    for (let k = 0; k < count; k++) {
      const ry = (order[k] / w) | 0, rx = order[k] - ry * w;
      const x = leftToRight ? rx : w - 1 - rx, y = down ? h - 1 - ry : ry, i = y * w + x;
      held[i] = 0;
      if (cells[i] !== EMPTY && !frozen[i]) this.update(i, x, y, cells[i]);
    }
  }

  /**
   * Met une explosion de côté : elle porte jusqu'à `r × 2,5` cellules, bien
   * au-delà de ce que le damier garantit (`PART`). Elle sera jouée par
   * `settle()` à la fin de la phase, dans l'ordre des cellules — le même
   * quel que soit le fil qui l'a demandée. `nuke` : avec les retombées.
   */
  private blast(x: number, y: number, r: number, nuke = false): void {
    const k = Atomics.add(this.control, CTL.later, 1);
    if (2 * k + 1 >= this.later.length) return;
    this.later[2 * k] = y * this.width + x;
    this.later[2 * k + 1] = r | (nuke ? 256 : 0);
  }

  /**
   * Joue les explosions mises de côté pendant le damier, dans l'ordre du
   * balayage — sens de la gravité, x alterné —, puis par rayon : un ordre qui
   * ne dépend ni des fils ni de leur vitesse. Trié par simple numéro de
   * cellule, le tas d'uranium sautait par le haut et projetait ses grains
   * dans le sol ; par le bas, comme avant, il souffle vers le vide.
   * Une charge que l'explosion d'une voisine a déjà emportée ne saute plus —
   * sans ça, les trente-six cellules d'un tas d'uranium arrivées ensemble à
   * l'emballement sautaient chacune, et chaque souffle relançait l'uranium
   * projeté par le précédent au lieu de l'avoir emporté.
   *
   * ponytail: au-delà de `later` (un quart de la grille), les explosions en
   * trop sont perdues, et lesquelles dépend des fils. Il faudrait un quart du
   * bac qui saute au même tick.
   */
  private settle(): void {
    const count = Math.min(Atomics.load(this.control, CTL.later), this.later.length >> 1);
    if (count === 0) return;
    const { width: w, height: h } = this;
    const down = this.fall === 1, leftToRight = this.parity === 0;
    const order = new Float64Array(count);
    for (let k = 0; k < count; k++) {
      const at = this.later[2 * k], x = at % w, y = (at / w) | 0;
      const rank = (down ? h - 1 - y : y) * w + (leftToRight ? x : w - 1 - x);
      order[k] = rank * 512 + this.later[2 * k + 1];
    }
    order.sort();
    for (let k = 0; k < count; k++) {
      const rank = Math.floor(order[k] / 512), code = order[k] - rank * 512;
      const ry = Math.floor(rank / w), rx = rank - ry * w;
      const y = down ? h - 1 - ry : ry, x = leftToRight ? rx : w - 1 - rx;
      const at = y * w + x;
      if (!EXPLOSIVE[this.cells[at]]) continue;
      if (code & 256) this.nuke(x, y);
      else this.explode(x, y, code);
    }
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
      case GLASS: if (this.gusty) this.shatter(i, x, y); return;
    }
    switch (KIND[id]) {
      case KINDS.powder: this.updatePowder(i, x, y, id); return;
      case KINDS.liquid: this.updateLiquid(i, x, y, id); return;
      case KINDS.gas: this.updateGas(i, x, y, id); return;
      default: return; // statique
    }
  }

  private updatePowder(i: number, x: number, y: number, id: MaterialId): void {
    if (this.gusty && this.swept(i, x, y, id)) return;
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
    if (this.gusty && this.blown(i, x, y, id)) return;
    const up = y - this.gravity;
    const dir = this.drift();
    if (this.rand() < 0.7 && this.tryMove(i, x, up, id)) return;
    if (this.tryMove(i, x + dir, up, id)) return;
    this.tryMove(i, x + dir, y, id);
  }

  /**
   * Le vent : un gaz est poussé de la haute pression vers la basse, d'une
   * cellule, avec une chance qui croît avec le gradient. Une voisine qui
   * n'est pas de l'air (ou le bord) compte pour la pression de la cellule
   * elle-même : on ne pousse pas contre un mur. Sans pression autour, rien
   * n'est lu ni tiré : les gaz montent comme avant, aux mêmes tirages.
   */
  private blown(i: number, x: number, y: number, id: MaterialId): boolean {
    const { press: p, cells, width: w } = this;
    const v = p[i];
    const up = y > 0 && OPEN[cells[i - w]] ? p[i - w] : v;
    const down = y < this.height - 1 && OPEN[cells[i + w]] ? p[i + w] : v;
    const left = x > 0 && OPEN[cells[i - 1]] ? p[i - 1] : v;
    const right = x < w - 1 && OPEN[cells[i + 1]] ? p[i + 1] : v;
    const gx = left - right, gy = up - down;
    const g2 = gx * gx + gy * gy;
    if (g2 < GUST_MIN * GUST_MIN) return false;
    if (this.rand() >= Math.sqrt(g2) * GUST) return false;
    // En biais si les deux composantes se valent, sinon droit dans le sens de la plus forte.
    const ax = Math.abs(gx), ay = Math.abs(gy);
    const dx = 2 * ax >= ay ? Math.sign(gx) : 0;
    const dy = 2 * ay >= ax ? Math.sign(gy) : 0;
    return this.tryMove(i, x + dx, y + dy, id);
  }

  /**
   * Une poudre soufflée : comme `blown()`, mais la poudre n'est pas de l'air
   * et n'a pas de pression à elle. Chaque côté vaut la plus forte pression
   * de l'air parmi ses trois cellules, diagonales comprises : un grain au
   * sommet d'un tas n'a d'air qu'au-dessus de lui, et c'est le vent qui file
   * au ras du tas qui l'emporte. Un côté sans air prend la valeur d'en face
   * (aucune poussée sur cet axe) : le sol ne pousse pas. Poussé de côté mais
   * bloqué, le grain est soulevé en biais. Plus elle est légère, plus elle
   * part (`DENSITY`) : la neige avant le sable, l'uranium à peine.
   */
  private swept(i: number, x: number, y: number, id: MaterialId): boolean {
    const left = this.side(x - 1, y - 1, 0, 1), right = this.side(x + 1, y - 1, 0, 1);
    const up = this.side(x - 1, y - 1, 1, 0), down = this.side(x - 1, y + 1, 1, 0);
    const gx = (left < 0 ? right : left) - (right < 0 ? left : right);
    const gy = (up < 0 ? down : up) - (down < 0 ? up : down);
    const g2 = gx * gx + gy * gy;
    if (!(g2 >= SWEEP_MIN * SWEEP_MIN)) return false; // `!` : deux côtés sans air donnent -1 - -1 = 0
    if (this.rand() >= Math.sqrt(g2) * GUST * 2 / DENSITY[id]) return false;
    const ax = Math.abs(gx), ay = Math.abs(gy);
    const dx = 2 * ax >= ay ? Math.sign(gx) : 0;
    const dy = 2 * ay >= ax ? Math.sign(gy) : 0;
    if (this.tryMove(i, x + dx, y + dy, id)) return true;
    return dx !== 0 && dy === 0 && this.tryMove(i, x + dx, y - this.gravity, id);
  }

  /**
   * La plus forte pression de l'air parmi trois cellules, depuis (x, y) par
   * pas de (sx, sy) ; -1 si aucune n'est de l'air (la pression, elle, n'est
   * jamais négative).
   */
  private side(x: number, y: number, sx: number, sy: number): number {
    const { press: p, cells, width: w } = this;
    let most = -1;
    for (let k = 0; k < 3; k++, x += sx, y += sy) {
      if (!this.inBounds(x, y)) continue;
      const j = y * w + x;
      if (OPEN[cells[j]] && p[j] > most) most = p[j];
    }
    return most;
  }

  /**
   * Le verre éclate sous la pression de l'air qui le touche : il devient du
   * sable — du verre broyé, qui refond en verre à la chaleur et que l'onde
   * emporte ensuite (`swept`). Ne lit rien tant que le tick a commencé sans
   * pression (`gusty`) : une verrière coûte ce qu'elle coûtait.
   */
  private shatter(i: number, x: number, y: number): void {
    const { press: p, cells, width: w } = this;
    let most = 0;
    if (y > 0 && OPEN[cells[i - w]]) most = Math.max(most, p[i - w]);
    if (y < this.height - 1 && OPEN[cells[i + w]]) most = Math.max(most, p[i + w]);
    if (x > 0 && OPEN[cells[i - 1]]) most = Math.max(most, p[i - 1]);
    if (x < w - 1 && OPEN[cells[i + 1]]) most = Math.max(most, p[i + 1]);
    if (most <= SHATTER) return;
    if (this.rand() < (most - SHATTER) / SHATTER) this.become(x, y, SAND);
  }

  /**
   * Ajoute de la pression dans la cellule `i`, si c'est de l'air. Seule porte
   * d'entrée de la pression : elle réveille le bloc (sinon il dort avec une
   * pression que ses voisins lisent) et signale qu'il y en a (`CTL.gust`),
   * sans quoi `breathe()` saute tout le calcul.
   */
  private puff(i: number, amount: number): void {
    if (!OPEN[this.cells[i]]) return;
    this.press[i] = Math.min(MAX_P, this.press[i] + amount);
    this.wake(i);
    Atomics.store(this.control, CTL.gust, 1);
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
   *
   * `ignite()` seulement si une voisine brûle : sans combustible il ne fait
   * rien et ne tire rien, mais relisait quatre voisines pour chaque cellule
   * d'un lac de lave — la règle pesait 40 % du tick d'un lac qui coule.
   */
  private updateLava(i: number, x: number, y: number): void {
    let busy = false;
    for (let k = 0; k < 4; k++) {
      const nx = x + NX[k], ny = y + NY[k];
      const n = this.get(nx, ny);
      if (n === WATER || n === SALTWATER) {
        this.become(nx, ny, STEAM);
        this.become(x, y, STONE);
        // L'eau qui se vaporise d'un coup : une bouffée qui chasse la vapeur.
        if (this.inBounds(nx, ny)) this.puff(this.index(nx, ny), STEAM_PUFF);
        return;
      }
      if (n === SAND || FLAMMABLE[n] > 0) busy = true;
      if (n === SAND && this.rand() < 0.01) this.become(nx, ny, LAVA);
    }
    if (busy) {
      this.wake(i);
      this.ignite(x, y, 2);
    }
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
      if (n === FIRE || n === LAVA) { this.blast(x, y, 7); return; }
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
      if (n === FIRE || n === LAVA) { this.blast(x, y, 5); return; }
    }
    const down = y + this.gravity;
    if (this.tryMove(i, x, down, NITRO)) {
      const j = this.index(x, down);
      if (this.life[j] < SHOCK) this.life[j]++;
      return;
    }
    if (this.life[i] >= SHOCK) { this.blast(x, y, 5); return; }
    this.life[i] = 0; // elle s'est arrêtée : le compteur repart de zéro
    this.updateLiquid(i, x, y, NITRO);
  }

  /**
   * C4 : le feu ne lui fait rien, seule l'étincelle le déclenche. `life` = 1
   * marque une charge amorcée par la détonation d'une voisine, pour qu'un mur
   * parte en entier sans dépendre des flammes.
   */
  private updateC4(i: number, x: number, y: number): void {
    if (this.life[i] === 1) { this.blast(x, y, 9); return; }
    for (let k = 0; k < 4; k++) {
      const nx = x + NX[k], ny = y + NY[k];
      if (this.get(nx, ny) === SPARK) { this.blast(x, y, 9); return; }
    }
  }

  /** Mine : seul ce qui coule appuie dessus, on peut donc la murer sans la faire sauter. */
  private updateMine(x: number, y: number): void {
    const above = y - this.gravity;
    if (!this.inBounds(x, above)) return;
    const kind = MATERIALS[this.cells[this.index(x, above)]].kind;
    if (kind === "powder" || kind === "liquid") this.blast(x, y, 6);
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
      if (++this.life[i] >= MELTDOWN) { this.blast(x, y, NUKE, true); return; }
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
    // Puis l'onde. Après le disque, pas pendant : l'air n'y est connu qu'une
    // fois tout projeté.
    this.wave(cx, cy, radius);
  }

  /**
   * L'onde d'un souffle : un volume de gaz fixe (`gas()`), réparti dans l'air
   * que le cratère atteint **par l'air**, à `REACH` rayons au plus — plus
   * fort au centre (`BLOW` par cellule jusqu'au bord de l'onde). À l'air
   * libre, il remplit tout le disque ; dans une pièce close, le même gaz
   * n'a que la pièce : la pression y monte d'autant (jusqu'à `CONFINED`
   * fois), et le verre qui la ferme éclate plus loin. Et l'onde ne passe
   * plus à travers les murs : posée sur tout le disque, elle soufflait la
   * fumée de l'autre côté d'une cloison.
   *
   * Parcours en largeur depuis l'air du cratère, sur `wave` (hors damier :
   * joué par `settle()`, seul, la portée le dépasse). Il contourne les coins :
   * c'est un gaz, pas une lumière.
   */
  private wave(cx: number, cy: number, radius: number): void {
    const { width: w, cells } = this;
    const reach = radius * REACH, r2 = reach * reach;
    const n = cells.length;
    if (this.seen.length !== n) { this.seen = new Uint8Array(n); this.queue = new Int32Array(n); }
    const { seen, queue } = this;
    let head = 0, tail = 0;
    const [x0, x1, y0, y1] = this.disc(cx, cy, radius);
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const i = y * w + x, dx = x - cx, dy = y - cy;
        if (dx * dx + dy * dy > radius * radius || !OPEN[cells[i]] || seen[i]) continue;
        seen[i] = 1;
        queue[tail++] = i;
      }
    }
    let sum = 0;
    while (head < tail) {
      const i = queue[head++];
      const x = i % w, y = (i / w) | 0, dx = x - cx, dy = y - cy;
      sum += reach - Math.sqrt(dx * dx + dy * dy);
      for (let k = 0; k < 4; k++) {
        const nx = x + NX[k], ny = y + NY[k];
        if (!this.inBounds(nx, ny)) continue;
        const j = ny * w + nx, ex = nx - cx, ey = ny - cy;
        if (seen[j] || ex * ex + ey * ey > r2 || !OPEN[cells[j]]) continue;
        seen[j] = 1;
        queue[tail++] = j;
      }
    }
    if (sum <= 0) { for (let k = 0; k < tail; k++) seen[queue[k]] = 0; return; }
    const scale = BLOW * Math.min(CONFINED, gas(reach) / sum);
    for (let k = 0; k < tail; k++) {
      const i = queue[k], dx = (i % w) - cx, dy = ((i / w) | 0) - cy;
      seen[i] = 0;
      this.puff(i, scale * (reach - Math.sqrt(dx * dx + dy * dy)));
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
      if (n === TNT) this.blast(nx, ny, 7);
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
   * Une source endormie ne fait pas son tirage : lue au bord d'un bloc
   * éveillé, elle passe par `pulled()`, qui le lui applique. Voir `pulled()`
   * pour la mer de lave qui ne s'endormait jamais.
   */
  private thermal(): void {
    const { awake, stir, jobs } = this;
    let count = 0;
    for (let c = 0; c < awake.length; c++) {
      awake[c] |= stir[c];
      if (awake[c]) jobs[count++] = c;
    }
    this.publish();
    this.run(JOB.heat, count);
    this.run(JOB.diffuse, count);
    this.run(JOB.settle, count);
    const temp = this.temp;
    this.temp = this.tempNext;
    this.tempNext = temp;
  }

  /**
   * Passe 1 de la chaleur : les sources du bloc `c` tirent leur cellule vers
   * leur température. Toutes doivent l'avoir fait avant que la diffusion ne
   * lise les voisines — d'où une passe à part, et une barrière entre les deux.
   */
  private heatChunk(c: number): void {
    const { width: w, cells, temp } = this;
    const x0 = (c % this.cols) << SHIFT, y0 = ((c / this.cols) | 0) << SHIFT;
    const x1 = Math.min(w, x0 + CHUNK), y1 = Math.min(this.height, y0 + CHUNK);
    for (let y = y0; y < y1; y++) {
      for (let i = y * w + x0, end = y * w + x1; i < end; i++) {
        const heat = HEAT[cells[i]];
        // Une source tire vers sa température sans l'imposer : une flamme peut
        // encore faire fondre la glace qu'elle touche. (NaN = ne chauffe pas.)
        if (heat === heat) temp[i] += (heat - temp[i]) * 0.5;
      }
    }
  }

  /** Passe 2 : diffusion du bloc `c` vers l'autre tampon, changements d'état, et le bloc dit s'il est refroidi (`awake[c] = 2`). */
  private diffuseChunk(c: number): void {
    const { width: w, height: h, cells, temp, tempNext, ambient, awake, stir } = this;
    const x0 = (c % this.cols) << SHIFT, y0 = ((c / this.cols) | 0) << SHIFT;
    const x1 = Math.min(w, x0 + CHUNK), y1 = Math.min(h, y0 + CHUNK);
    const cols = this.cols;
    const upAsleep = y0 > 0 && awake[c - cols] === 0, downAsleep = y1 < h && awake[c + cols] === 0;
    const leftAsleep = x0 > 0 && awake[c - 1] === 0, rightAsleep = x1 < w && awake[c + 1] === 0;
    if (this.flat(x0, y0, x1, y1)) {
      for (let y = y0; y < y1; y++) tempNext.fill(ambient + 0, y * w + x0, y * w + x1);
      awake[c] = 2;
      return;
    }
    let still = true;
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const i = y * w + x;
        const t = temp[i];
        const sum =
          (y > 0 ? (y === y0 && upAsleep ? pulled(cells, temp, i - w) : temp[i - w]) : t) +
          (y < h - 1 ? (y === y1 - 1 && downAsleep ? pulled(cells, temp, i + w) : temp[i + w]) : t) +
          (x > 0 ? (x === x0 && leftAsleep ? pulled(cells, temp, i - 1) : temp[i - 1]) : t) +
          (x < w - 1 ? (x === x1 - 1 && rightAsleep ? pulled(cells, temp, i + 1) : temp[i + 1]) : t);
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

  /**
   * Le bloc (x0, y0)–(x1, y1) et sa bordure sont-ils tous à l'ambiante exacte,
   * sans source ni matière que l'ambiante ferait changer d'état ? La diffusion
   * y rendrait alors `t` au bit près : `sum - 4t` vaut 0 exactement (un f32
   * fois 3 ou 4 tient dans un f64), `ambient - t` aussi. Dans le chantier de
   * `npm run bench` en 1920×1080, 3238 des 3254 blocs éveillés le sont : l'eau
   * et le sable qui bougent réveillent leurs blocs sans rien y chauffer, et la
   * diffusion faisait un cinquième du tick pour recopier des 20 °C.
   *
   * La bordure est lue sans distinguer éveillée ou endormie (`pulled()`) :
   * une source y est refusée d'office, c'est plus strict et plus simple.
   * `ambient + 0` écrit +0 là où l'ambiante vaut -0, comme le calcul complet.
   */
  private flat(x0: number, y0: number, x1: number, y1: number): boolean {
    const { width: w, height: h, cells, temp, calm } = this;
    const ambient = this.air;
    if (this.calmAt !== ambient) {
      for (let id = 0; id < 256; id++) {
        const heat = HEAT[id];
        calm[id] = heat !== heat && !(ambient > BOIL_AT[id]) && !(ambient < FREEZE_AT[id]) ? 1 : 0;
      }
      this.calmAt = ambient;
    }
    const ya = Math.max(0, y0 - 1), yb = Math.min(h, y1 + 1);
    const xa = Math.max(0, x0 - 1), xb = Math.min(w, x1 + 1);
    for (let y = ya; y < yb; y++) {
      for (let i = y * w + xa, end = y * w + xb; i < end; i++) {
        if (temp[i] !== ambient || calm[cells[i]] === 0) return false;
      }
    }
    return true;
  }

  /** Passe 3 : un bloc refroidi recopie sa nouvelle température dans l'autre tampon, pour lire la même chose endormi. */
  private settleChunk(c: number): void {
    if (this.awake[c] !== 2) return;
    const { width: w, temp, tempNext } = this;
    const x0 = (c % this.cols) << SHIFT, y0 = ((c / this.cols) | 0) << SHIFT;
    const x1 = Math.min(w, x0 + CHUNK), y1 = Math.min(this.height, y0 + CHUNK);
    for (let y = y0; y < y1; y++) {
      for (let i = y * w + x0, end = y * w + x1; i < end; i++) temp[i] = tempNext[i];
    }
  }

  /**
   * La pression de l'air, après la chaleur : `AIR_STEPS` sous-pas de
   * diffusion entre cellules d'air sur les blocs éveillés, chacun une passe
   * répartie entre les fils (lecture de `press`, écriture de `pressNext`,
   * échange). Au dernier, un bloc dont toute la pression est sous `CALM_P`
   * la remet à zéro (`hush`) et peut s'endormir ; les autres se tiennent
   * éveillés. Le gradient qui en sort pousse les gaz (`blown`).
   *
   * Tant que rien n'a soufflé (`CTL.gust` à 0), la passe est sautée : un bac
   * sans explosion ne paie rien. Un bloc endormi a une pression nulle dans
   * les deux tampons — il ne s'endort qu'une fois remis à zéro, et `puff()`
   * le réveille —, ses voisins peuvent donc le lire sans `pulled()`.
   *
   * ponytail: une diffusion amortie, pas un vrai fluide (ni vitesse ni
   * inertie) : l'onde s'étale au lieu de voyager, et ce qui sort d'un bloc
   * éveillé vers un bloc endormi est perdu pour le tick. À revoir si l'on veut
   * des ventilateurs ou des courants d'air qui durent.
   */
  private breathe(): void {
    if (Atomics.load(this.control, CTL.gust) === 0) return;
    Atomics.store(this.control, CTL.gust, 0);
    const { awake, jobs } = this;
    let count = 0;
    for (let c = 0; c < awake.length; c++) if (awake[c]) jobs[count++] = c;
    for (let s = 0; s < AIR_STEPS; s++) {
      this.publish();
      this.run(s === AIR_STEPS - 1 ? JOB.gust : JOB.air, count);
      const press = this.press;
      this.press = this.pressNext;
      this.pressNext = press;
    }
    this.publish();
    this.run(JOB.hush, count);
  }

  /**
   * Un sous-pas de pression sur le bloc `c`. Une cellule qui n'est pas de
   * l'air vaut 0 ; une voisine qui n'en est pas (ou le bord) compte pour la
   * cellule elle-même : rien ne passe à travers un mur. `last` : le bloc
   * décide s'il se calme. Calcul en 64 bits rangé en 32, comme la chaleur :
   * le même au bit près partout, et dans le port Rust (rust/src/lib.rs).
   */
  private airChunk(c: number, last: boolean): void {
    const { width: w, height: h, cells, press: p, pressNext: q } = this;
    const x0 = (c % this.cols) << SHIFT, y0 = ((c / this.cols) | 0) << SHIFT;
    const x1 = Math.min(w, x0 + CHUNK), y1 = Math.min(h, y0 + CHUNK);
    if (this.hushed(x0, y0, x1, y1)) {
      if (last) this.hush[c] = 1;
      for (let y = y0; y < y1; y++) q.fill(0, y * w + x0, y * w + x1);
      return;
    }
    let loud = false;
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const i = y * w + x;
        if (!OPEN[cells[i]]) { q[i] = 0; continue; }
        const v = p[i];
        const up = y > 0 && OPEN[cells[i - w]] ? p[i - w] : v;
        const down = y < h - 1 && OPEN[cells[i + w]] ? p[i + w] : v;
        const left = x > 0 && OPEN[cells[i - 1]] ? p[i - 1] : v;
        const right = x < w - 1 && OPEN[cells[i + 1]] ? p[i + 1] : v;
        const next = (v + FLOW * (up + down + left + right - 4 * v)) * DAMP;
        q[i] = next;
        if (next >= CALM_P) loud = true;
      }
    }
    if (!last) return;
    if (loud) {
      this.hush[c] = 0;
      this.stir[c] = 1;
      Atomics.store(this.control, CTL.gust, 1);
      return;
    }
    this.hush[c] = 1;
    for (let y = y0; y < y1; y++) q.fill(0, y * w + x0, y * w + x1);
  }

  /**
   * Le bloc et sa bordure sont-ils sans pression ? Le sous-pas y rendrait 0
   * partout, au bit près (la pression n'est jamais négative, pas de -0) : on
   * saute le calcul. C'est presque tout bloc éveillé par du sable ou de l'eau
   * qui bouge loin d'un souffle ; sans ce raccourci, une salve dans le
   * chantier en 1920×1080 coûtait 42 ms de pression par tick.
   */
  private hushed(x0: number, y0: number, x1: number, y1: number): boolean {
    const { width: w, height: h, press: p } = this;
    const ya = Math.max(0, y0 - 1), yb = Math.min(h, y1 + 1);
    const xa = Math.max(0, x0 - 1), xb = Math.min(w, x1 + 1);
    for (let y = ya; y < yb; y++) {
      for (let i = y * w + xa, end = y * w + xb; i < end; i++) if (p[i] !== 0) return false;
    }
    return true;
  }

  /** Dernière passe : un bloc calmé vide aussi l'autre tampon, pour dormir à zéro dans les deux. */
  private hushChunk(c: number): void {
    if (!this.hush[c]) return;
    const { width: w, pressNext: q } = this;
    const x0 = (c % this.cols) << SHIFT, y0 = ((c / this.cols) | 0) << SHIFT;
    const x1 = Math.min(w, x0 + CHUNK), y1 = Math.min(this.height, y0 + CHUNK);
    for (let y = y0; y < y1; y++) q.fill(0, y * w + x0, y * w + x1);
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

  /** Pose un héros entier (voir `spawn`), qui devient le piloté. Public : un monde généré en pose un. */
  spawnHero(x: number, y: number): number {
    const heart = this.spawn(HERO_SHAPE, x, y, 1);
    this.pick(heart);
    return heart;
  }

  /**
   * Pilote le héros de cœur `heart` (rien si ce n'est pas un héros, ou -1).
   * Entre deux ticks seulement : `chosen` est lu par tous les fils. Un héros
   * sans numéro (tout juste posé, grille sans état vivant) en reçoit un tiré
   * de sa place, pas de `rand()` : bâtir un monde ne doit rien prendre au
   * tirage du bac.
   */
  private pick(heart: number): void {
    if (heart < 0 || this.cells[heart] !== HERO) return;
    const x = heart % this.width, y = (heart / this.width) | 0, [dx, dy] = HERO_SLOTS.name;
    if (!this.inBounds(x + dx, y + dy)) return;
    const head = this.index(x + dx, y + dy);
    if (this.life[head] === 0) this.life[head] = 1 + (heart % 250);
    this.chosen = this.life[head];
    this.hero = heart;
  }

  /**
   * Retrouve le héros piloté par son numéro — `hero`, un index, ne voyage ni
   * avec un rejeu ni avec un salon —, sinon passe au premier du balayage.
   * Deux balayages du bac au plus : appelé quand la grille a changé
   * (`seek`) ou que le piloté a disparu, pas à chaque tick.
   */
  private find(): void {
    this.seek = false;
    const [dx, dy] = HERO_SLOTS.name, w = this.width;
    for (let i = 0; i < this.cells.length && this.chosen !== 0; i++) {
      if (this.cells[i] !== HERO || !this.inBounds(i % w + dx, ((i / w) | 0) + dy)) continue;
      if (this.life[i + dy * w + dx] === this.chosen) { this.hero = i; return; }
    }
    this.chosen = 0;
    this.hero = -1;
    this.nextHero();
  }

  /** Le héros piloté est-il toujours là où on l'a vu (`hero`), avec son numéro ? */
  private piloted(): boolean {
    const at = this.hero;
    if (at < 0 || this.cells[at] !== HERO) return false;
    const x = at % this.width, y = (at / this.width) | 0, [dx, dy] = HERO_SLOTS.name;
    return this.inBounds(x + dx, y + dy) && this.life[this.index(x + dx, y + dy)] === this.chosen;
  }

  /**
   * Passe au héros suivant dans l'ordre de la grille (rangée par rangée), en
   * repartant du début après le dernier ; reste sur le même s'il est seul.
   * Geste `hero` (touche C), et `step()` quand le piloté a disparu. Balaye
   * le bac : jamais dans un tick.
   */
  nextHero(): void {
    const n = this.cells.length, from = this.hero;
    for (let k = 1; k <= n; k++) {
      const i = (from + k + n) % n;
      if (this.cells[i] !== HERO) continue;
      this.pick(i);
      if (this.cells[i] === HERO && this.hero === i) return;
    }
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
    return this.index(x, y);
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
   * Chaque case emporte son `life` : le héros garde sa fiche dans son corps
   * (`HERO_SLOTS`), le lapin n'y a que des zéros.
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
    for (let k = 0; k < size; k++) { this.wake(from[k]); this.wake(to[k]); }
    for (let k = 0; k < size; k++) { this.moveLife[k] = life[from[k]]; cells[from[k]] = EMPTY; life[from[k]] = 0; }
    for (let k = 0; k < size; k++) {
      const j = to[k];
      cells[j] = id[k];
      life[j] = this.moveLife[k];
      this.clock[j] = this.parity; // il a bougé ce tick, ses cellules aussi
    }
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
   * Il pose (R) la matière de `pilot >> 8` : une marche devant ses pieds, qu'il
   * gravit en avançant, ou, saut tenu, sous lui — de quoi monter en pilier.
   * À chaque tick et avant le pas, pas au hasard comme creuser : sinon il
   * marche plus vite qu'il ne pose et tombe de son propre escalier.
   *
   * Dans un liquide il coule lentement (`SINK`), et saut tenu il remonte : il
   * nage. Chaleur, froid et apnée ne le tuent pas net : ils lui font des
   * dégâts (`SCALD`, `CHOKE`), dont il guérit au calme (`MEND`) ; il meurt à
   * `HERO_HARM`. Sa fiche (numéro, dégâts, âge, compteurs) vit dans le `life`
   * de son corps (`HERO_SLOTS`), que `relocate()` emporte : le cœur n'a plus
   * de place, et une règle ne garde rien hors des cellules (plusieurs fils).
   * Seul le héros piloté (`chosen`) obéit aux touches et tient `hero` (la
   * caméra) ; les autres attendent, debout, mais vivent : chute, dégâts, âge.
   */
  private updateHero(i: number, x: number, y: number): void {
    const H = HERO_SHAPE;
    const whole = this.intact(H, x, y, 1);
    if (whole === 1) {
      if (this.spawn(H, x, y, 1) < 0) this.become(x, y, EMPTY);
      return;
    }
    if (whole < H.id.length) { this.maim(H, x, y, 1); return; }
    const { life } = this, S = HERO_SLOTS;
    const t = this.temp[i];
    const head = KIND[this.get(x, y - 3)] === KINDS.liquid;
    const hurt = (t > COOK || t < FROST ? SCALD : 0) + (head ? CHOKE : 0);
    let harm = life[this.slot(x, y, S.harm)];
    if (hurt > 0) harm += hurt;
    else if (harm > 0 && this.rand() < MEND) harm--;
    if (harm >= HERO_HARM) { this.kill(H, x, y, 1, t > COOK ? FIRE : t < FROST ? ICE : EMPTY); return; }
    const name = life[this.slot(x, y, S.name)] || 1 + Math.floor(this.rand() * 250);
    let age = life[this.slot(x, y, S.age)];
    if (age < 250 && this.rand() < YEAR) age++;
    let dug = life[this.slot(x, y, S.dug)], laid = life[this.slot(x, y, S.laid)];

    const p = name === this.chosen ? this.pilot : 0, g = this.gravity;
    const dir = (p & PILOT.right ? 1 : 0) - (p & PILOT.left ? 1 : 0);
    let face = this.life[i] & FACING_LEFT ? -1 : 1;
    if (dir !== 0) face = dir;
    let jump = this.life[i] & 15;
    if (p & PILOT.dig && this.rand() < DIG) dug += this.dig(x + 2 * face, y - 2, y + 1);
    if (p & PILOT.down && this.rand() < DIG) dug += this.dig(x - 1, y + 2, y + 2) + this.dig(x, y + 2, y + 2) + this.dig(x + 1, y + 2, y + 2);
    if (p & PILOT.place) {
      const id = p >> 8;
      if (p & PILOT.up) laid += this.lay(x - 1, y + 2, id) + this.lay(x, y + 2, id) + this.lay(x + 1, y + 2, id);
      else laid += this.lay(x + 2 * face, y + 1, id);
    }

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
    life[at] = (face < 0 ? FACING_LEFT : 0) | jump;
    life[this.slot(cx, cy, S.name)] = name;
    life[this.slot(cx, cy, S.harm)] = harm;
    life[this.slot(cx, cy, S.age)] = age;
    life[this.slot(cx, cy, S.dug)] = Math.min(250, dug);
    life[this.slot(cx, cy, S.laid)] = Math.min(250, laid);
    if (name === this.chosen) this.hero = at;
  }

  /** La cellule du corps du héros de cœur (x, y) qui garde une donnée de `HERO_SLOTS`. Corps entier : dans la grille. */
  private slot(x: number, y: number, s: readonly [number, number]): number {
    return this.index(x + s[0], y + s[1]);
  }

  /**
   * Le héros creuse la colonne `x`, de `y0` à `y1` : tout ce qui est solide —
   * statique ou poudre — part, sauf le métal et les créatures. `become` : une
   * cellule figée tient bon. Rend le nombre de cellules arrachées (sa fiche).
   */
  private dig(x: number, y0: number, y1: number): number {
    let n = 0;
    for (let y = y0; y <= y1; y++) {
      const id = this.get(x, y);
      const kind = KIND[id];
      if ((kind === KINDS.static || kind === KINDS.powder) && id !== METAL && !CREATURE[id] && this.inBounds(x, y) && !this.frozen[this.index(x, y)]) {
        this.become(x, y, EMPTY);
        n++;
      }
    }
    return n;
  }

  /**
   * Le héros pose `id` en (x, y) si la place est libre (vide ou gaz) : il ne
   * remplace rien, et `id` = 0 (matière refusée par `applyGesture`) ne pose rien.
   * Rend 1 s'il a posé (sa fiche), 0 sinon.
   */
  private lay(x: number, y: number, id: MaterialId): number {
    const kind = KIND[this.get(x, y)];
    if (id === EMPTY || !(kind === KINDS.empty || kind === KINDS.gas) || this.frozen[this.index(x, y)]) return 0;
    this.become(x, y, id);
    return 1;
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
