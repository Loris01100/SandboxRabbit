/**
 * Auto-vérification des « Règles à ne pas enfreindre » d'AGENTS.md :
 * `npm run check`.
 *
 * Ces règles-là n'ont pas de test de comportement, et ne peuvent pas en
 * avoir : les enfreindre ne casse rien ici, ça casse un salon entre Chrome et
 * Firefox, un monde déjà déposé dans la galerie, ou la page d'un joueur qui
 * bloque les cookies — jamais sous le V8 de la CI. On lit donc la source,
 * comme le fait déjà sim.ts pour les fonctions `Math` approchées.
 *
 * Y a sa place une règle qui se vérifie en lisant un fichier et dont
 * l'infraction serait silencieuse. Le comportement du moteur, du panneau et
 * de l'API reste à sim.ts, ui.ts et api.ts.
 */
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { CATEGORIES, MATERIALS, PALETTE } from "../src/client/sim/materials.ts";
// L'espace de noms entier : la table gelée ci-dessous désigne les constantes par leur nom.
import * as registre from "../src/client/sim/materials.ts";

const racine = new URL("../", import.meta.url);
const lire = (fichier: string): string => readFileSync(new URL(fichier, racine), "utf8");

/**
 * La source sans ses commentaires. Sans ça, le commentaire d'`engine.rand()`
 * (« un `Math.random()` de plus dans ce fichier rouvrirait le trou ») se
 * compterait comme une infraction, et interdire une tournure obligerait à ne
 * plus l'écrire même pour l'expliquer.
 *
 * ponytail: découpe à la main, sans analyse syntaxique — un `//` dans une
 * chaîne (une URL) couperait la fin de sa ligne, et l'infraction qui s'y
 * cacherait passerait. Aucun fichier lu ici n'en contient.
 */
const code = (fichier: string): string =>
  lire(fichier).replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

/** Les `.ts` d'un dossier du dépôt, pour qu'un module neuf tombe sous la règle sans qu'on y pense. */
const modules = (dossier: string): string[] =>
  readdirSync(new URL(dossier, racine))
    .filter((f) => f.endsWith(".ts"))
    .map((f) => `${dossier}${f}`);

const CLIENT = [...modules("src/client/"), ...modules("src/client/sim/")];

/* ------------------------------------------------------- tirage reproductible */

/**
 * Tout ce qui tourne dans la simulation doit être rejouable : un salon en
 * lockstep rejoue les mêmes ticks chez l'hôte et chez l'invité, un rejeu
 * rejoue les mêmes gestes, une graine redonne le même monde. `Math.random()`
 * n'est reproductible nulle part — d'où `engine.rand()` (xorshift32 semé) et
 * le tirage propre à terrain.ts, semé par la graine.
 *
 * main.ts en garde deux, légitimes : choisir une graine et un décor au hasard
 * **avant** que quoi que ce soit ne tourne. Il n'est donc pas dans la liste.
 */
const SIM = [...modules("src/client/sim/"), "src/client/terrain.ts", "src/client/gestures.ts",
  "src/client/replay.ts", "src/client/challenges.ts", "src/client/sight.ts"];

for (const fichier of SIM) {
  const tirages = code(fichier).split("\n").filter((l) => l.includes("Math.random"));
  // La seule exception : la graine par défaut d'un moteur neuf, sur la ligne
  // du constructeur — elle est remplacée par celle du salon ou du monde chargé.
  const permis = fichier.endsWith("sim/engine.ts") ? tirages.filter((l) => l.includes("constructor(")) : [];
  assert.deepEqual(tirages, permis, `${fichier} : tout tirage passe par engine.rand(), jamais Math.random()`);
}

/* ------------------------------------------------------------ ids de matière */

/**
 * Les ids de matière sont le format des mondes déjà enregistrés : codec.ts
 * écrit l'octet tel quel, et il dort dans la galerie, dans un lien de partage
 * et dans le `localStorage` des joueurs. En renuméroter un relit toutes ces
 * grilles avec les mauvaises matières — un bac de pierre qui revient en bois.
 *
 * La table est donc gelée. Ajouter une matière = ajouter sa ligne ici (le
 * test le réclame) ; en déplacer une, jamais.
 */
const IDS: Record<string, number> = {
  EMPTY: 0, SAND: 1, WATER: 2, STONE: 3, WOOD: 4, FIRE: 5, SMOKE: 6, STEAM: 7, OIL: 8, ACID: 9,
  PLANT: 10, LAVA: 11, ICE: 12, GUNPOWDER: 13, SALT: 14, SALTWATER: 15, TNT: 16, SEED: 17,
  NANITE: 18, SOURCE: 19, GLASS: 20, MERCURY: 21, WAX: 22, MOLTEN_WAX: 23, CANDLE: 24, SNOW: 25,
  MUD: 26, EMBER: 27, METAL: 28, SPARK: 29, TAR: 30, ALCOHOL: 31, MOLTEN_GLASS: 32, BATTERY: 33,
  SWITCH: 34, NITROGEN: 35, NITRO: 36, C4: 37, FIREDAMP: 38, MINE: 39, THERMITE: 40, PETROLEUM: 41,
  URANIUM: 42, FALLOUT: 43, CEMENT: 44, FILINGS: 45, MAGNET: 46, RABBIT: 47, RABBIT_BODY: 48,
  RABBIT_EYE: 49, RABBIT_TAIL: 50, HERO: 51, HERO_HEAD: 52, HERO_BODY: 53, HERO_LEGS: 54,
};

