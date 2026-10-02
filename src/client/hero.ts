import { HERO_HARM, HERO_SLOTS, MATERIALS, PILOT, type MaterialId } from "./sim/materials.ts";
import { current } from "./palette.ts";
import { bindings, held } from "./keys.ts";
import { keyLabel, type Action } from "./ui.ts";
import { scaleTo, zoom, zoomCentered, zoomInput } from "./view.ts";
import { WIDTH, cellBox, onResize, seen } from "./world.ts";
import { look } from "./sight.ts";

const statusEl = document.querySelector<HTMLParagraphElement>("#status")!;

/** Position du héros dans la dernière frame, en cellules ; null sans héros. Avec lui, les touches le pilotent et la caméra le suit. */
export let hero: [number, number] | null = null;
/**
 * Caméra décrochée du héros : elle reste où on l'a mise, le héros vit sa vie
 * hors champ. Glisser au clic du milieu la décroche (sans ça, la vue revient
 * sur lui à l'image suivante et on ne peut rien regarder d'autre) ; un clic du
 * milieu sans bouger la raccroche.
 */
export let loose = false;
/** Commandes envoyées en dernier (bits de `PILOT`) : un geste ne part que quand elles changent. */
let piloted = 0;

/** Actions du héros : celles de la caméra, plus creuser devant lui et poser. */
export const STEER: Partial<Record<Action, number>> = {
  left: PILOT.left, right: PILOT.right, up: PILOT.up, down: PILOT.down, dig: PILOT.dig, place: PILOT.place,
};

/**
 * Commandes tirées des touches tenues, ou null si elles n'ont pas changé.
 * main.ts les envoie par `gesture()` : c'est un geste comme un coup de
 * pinceau, que le rejeu enregistre et qu'un invité de salon relaie à l'hôte.
 */
export function pilot(): number | null {
  let keys = 0;
  if (hero) for (const action of held.values()) keys |= STEER[action] ?? 0;
  if (keys & PILOT.place) keys |= current << 8;
  if (keys === piloted) return null;
  piloted = keys;
  return keys;
}

/** Décroche la caméra du héros, s'il y en a un et qu'elle ne l'était pas ; dit si elle vient de l'être. */
export function loosen(): boolean {
  if (!hero || loose) return false;
  loose = true;
  return true;
}

/** Raccroche la caméra au héros, s'il y en a un et qu'elle était décrochée ; dit si elle vient de l'être. */
export function tighten(): boolean {
  if (!hero || !loose) return false;
  loose = false;
  return true;
}

/**
 * Pixels d'écran par cellule voulus à l'arrivée du héros (mode exploration),
 * 0 pour la vue habituelle. Oublié quand le bac change de taille ou de monde
 * (`closeUp(0)` dans `abandon()` de main.ts) : sinon un héros posé plus tard
 * dans un bac ordinaire arrivait en gros plan.
 */
let close = 0;
export function closeUp(px: number): void { close = px; }
onResize.push(() => { close = 0; });

/** Le héros vient d'apparaître : la vue s'approche (environ 160 cellules de large, ou `close` pixels par cellule) et la barre de statut donne les touches. */
function meet(): void {
  loose = false;
  if (zoomInput.checked && close) scaleTo(close);
  else if (zoomInput.checked && zoom < WIDTH / 160) zoomCentered(WIDTH / 160);
  const k = (a: Action) => keyLabel(bindings[a]);
  statusEl.textContent = `Héros : ${k("left")}/${k("right")} pour marcher, ${k("up")} pour sauter (et nager), ${k("down")} pour creuser dessous, ${k("dig")} devant, ${k("place")} pour poser la matière choisie (${k("up")}+${k("place")} : sous lui). ${k("nextHero")} passe au héros suivant, ${k("view")} change de vue. Le métal résiste. Touches à changer : ?`;
}

const noneEl = document.querySelector<HTMLParagraphElement>("#hero-none")!;
const cardEl = document.querySelector<HTMLDivElement>("#hero-card")!;
/** Le nom du héros suivi : main.ts envoie le geste `name` quand il change. */
export const nameInput = document.querySelector<HTMLInputElement>("#hero-name")!;
const hpEl = document.querySelector<HTMLMeterElement>("#hero-hp")!;
const hpValueEl = document.querySelector<HTMLOutputElement>("#hero-hp-value")!;
const factsEl = document.querySelector<HTMLParagraphElement>("#hero-facts")!;
/** Numéro du héros suivi (`HERO_SLOTS.name`), 0 sans héros : c'est lui que vise le geste `name`. */
export let heroId = 0;

/**
 * Remplit la fiche du héros suivi : son nom vient de la frame (les noms
 * donnés vivent dans le bac), le reste de son corps dans le miroir
 * (`HERO_SLOTS`), sac compris. Le champ du nom n'est pas réécrit pendant
 * qu'on y tape.
 */
