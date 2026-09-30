import { MATERIALS, type MaterialId } from "./sim/materials.ts";
import { CLOCK, HOURS, clockAt, hourTint } from "./sim/render.ts";
import { current, paletteEl, select } from "./palette.ts";
import { stored, write } from "./ui.ts";
import { zoomInput } from "./view.ts";
import { WIDTH, airView, hour, light, lightDetail, limitFps, resize, screen, set } from "./world.ts";

/** Rayon du pinceau, en cellules. */
export let brush = 5;
export const brushInput = document.querySelector<HTMLInputElement>("#brush")!;
const brushValue = document.querySelector<HTMLOutputElement>("#brush-value")!;
brushInput.addEventListener("input", () => {
  brush = Number(brushInput.value);
  brushValue.value = brushInput.value;
});

export const keepInput = document.querySelector<HTMLInputElement>("#keep")!;
export const onlyInput = document.querySelector<HTMLInputElement>("#only")!;
export const mirrorInput = document.querySelector<HTMLInputElement>("#mirror")!;
export const toolInput = document.querySelector<HTMLSelectElement>("#tool")!;

/** Ticks de simulation par 60e de seconde : 0,25 (ralenti) à 4 (accéléré). */
let speed = 1;
const speedInput = document.querySelector<HTMLInputElement>("#speed")!;
const speedValue = document.querySelector<HTMLOutputElement>("#speed-value")!;
speedInput.addEventListener("input", () => {
  speed = Number(speedInput.value) / 4;
  set({ speed });
  speedValue.value = `×${speed.toLocaleString("fr-FR")}`;
});

const windInput = document.querySelector<HTMLInputElement>("#wind")!;
const windValue = document.querySelector<HTMLOutputElement>("#wind-value")!;
windInput.addEventListener("input", () => {
  set({ wind: Number(windInput.value) / 10 });
  windValue.value = windInput.value;
});

// Climat de la scène : tout retourne à cette température (hiver, four…).
const ambientInput = document.querySelector<HTMLInputElement>("#ambient")!;
const ambientValue = document.querySelector<HTMLOutputElement>("#ambient-value")!;
ambientInput.addEventListener("input", () => {
  set({ ambient: Number(ambientInput.value) });
  ambientValue.value = `${ambientInput.value} °C`;
});

/** Taille du bac. main.ts y ajoute l'abandon du défi en cours. */
export const sizeInput = document.querySelector<HTMLSelectElement>("#size")!;
sizeInput.addEventListener("input", () => {
  const w = Number(sizeInput.value);
  resize(w, (w * 9) / 16);
});

/**
 * Impose une taille au bac **sans le regraîner** : ce dont ont besoin les
 * scènes (écrites pour 320×180), un lien partagé et l'hôte d'un salon.
 * Une largeur qui n'est pas au menu est refusée — le lien vient d'ailleurs.
 */
export function fit(w: number): void {
  if (w === WIDTH) return;
  if (![...sizeInput.options].some((o) => o.value === String(w))) return;
  resize(w, (w * 9) / 16, true);
  sizeInput.value = String(w);
  // Aucun événement ne part d'une valeur posée en code : sans ce rappel, les
  // réglages gardaient l'ancienne taille, et la visite suivante rouvrait le bac
  // dans une grille qui n'était plus la sienne.
  remember();
}

// Météo : la pluie elle-même vit dans gestures.ts, avec le tirage du moteur.
const weatherInput = document.querySelector<HTMLSelectElement>("#weather")!;
weatherInput.addEventListener("input", () => set({ weather: Number(weatherInput.value) }));

// Vue thermique et vue pression : l'une ou l'autre. Cocher l'une décoche
// l'autre, sinon la pression, qui passe devant, masquait la thermique cochée.
export const heatmapInput = document.querySelector<HTMLInputElement>("#heatmap")!;
export const airmapInput = document.querySelector<HTMLInputElement>("#airmap")!;
heatmapInput.addEventListener("change", () => {
  set({ heatmap: heatmapInput.checked });
  if (heatmapInput.checked && airmapInput.checked) { airmapInput.checked = false; airView(false); }
});
airmapInput.addEventListener("change", () => {
  airView(airmapInput.checked);
  if (airmapInput.checked && heatmapInput.checked) { heatmapInput.checked = false; set({ heatmap: false }); }
});