for (const [nom, id] of Object.entries(IDS)) {
  assert.equal(registre[nom as keyof typeof registre], id, `${nom} doit garder l'id ${id} : les mondes déjà enregistrés le portent`);
}
{
  const gelés = new Set(Object.values(IDS));
  for (const id of Object.keys(MATERIALS).map(Number)) {
    assert.ok(gelés.has(id), `la matière ${id} (${MATERIALS[id].name}) manque à la table gelée de ce test`);
  }
}

/* -------------------------------------------------------------------- la page */

/**
 * La CSP servie par le Worker refuse l'attribut `style=` et le `<script>` en
 * ligne. Le navigateur ne les exécute pas et ne prévient que dans la console :
 * la page part sans son câblage, ou sans sa mise en forme, sans erreur visible.
 */
{
  const html = lire("index.html");
  assert.equal(html.match(/\sstyle=/g), null, "index.html : pas d'attribut style=, la CSP le bloque (passer par une classe ou le CSSOM)");
  for (const balise of html.match(/<script\b[^>]*>/g) ?? []) {
    assert.match(balise, /\ssrc=/, `index.html : ${balise} sans src — la CSP bloque le script en ligne`);
  }
}

/**
 * Le fil principal ne touche pas au moteur : il parle au Web Worker par
 * `order()` / `listen()` / `askLoad()` / `askClip()` de world.ts. Un `Engine`
 * importé côté page finit par y être instancié, et deux simulations tournent
 * côte à côte sans se savoir.
 *
 * Les modules purs (gestures, replay, challenges, terrain) en gardent le
 * **type** : ils reçoivent le moteur du Worker en argument, ils ne le créent
 * pas. Ils ne sont donc pas dans la liste.
 */
const PAGE = ["main", "world", "screen", "room", "share", "theme", "view", "keys", "palette", "settings", "hero", "ui", "errors"];
for (const nom of PAGE) {
  assert.ok(!code(`src/client/${nom}.ts`).includes("sim/engine.ts"),
    `${nom}.ts ne doit pas importer l'Engine : world.ts est la seule porte vers la simulation`);
}

/** Un seul fil de simulation, créé par world.ts (sim/worker.ts se relance lui-même en fils auxiliaires). */
for (const nom of PAGE) {
  if (nom === "world") continue;
  assert.ok(!code(`src/client/${nom}.ts`).includes("new Worker("),
    `${nom}.ts ne doit pas créer de Worker : world.ts tient le seul fil de simulation`);
}

/**
 * Les modules périphériques ne doivent pas importer main.ts : le cycle
 * laisserait l'un des deux à moitié chargé (ses exports encore à
 * `undefined`). main.ts leur passe ce qu'il faut par un `init…()` à rappels.
 */
for (const nom of ["room", "share", "theme", "view", "keys", "palette", "settings", "hero"]) {
  assert.ok(!/from "\.\/main/.test(code(`src/client/${nom}.ts`)),
    `${nom}.ts ne doit pas importer main.ts (cycle) : passer par un rappel d'init…()`);
}

/**
 * `localStorage` **jette** quand le site n'a pas droit au stockage (cookies
 * bloqués, navigation privée stricte). Au chargement d'un module, l'exception
 * laisse la page blanche : tout passe donc par `read` / `write` / `forget` de
 * ui.ts, qui la rattrapent.
 */
for (const fichier of CLIENT) {
  if (fichier.endsWith("/ui.ts")) continue;
  assert.ok(!code(fichier).includes("localStorage"),
    `${fichier} : accès à localStorage uniquement par read/write/forget de ui.ts (nu, il jette et la page reste blanche)`);
}

/* ------------------------------------------------------------------- le Worker */

const WORKER = modules("src/worker/");

/**
 * Le jeton de suppression est tout ce qui distingue le déposant d'un
 * visiteur, la galerie n'ayant pas de comptes. Un `SELECT *` le ferait sortir
 * par une route de lecture, et n'importe qui pourrait effacer n'importe quel
 * monde : les requêtes nomment donc leurs colonnes.
 */
for (const fichier of WORKER) {
  assert.doesNotMatch(code(fichier), /SELECT\s+\*/i,
    `${fichier} : pas de SELECT * — le token de suppression ne sort d'aucune lecture`);
}

/** app.ts doit se charger sous Node (test/api.ts tape l'API sans wrangler) : rien de `cloudflare:workers`. */
assert.ok(!code("src/worker/app.ts").includes("cloudflare:workers"),
  "src/worker/app.ts : aucun import de cloudflare:workers, sinon test/api.ts ne peut plus le charger");

/* ---------------------------------------------------------------- le README */

/**
 * Le README annonce les matières au joueur. La liste s'était décalée d'une
 * matière (quarante-huit annoncées, la gomme absente de la liste, et
 * « quarante-sept tabulations » quand la palette en compte quarante-neuf
 * boutons) : personne ne relit une énumération de cinquante noms. On la
 * compare donc à la palette.
 */
{
  const readme = lire("README.md");
  const outils = CATEGORIES.find((c) => c.name === "Outils")!.ids.length;

  const annoncé = readme.match(/^(\d+) matières/m);
  assert.equal(annoncé?.[1], String(PALETTE.length - outils), `le README annonce ${PALETTE.length - outils} matières (la palette hors outils)`);

  const tabulations = readme.match(/sinon (\d+) tabulations/);
  assert.equal(tabulations?.[1], String(PALETTE.length), `sans les flèches, la palette fait ${PALETTE.length} tabulations (un bouton par entrée)`);

  // La liste en prose, entre les deux seuls accents graves du passage.
  const listé = readme.split("outils) : `")[1].split("`")[0].split("/").map((n) => n.trim().toLowerCase());
  const palette = PALETTE.map((id) => MATERIALS[id].name.toLowerCase());
  assert.deepEqual([...listé].sort(), [...palette].sort(), "le README liste exactement les entrées de la palette");
}

console.log("ok — règles d'architecture conformes");
