import { MATERIALS, SHORTCUTS } from "./sim/materials.ts";
import { ACTION_NAMES, KEY_GROUPS, combo, forget, keyLabel, keymap, parseBindings, read, rebind, write, type Action, type Bindings } from "./ui.ts";

// Le pense-bête vit dans l'onglet Raccourcis des paramètres : le clavier se
// remplit depuis `bindings` (`listBindings()`) — une touche changée ne laisse
// pas une aide qui ment.
const settingsEl = document.querySelector<HTMLDialogElement>("#settings")!;
const settingsTabs = settingsEl.querySelectorAll<HTMLButtonElement>("[data-tab]");

/** Ouvre les paramètres (si fermés) sur la section `tab`, id d'une <section>. */
export function openSettings(tab: string): void {
  for (const button of settingsTabs) {
    button.setAttribute("aria-pressed", String(button.dataset.tab === tab));
    document.getElementById(button.dataset.tab!)!.hidden = button.dataset.tab !== tab;
  }
  if (!settingsEl.open) settingsEl.showModal();
}

for (const button of settingsTabs) button.addEventListener("click", () => openSettings(button.dataset.tab!));
document.querySelector<HTMLButtonElement>("#settings-open")!.addEventListener("click", () => openSettings("settings-general"));

/** Touches choisies par le joueur (fenêtre des raccourcis), gardées d'une visite à l'autre. */
const KEYS = "sandbox-rabbit:touches";
let bindings = parseBindings(read(KEYS));
/** De la touche à l'action, refait à chaque changement de `bindings`. */
let bound = keymap(bindings);

/** Les raccourcis courants restent lisibles après une réassignation. */
export const keyState = {
  get bindings() { return bindings; },
  get bound() { return bound; },
};

/**
 * Touches de direction, de creusage ou de pose tenues, avec l'action qu'elles
 * portaient à l'appui : relâchée avec ou sans Ctrl, la touche se retrouve.
 */
export const held = new Map<string, Action>();

const bindingsEl = document.querySelector<HTMLDivElement>("#bindings")!;
const keysMenuEl = document.querySelector<HTMLElement>("#keys-menu")!;
/** L'action qui attend sa nouvelle touche, ou null. */
let waiting: Action | null = null;
/** L'encadré ouvert dans la fenêtre des raccourcis (index dans `KEY_GROUPS`). */
let shownGroup = 0;

/**
 * Remplit la fenêtre des raccourcis : un menu d'onglets, un par encadré de
 * `KEY_GROUPS`, et les encadrés — tous posés, un seul visible, pour qu'ils
 * aient la taille du plus grand et que la fenêtre ne saute pas d'un onglet à
 * l'autre. Un bouton par action, qu'on clique puis
 * qui prend la combinaison suivante (Ctrl, Alt, Maj n'attendent que leur
 * touche), puis les gestes de souris. Échap annule ; une touche déjà prise par
 * une autre action s'échange avec elle, une touche réservée (Tab, Entrée, Maj
 * seule…) est refusée.
 */
function listBindings(): void {
  keysMenuEl.replaceChildren(...KEY_GROUPS.map((group, n) => {
    const tab = document.createElement("button");
    tab.type = "button";
    tab.textContent = group.name;
    tab.setAttribute("aria-pressed", String(n === shownGroup));
    tab.addEventListener("click", () => { shownGroup = n; waiting = null; listBindings(); });
    return tab;
  }));
  bindingsEl.replaceChildren(...KEY_GROUPS.map((group, n) => {
    const section = document.createElement("section");
    section.classList.toggle("shown", n === shownGroup);
    const title = document.createElement("h3");
    title.textContent = group.name;
    const list = document.createElement("dl");
    list.className = "keys";
    for (const action of group.actions) {
      const dt = document.createElement("dt");
      const button = document.createElement("button");
      button.type = "button";
      button.dataset.action = action;
      button.textContent = waiting === action ? "Touche ?" : keyLabel(bindings[action]);
      button.addEventListener("click", () => { waiting = action; listBindings(); });
      dt.append(button);
      const dd = document.createElement("dd");
      dd.textContent = action.startsWith("mat") ? `Matière : ${MATERIALS[SHORTCUTS[Number(action.slice(3)) - 1]].name}` : ACTION_NAMES[action];
      list.append(dt, dd);
    }
    for (const [gesture, effect] of group.mouse) {
      const dt = document.createElement("dt");
      dt.textContent = gesture;
      const dd = document.createElement("dd");
      dd.textContent = effect;
      list.append(dt, dd);
    }
    section.append(title, list);
    return section;
  }));
}

/** Retient de nouvelles touches (null : celles d'origine) et les applique tout de suite. */
function setBindings(next: Bindings | null): void {
  bindings = next ?? parseBindings(null);
  bound = keymap(bindings);
  held.clear();
  if (next) write(KEYS, JSON.stringify(next)); else forget(KEYS);
  waiting = null;
  listBindings();
}

addEventListener("keydown", (e) => {
  if (!waiting || ["Shift", "Control", "Alt", "Meta"].includes(e.key)) return;
  e.preventDefault();
  e.stopImmediatePropagation();
  if (e.key === "Escape") { waiting = null; listBindings(); return; }
  const next = rebind(bindings, waiting, combo(e));
  if (next) setBindings(next);
  else bindingsEl.querySelector<HTMLButtonElement>(`[data-action="${waiting}"]`)!.textContent = "Pas celle-ci — une autre ?";
}, true);

document.querySelector<HTMLButtonElement>("#bindings-reset")!.addEventListener("click", () => setBindings(null));
settingsEl.addEventListener("close", () => { waiting = null; listBindings(); });
listBindings();
