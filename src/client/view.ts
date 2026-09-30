import { held } from "./keys.ts";
import { clampPan, panAfterZoom, type Action } from "./ui.ts";
import { HEIGHT, WIDTH, canvas, onResize } from "./world.ts";

/**
 * La vue du bac : zoom et décalage, posés en transformation CSS sur le canvas.
 * Ce qui traduit cellules et pixels d'écran (clic, sélection, cadre du héros)
 * passe par `cellBox()` de world.ts, qui en tient compte — bordure grossie
 * par le zoom comprise.
 */
export let zoom = 1;
let panX = 0;
let panY = 0;

/**
 * Pose la transformation du canvas, décalage ramené dans ses bornes
 * (`clampPan`) : quel que soit le geste — molette, glisser, pincement,
 * clavier — le bac agrandi recouvre son cadre. `offsetWidth` est la taille
 * du canvas avant transformation, le cadre lui-même.
 */
function applyView(): void {
  panX = clampPan(panX, canvas.offsetWidth, zoom);
  panY = clampPan(panY, canvas.offsetHeight, zoom);
  canvas.style.transformOrigin = "0 0";
  canvas.style.transform = zoom === 1 ? "" : `translate(${panX}px, ${panY}px) scale(${zoom})`;
}

/** Zoome autour d'un point de l'écran, qui ne bouge pas (math dans ui.ts). Le niveau est borné de 1 à 12. */
export function zoomAt(clientX: number, clientY: number, next: number): void {
  next = Math.min(12, Math.max(1, next));
  const r = canvas.getBoundingClientRect();
  panX = panAfterZoom(clientX, r.left, r.width, panX, zoom, next);
  panY = panAfterZoom(clientY, r.top, r.height, panY, zoom, next);
  zoom = next;
  if (zoom === 1) { panX = 0; panY = 0; }
  applyView();
}

/** Zoome autour du centre du cadre : touches + et -, arrivée du héros. */
export function zoomCentered(next: number): void {
  const r = canvas.getBoundingClientRect();
  zoomAt(r.left + r.width / 2, r.top + r.height / 2, next);
}

/**
 * Décale la vue de `dx`, `dy` pixels d'écran : clic du milieu, deux doigts.
 * `translate` précède `scale`, donc un pixel de souris vaut un pixel d'écran,
 * quel que soit le zoom.
 */
export function panBy(dx: number, dy: number): void {
  panX += dx;
  panY += dy;
  applyView();
}

/** Actions de caméra, en sens de déplacement de la vue. */
export const MOVES: Partial<Record<Action, [number, number]>> = { up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0] };

/**
 * Fait glisser la vue selon les touches tenues : un quatre-vingt-dixième du
 * cadre par image, soit un cadre et demi par seconde, quel que soit le zoom.
 */
export function scroll(): void {
  let dx = 0, dy = 0;
  for (const action of held.values()) { const m = MOVES[action] ?? [0, 0]; dx += m[0]; dy += m[1]; }
  const step = canvas.offsetWidth / 90;
  panBy(-Math.sign(dx) * step, -Math.sign(dy) * step);
}

/**
 * Rapproche la vue du héros d'un cinquième du chemin par image : elle le suit
 * sans sauter d'une cellule à chaque pas, et `applyView` la garde dans ses
 * bornes près des bords du monde.
 */
export function follow([x, y]: [number, number]): void {
  if (zoom === 1) return;
  const w = canvas.offsetWidth, h = canvas.offsetHeight;
  panX += (w / 2 - ((x + 0.5) / WIDTH) * w * zoom - panX) * 0.2;
  panY += (h / 2 - ((y + 0.5) / HEIGHT) * h * zoom - panY) * 0.2;
  applyView();
}

// Le zoom se coupe : sans lui la molette rend la main à la page, et un bac
// laissé agrandi ne piège personne — on le remet d'aplomb en décochant.
export const zoomInput = document.querySelector<HTMLInputElement>("#zoom")!;
zoomInput.addEventListener("change", () => {
  if (!zoomInput.checked) zoomAt(0, 0, 1);
});

canvas.addEventListener("wheel", (e) => {
  if (!zoomInput.checked) return; // pas de preventDefault : la page défile
  e.preventDefault();
  zoomAt(e.clientX, e.clientY, zoom * (e.deltaY < 0 ? 1.2 : 1 / 1.2));
}, { passive: false });

canvas.addEventListener("auxclick", (e) => e.preventDefault());

// Redimensionner remet la vue d'aplomb. Les crans d'annulation et
// l'enregistrement en cours, eux, sont vidés par le bac lui-même.
onResize.push(() => zoomAt(0, 0, 1));
