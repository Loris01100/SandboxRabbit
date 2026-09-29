/**
 * La logique du panneau qui ne touche ni au DOM ni au moteur — donc la seule
 * partie du client que Node peut vérifier (test/ui.ts). Tout ce qui est ici
 * était noyé dans main.ts, où rien n'est testable.
 */
import { MATERIALS, type MaterialId } from "./sim/materials.ts";

/**
 * Stockage local toléré. `localStorage` **jette** quand le site n'a pas droit
 * aux cookies (réglage strict, page embarquée) : au premier `getItem` du
 * chargement, c'est toute la page qui reste blanche. Ici on perd le réglage,
 * rien d'autre. L'écriture jette aussi quand le quota est plein.
 */
export function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function write(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* pas de place, ou pas le droit : tant pis pour la mémoire */
  }
}

export function forget(key: string): void {
  try {
    localStorage.removeItem(key);
  } catch {
    /* idem */
  }
}

export interface Goal {
  op: "ge" | "lt";
  id: MaterialId;
  n: number;
}

/**
 * Objectif d'un monde-défi, encodé « ge:12:600 ». Renvoie null si la chaîne
 * n'en est pas un — elle vient d'un autre visiteur, on ne lui fait pas
 * confiance même si le Worker la valide déjà.
 */
export function parseGoal(goal: string | null | undefined): Goal | null {
  const m = /^(ge|lt):(\d+):(\d+)$/.exec(goal ?? "");
  if (!m || !MATERIALS[Number(m[2])]) return null;
  return { op: m[1] as "ge" | "lt", id: Number(m[2]), n: Number(m[3]) };
}

/** Le même objectif, en français. */
export function goalText(goal: string | null | undefined): string | null {
  const parsed = parseGoal(goal);
  if (!parsed) return null;
  return `${parsed.op === "ge" ? "Au moins" : "Moins de"} ${parsed.n} cellules de ${MATERIALS[parsed.id].name}`;
}

/** Liste des dernières matières : la nouvelle en tête, sans doublon, plafonnée. */
export function pushRecent(list: readonly MaterialId[], id: MaterialId, max: number): MaterialId[] {
  return [id, ...list.filter((other) => other !== id)].slice(0, max);
}

/**
 * Combien de ticks simuler pour une frame, et le reliquat à reporter.
 *
 * La vitesse est exprimée par 60e de seconde, pas par frame : sinon un écran
 * 120 Hz — la plupart des téléphones récents — fait tourner la simulation deux
 * fois trop vite, pour deux fois le courant. `ms` est plafonné, sinon un onglet
 * revenu au premier plan rattraperait sa sieste d'un coup ; `max` borne le
 * rattrapage d'une frame qui traîne.
 */
export function ticksFor(speed: number, ms: number, pending: number, max = 8): { ticks: number; pending: number } {
  const budget = pending + speed * (Math.min(Math.max(ms, 0), 100) / (1000 / 60));
  return { ticks: Math.min(Math.floor(budget), max), pending: budget % 1 };
}

/**
 * Décalage de la vue ramené dans ses bornes : le bac agrandi recouvre
 * toujours son cadre, on ne le pousse plus hors de l'écran. `size` est la
 * taille du cadre (le canvas sans transformation), en pixels d'écran ; le
 * décalage précède l'échelle, il va donc de `size × (1 - zoom)` à 0.
 */
export function clampPan(pan: number, size: number, zoom: number): number {
  return Math.min(0, Math.max(size * (1 - zoom), pan));
}

/**
 * Décalage à appliquer après un zoom pour que le point sous le curseur ne
 * bouge pas. `edge` et `size` décrivent la boîte **affichée** (déjà
 * transformée) ; la boîte d'origine s'en déduit : `edge - pan`, `size / zoom`.
 */
export function panAfterZoom(client: number, edge: number, size: number, pan: number, zoom: number, next: number): number {
  const fraction = (client - edge) / size;
  return client - (edge - pan) - fraction * (size / zoom) * next;
}

/**
 * Tout ce que le clavier commande, réassignable : pause, matières, pinceau,
 * réglages, annulation, zoom, aide, puis les quatre directions (la vue, ou le
 * héros quand il y en a un), creuser, poser, changer de vue.
 */
export const ACTIONS = [
  "pause", "mat1", "mat2", "mat3", "mat4", "mat5", "mat6", "mat7", "mat8", "mat9", "eraser",
  "brushDown", "brushUp", "gravity", "freeze", "heat", "undo", "redo", "paste", "zoomIn", "zoomOut", "help",
  "left", "right", "up", "down", "dig", "place", "view",
] as const;
export type Action = (typeof ACTIONS)[number];
export type Bindings = Record<Action, string>;

