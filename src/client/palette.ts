import { CATEGORIES, EMPTY, MATERIALS, SAND, SOURCE, WATER, type MaterialId } from "./sim/materials.ts";
import { pushRecent } from "./ui.ts";
import { set } from "./world.ts";

/** Matière du pinceau. Ne change que par `select()`. */
export let current: MaterialId = SAND;
/** Matière qu'une source crachera : le moteur la garde aussi, le panneau la relit. */
export let emit: MaterialId = WATER;

export const paletteEl = document.querySelector<HTMLDivElement>("#palette")!;
const hintEl = document.querySelector<HTMLParagraphElement>("#hint")!;

// Une famille = un <details> repliable (natif) contenant sa grille de boutons.
for (const [n, cat] of CATEGORIES.entries()) {
  const box = document.createElement("details");
  box.className = "cat";
  // Même accordéon exclusif que les groupes : une famille ouverte à la fois,
  // sinon la palette fait à elle seule la hauteur de deux écrans.
  box.setAttribute("name", "famille");
  box.open = n === 0; // seule la première famille est déployée au départ
  const title = document.createElement("summary");
  title.textContent = cat.name;
  const grid = document.createElement("div");
  grid.className = "palette";
  for (const id of cat.ids) grid.append(swatch(id));
  box.append(title, grid);
  paletteEl.append(box);
}

function swatch(id: MaterialId): HTMLButtonElement {
  const m = MATERIALS[id];
  const button = document.createElement("button");
  button.type = "button";
  button.dataset.id = String(id);
  button.setAttribute("aria-pressed", String(id === current));
  // Pastille montée en CSSOM plutôt qu'en `style="…"` : un attribut de style
  // inline tomberait sous la CSP servie par le Worker.
  const dot = document.createElement("span");
  dot.className = "swatch";
  dot.style.background = `rgb(${m.color.join(",")})`;
  button.append(dot, m.name);
  button.addEventListener("click", () => select(id));
  button.addEventListener("pointerenter", () => (hintEl.textContent = m.hint));
  return button;
}
paletteEl.addEventListener("pointerleave", () => (hintEl.textContent = MATERIALS[current].hint));

// Les six dernières matières choisies, épinglées au-dessus des familles :
// depuis que la palette est un accordéon exclusif, y revenir coûtait deux clics.
const recentEl = document.querySelector<HTMLDivElement>("#recent")!;
let recent: MaterialId[] = [];

function keepRecent(id: MaterialId): void {
  // La liste est reconstruite : si le focus était dedans, il partait au body à
  // chaque choix fait au clavier. La matière élue passe en tête, c'est donc le
  // premier bouton qui le reprend.
  const focused = recentEl.contains(document.activeElement);
  recent = pushRecent(recent, id, 6);
  recentEl.replaceChildren(...recent.map(swatch));
  if (focused) recentEl.querySelector("button")?.focus();
}

// Clavier : les flèches parcourent une grille de matières. Sans ça il faut
// quarante-sept tabulations pour traverser la palette.
for (const grid of [paletteEl, recentEl]) {
  grid.addEventListener("keydown", (e) => {
    const step = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: 2, ArrowUp: -2 }[e.key];
    if (step === undefined) return;
    const box = (e.target as HTMLElement).closest(".palette");
    if (!box) return;
    const buttons = [...box.querySelectorAll("button")];
    const next = buttons[buttons.indexOf(e.target as HTMLButtonElement) + step];
    if (!next) return;
    next.focus();
    e.preventDefault();
  });
}

export function select(id: MaterialId): void {
  // La pipette sur l'œil d'un lapin choisit le lapin, pas un œil à peindre.
  id = MATERIALS[id].part ?? id;
  current = id;
  keepRecent(id);
  // Une source crache la dernière matière choisie avant elle.
  if (id !== SOURCE && id !== EMPTY) { emit = id; set({ emit: id }); }
  hintEl.textContent = MATERIALS[id].hint;
  for (const b of paletteEl.querySelectorAll("button")) {
    b.setAttribute("aria-pressed", String(Number(b.dataset.id) === id));
  }
}
select(current);