// Heure : la teinte du ciel, réglage de la page seule (world.ts). Le cycle
// avance d'un cran par seconde : un fondu plus fin recolorierait tout le bac
// à chaque frame pour un écart invisible.
const hourInput = document.querySelector<HTMLSelectElement>("#hour")!;
const clockEl = document.querySelector<HTMLSpanElement>("#clock")!;
function tickHour(): void {
  const cycle = hourInput.value === "cycle", now = performance.now() / 1000;
  const key = hourInput.value in HOURS ? hourInput.value : "apres-midi";
  hour(cycle ? hourTint(now) : HOURS[key]);
  const minutes = Math.floor((cycle ? clockAt(now) : CLOCK[key]) * 60);
  clockEl.textContent = `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, "0")}`;
}
hourInput.addEventListener("input", tickHour);
setInterval(() => { if (hourInput.value === "cycle") tickHour(); }, 1000);

const lightingInput = document.querySelector<HTMLInputElement>("#lighting")!;
lightingInput.addEventListener("change", () => light(lightingInput.checked));
if (screen.kind === "2d") {
  lightingInput.disabled = true;
  lightingInput.parentElement!.title = "Demande WebGL2, absent de ce navigateur";
}

// Graphismes (fenêtre Paramètres), pour les petits PC : moins d'images par
// seconde, un éclairage plus grossier. Réglages de la page seule — le bac
// simule pareil, le salon n'en sait rien.
const fpsCapInput = document.querySelector<HTMLSelectElement>("#fps-cap")!;
fpsCapInput.addEventListener("input", () => limitFps(Number(fpsCapInput.value)));
const lightDetailInput = document.querySelector<HTMLSelectElement>("#light-detail")!;
lightDetailInput.addEventListener("input", () => lightDetail(Number(lightDetailInput.value)));
if (screen.kind === "2d") {
  lightDetailInput.disabled = true;
  lightDetailInput.parentElement!.title = "Demande WebGL2, absent de ce navigateur";
}

// Réglages retenus d'une visite à l'autre. On rejoue l'événement "input" plutôt
// que de dupliquer les handlers ci-dessus.
// ponytail: un blob JSON sans version — un réglage renommé repart au défaut.
const SETTINGS = "sandbox-rabbit:reglages";

/**
 * Les réglages retenus, désignés par leur `id` — les clés du blob sont donc
 * celles d'avant (`brush`, `speed`…), les anciennes visites se relisent.
 * Une case à cocher garde son `checked`, tout le reste sa `value`.
 */
const SAVED = [
  brushInput, speedInput, windInput, ambientInput, sizeInput,
  toolInput, keepInput, onlyInput, mirrorInput, zoomInput, weatherInput, heatmapInput, airmapInput, lightingInput, hourInput,
  fpsCapInput, lightDetailInput,
];
const isCheck = (el: Element): el is HTMLInputElement =>
  el instanceof HTMLInputElement && el.type === "checkbox";

function remember(): void {
  const state: Record<string, string | number | boolean> = { current };
  for (const el of SAVED) state[el.id] = isCheck(el) ? el.checked : el.value;
  write(SETTINGS, JSON.stringify(state));
}
// Les deux événements : une case coche sur « change », un curseur glisse sur « input ».
for (const el of SAVED) for (const type of ["input", "change"]) el.addEventListener(type, remember);
paletteEl.addEventListener("click", remember);

/**
 * Remet les réglages de la visite précédente, en rejouant leur événement
 * plutôt qu'en dupliquant les handlers : c'est lui qui pousse la valeur dans
 * le moteur (vent, ambiante) ou dans le rendu. main.ts l'appelle une fois
 * tous ses écouteurs posés (celui de la taille abandonne le défi en cours),
 * et avant de charger le bac gardé, que la taille restaurée effacerait.
 */
export function restore(): void {
  // Forme libre : le blob n'est pas versionné, chaque champ est retesté ci-dessous.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const saved = stored<any>(SETTINGS, null);
  if (!saved) return;
  if (MATERIALS[saved.current as MaterialId]) select(saved.current as MaterialId);
  for (const el of SAVED) {
    const value = typeof saved[el.id] === "boolean" && !isCheck(el) ? Number(saved[el.id]) : saved[el.id];
    if (value === undefined) continue; // réglage absent d'une version précédente
    if (isCheck(el)) {
      el.checked = Boolean(value);
      el.dispatchEvent(new Event("change"));
    } else {
      el.value = String(value);
      el.dispatchEvent(new Event("input"));
    }
  }
}
