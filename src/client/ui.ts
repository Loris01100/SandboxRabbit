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
 * Décalage à appliquer après un zoom pour que le point sous le curseur ne
 * bouge pas. `edge` et `size` décrivent la boîte **affichée** (déjà
 * transformée) ; la boîte d'origine s'en déduit : `edge - pan`, `size / zoom`.
 */
export function panAfterZoom(client: number, edge: number, size: number, pan: number, zoom: number, next: number): number {
  const fraction = (client - edge) / size;
  return client - (edge - pan) - fraction * (size / zoom) * next;
}