/** Les touches d'origine, pensées pour l'AZERTY. Une combinaison s'écrit « Ctrl+z ». */
export const DEFAULT_BINDINGS: Bindings = {
  pause: " ", mat1: "1", mat2: "2", mat3: "3", mat4: "4", mat5: "5", mat6: "6", mat7: "7", mat8: "8", mat9: "9", eraser: "0",
  brushDown: "[", brushUp: "]", gravity: "g", freeze: "f", heat: "h", undo: "Ctrl+z", redo: "Ctrl+y", paste: "Ctrl+v",
  zoomIn: "+", zoomOut: "-", help: "?",
  left: "q", right: "d", up: "z", down: "s", dig: "e", place: "r", view: "v",
};

/** Toujours là en plus de la touche choisie, tant qu'aucune action ne les prend : les flèches, le WASD du QWERTY, Ctrl+Maj+Z. */
const ALIASES: Record<string, Action> = {
  ArrowLeft: "left", ArrowRight: "right", ArrowUp: "up", ArrowDown: "down", a: "left", w: "up", "Ctrl+Maj+z": "redo",
};

/** Ce qui ne s'attribue pas : Échap annule, Tab et Entrée naviguent, Maj seule trace une ligne au clic, les autres modificateurs ne valent que combinés. */
const RESERVED = new Set(["Escape", "Tab", "Enter", "Shift", "Control", "Alt", "AltGraph", "Meta", "CapsLock"]);

/** Une touche seule telle qu'on la range : une lettre en minuscule quelle que soit la casse, un nom de touche tel quel. */
export const keyOf = (key: string): string => (key.length === 1 ? key.toLowerCase() : key);

/**
 * La combinaison d'un événement clavier, telle qu'on la range : « Ctrl+z »,
 * « Ctrl+Maj+z », « g ». Cmd compte pour Ctrl. Maj ne compte qu'avec Ctrl ou
 * Alt : seule, elle ne fait que changer le caractère — les chiffres d'un
 * clavier AZERTY la demandent.
 */
export function combo(e: { key: string; ctrlKey: boolean; metaKey: boolean; altKey: boolean; shiftKey: boolean }): string {
  const ctrl = e.ctrlKey || e.metaKey;
  return (ctrl ? "Ctrl+" : "") + (e.altKey ? "Alt+" : "") + ((ctrl || e.altKey) && e.shiftKey ? "Maj+" : "") + keyOf(e.key);
}

/** La touche d'une combinaison, sans ses modificateurs. */
const bare = (c: string): string => c.replace(/^(Ctrl\+|Alt\+|Maj\+)+(?=.)/, "");

/**
 * Les touches rangées, complétées par celles d'origine. Une valeur abîmée,
 * réservée ou en double se perd sans emporter les autres.
 */
export function parseBindings(text: string | null): Bindings {
  const out = { ...DEFAULT_BINDINGS };
  let saved: unknown = null;
  try { saved = JSON.parse(text ?? "null"); } catch { return out; }
  if (!saved || typeof saved !== "object") return out;
  for (const action of ACTIONS) {
    const key = (saved as Record<string, unknown>)[action];
    if (typeof key === "string") out[action] = rebind(out, action, key)?.[action] ?? out[action];
  }
  return out;
}

/**
 * Donne la combinaison `c` à `action`. Si une autre action l'avait, elle
 * reprend l'ancienne touche de `action` : un échange, jamais une action sans
 * touche. Null pour une touche réservée ou vide.
 */
export function rebind(b: Bindings, action: Action, c: string): Bindings | null {
  if (!bare(c) || RESERVED.has(bare(c))) return null;
  const out = { ...b };
  for (const other of ACTIONS) if (out[other] === c) out[other] = b[action];
  out[action] = c;
  return out;
}

/** De la combinaison à l'action : les touches choisies, puis les alias qu'elles laissent libres. */
export function keymap(b: Bindings): Record<string, Action> {
  const map: Record<string, Action> = { ...ALIASES };
  for (const action of ACTIONS) map[b[action]] = action;
  return map;
}

/** Une combinaison lisible par un humain : « Q », « Ctrl+Z », « ← », « Espace ». */
export function keyLabel(c: string): string {
  const names: Record<string, string> = { " ": "Espace", ArrowLeft: "←", ArrowRight: "→", ArrowUp: "↑", ArrowDown: "↓", Backspace: "Retour", Delete: "Suppr", "-": "−" };
  const key = bare(c);
  return c.slice(0, c.length - key.length) + (names[key] ?? (key.length === 1 ? key.toUpperCase() : key));
}