function card(name: string): void {
  const grid = seen();
  noneEl.hidden = !!hero;
  cardEl.hidden = !hero;
  if (!hero || !grid) { heroId = 0; return; }
  const [x, y] = hero, w = grid.width;
  const at = (s: readonly [number, number]) => grid.life[(y + s[1]) * w + x + s[0]] ?? 0;
  heroId = at(HERO_SLOTS.name);
  if (document.activeElement !== nameInput && nameInput.value !== name) nameInput.value = name;
  const hp = Math.ceil((100 * Math.max(0, HERO_HARM - at(HERO_SLOTS.harm))) / HERO_HARM);
  hpEl.value = hp;
  hpValueEl.value = String(hp);
  const most = (n: number) => (n >= 250 ? "250+" : String(n));
  const load = at(HERO_SLOTS.load), bag = MATERIALS[at(HERO_SLOTS.bag) as MaterialId];
  const carried = bag && at(HERO_SLOTS.bag) !== 0 && load > 0 ? `sac : ${load} × ${bag.name.toLowerCase()}` : "sac vide";
  const facts = `${18 + at(HERO_SLOTS.age)} ans · ${Math.round(grid.temp[y * w + x])} °C · ${most(at(HERO_SLOTS.dug))} cellules creusées · ${carried}`;
  if (factsEl.textContent !== facts) factsEl.textContent = facts;
}

/**
 * Relève le héros apporté par une frame (position, nom) : l'accueille s'il
 * vient d'apparaître, annonce sa mort s'il vient de disparaître, tient sa
 * fiche à jour. Rend vrai quand il vient de mourir : ses commandes tenues
 * sont à relâcher (`pilot()`).
 */
export function track(next: [number, number, string] | null): boolean {
  const was = hero;
  hero = next && [next[0], next[1]];
  card(next?.[2] ?? "");
  if (hero && !was) meet();
  if (hero || !was) return false;
  statusEl.textContent = "Le héros n'a pas survécu. Un autre : Vivant → Héros, ou un nouveau monde.";
  return true;
}

/** Les vues que V fait défiler : de côté, de côté avec l'encadré de ce que voit le héros, à la première personne. */
const VIEWS = ["side", "inset", "eyes"] as const;
const VIEW_NAMES = ["de côté", "de côté, avec ce que voit le héros", "à la première personne"];
let view = 0;
const sightEl = document.querySelector<HTMLCanvasElement>("#sight")!;
const sightCtx = sightEl.getContext("2d")!;
const sightImg = sightCtx.createImageData(1, sightEl.height);

/** Passe à la vue suivante et la nomme dans la barre de statut. */
export function nextView(): void {
  view = (view + 1) % VIEWS.length;
  sightEl.dataset.view = VIEWS[view];
  statusEl.textContent = `Vue ${VIEW_NAMES[view]}${hero ? "" : " — elle attend un héros (Vivant → Héros)"}. ${keyLabel(bindings.view)} pour changer.`;
}

const haloEl = document.querySelector<HTMLDivElement>("#halo")!;

/**
 * Cerne le héros piloté (`engine.chosen`) dans les deux vues de côté : seul
 * lui obéit, et c'est lui que suivent la caméra et la fiche — rien ne disait
 * lequel. Un repère posé sur la scène, pas une couleur du
 * rendu : sinon il faudrait le peindre dans le shader et dans `Renderer`.
 * Recalculé à chaque image, zoom et caméra compris.
 */
function mark(): void {
  haloEl.hidden = !hero || view === 2;
  if (haloEl.hidden || !hero) return;
  const c = cellBox(), stage = haloEl.parentElement!.getBoundingClientRect();
  const [x, y] = hero;
  haloEl.style.transform = `translate(${c.left - stage.left + (x - 1) * c.sx}px, ${c.top - stage.top + (y - 2) * c.sy}px)`;
  haloEl.style.width = `${3 * c.sx}px`;
  haloEl.style.height = `${4 * c.sy}px`;
}

/**
 * Redessine ce que voit le héros, s'il y en a un et que la vue le montre. Son
 * sens se lit dans le `life` de son cœur (bit 7 = tourné vers la gauche, voir
 * engine.ts) : le miroir le porte déjà, la frame n'a rien à ajouter.
 */
export function gaze(): void {
  mark();
  const grid = seen();
  if (!hero || !grid || view === 0) { sightEl.hidden = true; return; }
  sightEl.hidden = false;
  const [x, y] = hero;
  const face = grid.life[y * grid.width + x] & 128 ? -1 : 1;
  look(grid.cells, grid.width, grid.height, x, y, face, sightImg.data);
  sightCtx.putImageData(sightImg, 0, 0);
}
