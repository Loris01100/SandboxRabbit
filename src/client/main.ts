import "./style.css";
import { Engine } from "./sim/engine.ts";
import { Renderer, thumbnail } from "./sim/render";
import { decode, decodeFrozen, encode } from "./sim/codec";
import { CATEGORIES, EMPTY, MATERIALS, SAND, SHORTCUTS, SOURCE, STONE, SWITCH, WATER, type MaterialId } from "./sim/materials.ts";
import { CHALLENGES, type Challenge } from "./challenges.ts";

const WIDTH = 320;
const HEIGHT = 180;

const engine = new Engine(WIDTH, HEIGHT);
const canvas = document.querySelector<HTMLCanvasElement>("#world")!;
const renderer = new Renderer(canvas, engine);

let current: MaterialId = SAND;
let brush = 5;
let running = true;

/* ---------------------------------------------------------------- palette */

const paletteEl = document.querySelector<HTMLDivElement>("#palette")!;
const hintEl = document.querySelector<HTMLParagraphElement>("#hint")!;

// Une famille = un <details> repliable (natif) contenant sa grille de boutons.
for (const [n, cat] of CATEGORIES.entries()) {
  const box = document.createElement("details");
  box.className = "cat";
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
  button.innerHTML = `<span class="swatch" style="background:rgb(${m.color.join(",")})"></span>${m.name}`;
  button.addEventListener("click", () => select(id));
  button.addEventListener("pointerenter", () => (hintEl.textContent = m.hint));
  return button;
}
paletteEl.addEventListener("pointerleave", () => (hintEl.textContent = MATERIALS[current].hint));

function select(id: MaterialId): void {
  current = id;
  // Une source crache la dernière matière choisie avant elle.
  if (id !== SOURCE && id !== EMPTY) engine.emit = id;
  hintEl.textContent = MATERIALS[id].hint;
  for (const b of paletteEl.querySelectorAll("button")) {
    b.setAttribute("aria-pressed", String(Number(b.dataset.id) === id));
  }
}
select(current);

// Raccourcis : 1..9 puis 0 pour la gomme.
addEventListener("keydown", (e) => {
  if (e.key === " ") { toggleRun(); e.preventDefault(); return; }
  if ((e.ctrlKey || e.metaKey) && (e.key === "y" || (e.key === "Z" && e.shiftKey))) { redo(); e.preventDefault(); return; }
  if (e.key === "z" && (e.ctrlKey || e.metaKey)) { undo(); e.preventDefault(); return; }
  const n = Number(e.key);
  if (!Number.isNaN(n) && SHORTCUTS[n - 1] !== undefined) select(SHORTCUTS[n - 1]);
  if (e.key === "0") select(EMPTY);
  if (e.key === "g") flipGravity();
  if (e.key === "f") toolInput.value = toolInput.value === "paint" ? "freeze" : "paint";
  if (e.key === "h") { heatmapInput.checked = !heatmapInput.checked; renderer.heatmap = heatmapInput.checked; }
});

/* ------------------------------------------------------------------ souris */

let painting = false;
let last: { x: number; y: number } | null = null;

function toCell(e: PointerEvent): { x: number; y: number } {
  const r = canvas.getBoundingClientRect();
  return {
    x: Math.floor(((e.clientX - r.left) / r.width) * WIDTH),
    y: Math.floor(((e.clientY - r.top) / r.height) * HEIGHT),
  };
}

/** Un coup de pinceau, plus son reflet si la symétrie est cochée. */
function paintAt(x: number, y: number): void {
  dab(x, y);
  if (mirrorInput.checked) dab(WIDTH - 1 - x, y);
}

/** Les liquides et gaz sont déposés en pointillé, sinon on en crée trop d'un coup. */
function dab(x: number, y: number): void {
  if (toolInput.value !== "paint") {
    engine.setFrozen(x, y, brush, toolInput.value === "freeze");
    return;
  }
  const kind = MATERIALS[current].kind;
  const density = kind === "liquid" || kind === "gas" ? 0.35 : 1;
  // Gomme sélective : on n'efface que la dernière matière choisie avant la gomme.
  const only = current === EMPTY && onlyInput.checked ? engine.emit : undefined;
  engine.paint(x, y, brush, current, density, !keepInput.checked, only);
}

/** Trace un segment de cellules (geste rapide, ou ligne droite au Maj). */
function strokeTo(from: { x: number; y: number }, to: { x: number; y: number }): void {
  const steps = Math.max(Math.abs(to.x - from.x), Math.abs(to.y - from.y));
  for (let s = 1; s < steps; s++) {
    paintAt(
      Math.round(from.x + ((to.x - from.x) * s) / steps),
      Math.round(from.y + ((to.y - from.y) * s) / steps),
    );
  }
  paintAt(to.x, to.y);
}

// Le clic droit sert au remplissage : pas de menu contextuel sur le bac.
canvas.addEventListener("contextmenu", (e) => e.preventDefault());

canvas.addEventListener("pointerdown", (e) => {
  const p = toCell(e);
  // Pipette : Alt+clic reprend la matière sous le curseur, sans rien modifier.
  if (e.altKey) { select(engine.get(p.x, p.y) as MaterialId); return; }
  snapshot();
  if (e.button === 2) { engine.fill(p.x, p.y, current); return; }
  // Cliquer un interrupteur déjà posé le bascule au lieu d'en reposer un.
  if (current === SWITCH && engine.get(p.x, p.y) === SWITCH) { engine.toggleSwitch(p.x, p.y); return; }
  canvas.setPointerCapture(e.pointerId);
  painting = true;
  // Maj : on relie le dernier point posé, même si le pinceau a été relâché entre-temps.
  if (e.shiftKey && last) strokeTo(last, p);
  else paintAt(p.x, p.y);
  last = p;
});

const probeEl = document.querySelector<HTMLSpanElement>("#probe")!;

/** Matière et température sous le curseur : c'est ce qui rend la vue thermique lisible. */
function probe(p: { x: number; y: number }): void {
  if (!engine.inBounds(p.x, p.y)) { probeEl.textContent = "–"; return; }
  const i = engine.index(p.x, p.y);
  probeEl.textContent = `${MATERIALS[engine.cells[i]].name} · ${Math.round(engine.temp[i])} °C`;
}

canvas.addEventListener("pointermove", (e) => {
  const at = toCell(e);
  probe(at);
  if (!painting) return;
  const p = at;
  // Interpolation : à 60 fps un geste rapide saute des dizaines de cellules.
  if (last) strokeTo(last, p);
  else paintAt(p.x, p.y);
  last = p;
});

for (const type of ["pointerup", "pointercancel", "pointerleave"] as const) {
  // `last` est conservé : c'est l'ancre de la ligne droite au Maj.
  canvas.addEventListener(type, () => (painting = false));
}
canvas.addEventListener("pointerleave", () => (probeEl.textContent = "–"));

/* ----------------------------------------------------------------- annuler */

// Une copie des quatre tableaux avant chaque geste destructeur, dix crans
// gardés (~230 ko le cran, `temp` étant en Float32 : 2,3 Mo au plus).
const UNDO_MAX = 10;
type Snapshot = { cells: Uint8Array; life: Uint8Array; temp: Float32Array; frozen: Uint8Array };
const undoStack: Snapshot[] = [];
const redoStack: Snapshot[] = [];

function capture(): Snapshot {
  return {
    cells: engine.cells.slice(),
    life: engine.life.slice(),
    temp: engine.temp.slice(),
    frozen: engine.frozen.slice(),
  };
}

function restore(state: Snapshot): void {
  engine.cells.set(state.cells);
  engine.life.set(state.life);
  engine.temp.set(state.temp);
  engine.frozen.set(state.frozen);
}

function snapshot(): void {
  undoStack.push(capture());
  if (undoStack.length > UNDO_MAX) undoStack.shift();
  redoStack.length = 0; // un nouveau geste referme la branche annulée
}

/** Dépile d'un côté en empilant de l'autre : annuler et rétablir sont le même geste. */
function jump(from: Snapshot[], to: Snapshot[], done: string, empty: string): void {
  const state = from.pop();
  if (!state) { statusEl.textContent = empty; return; }
  to.push(capture());
  restore(state);
  const left = from.length;
  statusEl.textContent = `${done} (${left} cran${left > 1 ? "s" : ""} restant${left > 1 ? "s" : ""}).`;
}

const undo = (): void => jump(undoStack, redoStack, "Annulé", "Rien à annuler.");
const redo = (): void => jump(redoStack, undoStack, "Rétabli", "Rien à rétablir.");

document.querySelector<HTMLButtonElement>("#undo")!.addEventListener("click", undo);
document.querySelector<HTMLButtonElement>("#redo")!.addEventListener("click", redo);

/* ----------------------------------------------------------------- réglages */

const brushInput = document.querySelector<HTMLInputElement>("#brush")!;
const brushValue = document.querySelector<HTMLOutputElement>("#brush-value")!;
brushInput.addEventListener("input", () => {
  brush = Number(brushInput.value);
  brushValue.value = brushInput.value;
});

const keepInput = document.querySelector<HTMLInputElement>("#keep")!;
const onlyInput = document.querySelector<HTMLInputElement>("#only")!;
const mirrorInput = document.querySelector<HTMLInputElement>("#mirror")!;
const toolInput = document.querySelector<HTMLSelectElement>("#tool")!;

/** Ticks de simulation par frame : 0,25 (ralenti) à 4 (accéléré). */
let speed = 1;
const speedInput = document.querySelector<HTMLInputElement>("#speed")!;
const speedValue = document.querySelector<HTMLOutputElement>("#speed-value")!;
speedInput.addEventListener("input", () => {
  speed = Number(speedInput.value) / 4;
  speedValue.value = `×${speed.toLocaleString("fr-FR")}`;
});

const windInput = document.querySelector<HTMLInputElement>("#wind")!;
const windValue = document.querySelector<HTMLOutputElement>("#wind-value")!;
windInput.addEventListener("input", () => {
  engine.wind = Number(windInput.value) / 10;
  windValue.value = windInput.value;
});

// Climat de la scène : tout retourne à cette température (hiver, four…).
const ambientInput = document.querySelector<HTMLInputElement>("#ambient")!;
const ambientValue = document.querySelector<HTMLOutputElement>("#ambient-value")!;
ambientInput.addEventListener("input", () => {
  engine.ambient = Number(ambientInput.value);
  ambientValue.value = `${ambientInput.value} °C`;
});

const heatmapInput = document.querySelector<HTMLInputElement>("#heatmap")!;
heatmapInput.addEventListener("change", () => (renderer.heatmap = heatmapInput.checked));

// Réglages retenus d'une visite à l'autre. On rejoue l'événement "input" plutôt
// que de dupliquer les handlers ci-dessus.
// ponytail: un blob JSON sans version — un réglage renommé repart au défaut.
const SETTINGS = "sandbox-rabbit:reglages";
function remember(): void {
  localStorage.setItem(SETTINGS, JSON.stringify({
    current, brush: brushInput.value, speed: speedInput.value, wind: windInput.value,
    ambient: ambientInput.value,
  }));
}
for (const el of [brushInput, speedInput, windInput, ambientInput]) el.addEventListener("input", remember);
paletteEl.addEventListener("click", remember);

const saved = JSON.parse(localStorage.getItem(SETTINGS) ?? "null");
if (saved) {
  if (MATERIALS[saved.current as MaterialId]) select(saved.current as MaterialId);
  for (const [el, value] of [[brushInput, saved.brush], [speedInput, saved.speed], [windInput, saved.wind], [ambientInput, saved.ambient]] as const) {
    if (value === undefined) continue; // réglage absent d'une version précédente
    el.value = value;
    el.dispatchEvent(new Event("input"));
  }
}

const gravityButton = document.querySelector<HTMLButtonElement>("#gravity")!;
function flipGravity(): void {
  engine.gravity = engine.gravity === 1 ? -1 : 1;
  gravityButton.textContent = engine.gravity === 1 ? "Vers le bas ↓" : "Vers le haut ↑";
}
gravityButton.addEventListener("click", flipGravity);

const playButton = document.querySelector<HTMLButtonElement>("#play")!;
function toggleRun(): void {
  running = !running;
  playButton.textContent = running ? "Pause" : "Reprendre";
}
playButton.addEventListener("click", toggleRun);

document.querySelector<HTMLButtonElement>("#step")!.addEventListener("click", () => {
  running = false;
  playButton.textContent = "Reprendre";
  engine.step();
});

// Plein écran natif : le CSS `pixelated` fait la mise à l'échelle, le rendu ne
// change pas d'un pixel et `getBoundingClientRect()` suit le pinceau.
document.querySelector<HTMLButtonElement>("#full")!.addEventListener("click", () => {
  if (document.fullscreenElement) void document.exitFullscreen();
  else void canvas.requestFullscreen();
});

document.querySelector<HTMLButtonElement>("#clear")!.addEventListener("click", () => { snapshot(); engine.clear(); });

/* -------------------------------------------------------------- mondes/API */

const statusEl = document.querySelector<HTMLParagraphElement>("#status")!;
const galleryEl = document.querySelector<HTMLDialogElement>("#gallery")!;
const galleryGrid = document.querySelector<HTMLDivElement>("#gallery-grid")!;

interface World { id: string; name: string; createdAt: string; width: number; height: number; data: string; views: number }

/**
 * Galerie : une seule requête ramène les mondes avec leur grille, qui devient la
 * vignette. Ouverte en modale (`<dialog>`), le panneau est trop étroit pour
 * montrer des images.
 */
let worlds: World[] = [];

async function openGallery(): Promise<void> {
  galleryEl.showModal();
  galleryGrid.replaceChildren(note("Chargement…"));
  try {
    worlds = await (await fetch("/api/worlds")).json();
  } catch {
    galleryGrid.replaceChildren(note("API injoignable."));
    return;
  }
  drawGallery();
}

// Le tri se fait sur la liste déjà en main : elle est plafonnée à 50 mondes,
// inutile de redemander au Worker.
const sortInput = document.querySelector<HTMLSelectElement>("#gallery-sort")!;
sortInput.addEventListener("change", drawGallery);

function drawGallery(): void {
  const sorted = [...worlds].sort((a, b) =>
    sortInput.value === "views" ? (b.views ?? 0) - (a.views ?? 0) : b.createdAt.localeCompare(a.createdAt),
  );
  galleryGrid.replaceChildren(
    ...(sorted.length ? sorted.map(card) : [note("Aucun monde. « Sauvegarder » en dépose un.")]),
  );
}

function note(text: string): HTMLParagraphElement {
  const p = document.createElement("p");
  p.className = "hint";
  p.textContent = text;
  return p;
}

function card(w: World): HTMLDivElement {
  const slot = document.createElement("div");
  slot.className = "slot";
  const button = document.createElement("button");
  button.type = "button";
  button.className = "card";
  const name = document.createElement("span");
  name.className = "name";
  name.textContent = w.name; // textContent : le nom vient d'un autre visiteur
  const date = document.createElement("span");
  date.className = "date";
  date.textContent = `${new Date(w.createdAt).toLocaleDateString("fr-FR")} · ${w.views ?? 0} vue${(w.views ?? 0) > 1 ? "s" : ""}`;
  button.append(name, date);

  // La grille sert deux fois : à dessiner la vignette, puis à charger le monde.
  const usable = w.width === WIDTH && w.height === HEIGHT;
  try {
    button.prepend(thumbnail(decode(w.data, w.width * w.height), w.width, w.height));
    if (!usable) button.title = "Taille de grille incompatible";
  } catch {
    button.title = "Monde illisible";
  }
  button.addEventListener("click", async () => {
    if (!usable) return;
    // On charge par l'API plutôt que par la copie déjà en main : c'est ce
    // passage qui compte la vue. Injoignable, on se rabat sur la copie.
    const fresh = await fetch(`/api/worlds/${w.id}`).then((r) => r.json() as Promise<World>).catch(() => w);
    load(fresh.data ?? w.data);
    galleryEl.close();
    statusEl.textContent = `« ${w.name} » chargé.`;
  });

  // Suppression : rien ne protège les mondes des autres, comme la sauvegarde
  // n'identifie personne. ponytail: ajouter un jeton le jour où ça compte.
  const del = document.createElement("button");
  del.type = "button";
  del.className = "del";
  del.title = "Supprimer";
  del.textContent = "×";
  del.addEventListener("click", async () => {
    if (!confirm(`Supprimer « ${w.name} » ?`)) return;
    const res = await fetch(`/api/worlds/${w.id}`, { method: "DELETE" });
    if (res.ok) slot.remove();
    else statusEl.textContent = "Échec de la suppression.";
  });

  slot.append(button, del);
  return slot;
}

document.querySelector<HTMLButtonElement>("#gallery-open")!.addEventListener("click", () => void openGallery());

document.querySelector<HTMLButtonElement>("#save")!.addEventListener("click", async () => {
  const name = prompt("Nom du monde ?", `bac-${new Date().toLocaleTimeString("fr-FR")}`);
  if (!name) return;
  statusEl.textContent = "Sauvegarde…";
  const res = await fetch("/api/worlds", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name, width: WIDTH, height: HEIGHT, data: encode(engine.cells, engine.frozen) }),
  });
  statusEl.textContent = res.ok ? "Sauvegardé — visible dans la galerie." : "Échec de la sauvegarde.";
});

/** Charge une grille encodée (API ou lien partagé). */
function load(data: string): void {
  snapshot();
  engine.cells.set(decode(data, WIDTH * HEIGHT));
  engine.frozen.set(decodeFrozen(data, WIDTH * HEIGHT));
  engine.life.fill(0);
  engine.temp.fill(engine.ambient);
}

// Partage : le monde entier tient dans l'URL (RLE + base64, ~1 ko).
document.querySelector<HTMLButtonElement>("#share")!.addEventListener("click", async () => {
  location.hash = encodeURIComponent(encode(engine.cells, engine.frozen));
  try {
    await navigator.clipboard.writeText(location.href);
    statusEl.textContent = "Lien copié.";
  } catch {
    statusEl.textContent = "Lien dans la barre d'adresse.";
  }
});


// Image : le canvas fait 320x180, on le repasse ×4 sans lissage pour sortir un
// PNG regardable plutôt qu'une vignette.
document.querySelector<HTMLButtonElement>("#png")!.addEventListener("click", () => {
  const big = document.createElement("canvas");
  big.width = WIDTH * 4;
  big.height = HEIGHT * 4;
  const ctx = big.getContext("2d")!;
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(canvas, 0, 0, big.width, big.height);
  big.toBlob((blob) => {
    if (!blob) return;
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `bac-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.png`;
    a.click();
    URL.revokeObjectURL(a.href);
  });
});


/* -------------------------------------------------------------------- défis */

const goalEl = document.querySelector<HTMLParagraphElement>("#goal")!;
const challengesEl = document.querySelector<HTMLDivElement>("#challenges")!;
let challenge: Challenge | null = null;
/** Horloge murale : la pause et le ralenti comptent aussi, c'est un chrono de joueur. */
let startedAt = 0;

// Meilleur temps par défi, en secondes. ponytail: local à la machine, pas de classement.
const RECORDS = "sandbox-rabbit:records";
const records: Record<string, number> = JSON.parse(localStorage.getItem(RECORDS) ?? "{}");
const best = (name: string): string => (records[name] === undefined ? "" : ` (record : ${records[name]} s)`);

for (const c of CHALLENGES) {
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = c.name;
  button.addEventListener("click", () => {
    snapshot();
    engine.clear();
    c.build(engine);
    challenge = c;
    startedAt = performance.now();
    goalEl.textContent = `${c.name} — ${c.goal}${best(c.name)}`;
  });
  challengesEl.append(button);
}

/* -------------------------------------------------------------------- scène */

/** Une petite cuvette de pierre avec du sable et de l'eau, pour ne pas démarrer devant du vide. */
function seed(): void {
  for (let x = 0; x < WIDTH; x++) {
    const bowl = Math.round(HEIGHT - 12 - 26 * Math.sin((x / WIDTH) * Math.PI));
    for (let y = bowl; y < HEIGHT; y++) engine.set(x, y, STONE);
  }
  for (let x = 60; x < 140; x++) {
    for (let y = 60; y < 90; y++) engine.set(x, y, SAND);
  }
  for (let x = 180; x < 260; x++) {
    for (let y = 50; y < 80; y++) engine.set(x, y, WATER);
  }
}

// Le bac est repris tel quel d'une visite à l'autre : le lien partagé passe
// devant, puis la dernière scène, et seulement à défaut la cuvette de départ.
// ponytail: la grille seule — température et vies repartent au repos.
const BAC = "sandbox-rabbit:bac";
const kept = localStorage.getItem(BAC);
if (location.hash.length > 1) load(decodeURIComponent(location.hash.slice(1)));
else if (kept) load(kept);
else seed();
undoStack.length = 0; // rien à annuler avant le premier geste

// `visibilitychange` plutôt que `beforeunload` : c'est le seul que les mobiles
// déclenchent vraiment quand l'onglet part en arrière-plan.
addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") localStorage.setItem(BAC, encode(engine.cells, engine.frozen));
});

/* ------------------------------------------------------------ boucle rendu */

const fpsEl = document.querySelector<HTMLSpanElement>("#fps")!;
const filledEl = document.querySelector<HTMLSpanElement>("#filled")!;
let frames = 0;
let lastReport = performance.now();

/** Reliquat de tick quand la vitesse n'est pas entière (ralenti). */
let pending = 0;

function frame(now: number): void {
  // Clic maintenu sans bouger : on continue de déposer sous le curseur.
  if (painting && last) paintAt(last.x, last.y);
  if (running) {
    pending += speed;
    // Plafonné : si une frame traîne, on saute des ticks plutôt que de s'enliser.
    for (let n = Math.min(Math.floor(pending), 8); n > 0; n--) engine.step();
    pending %= 1;
  }
  renderer.draw();

  frames++;
  if (now - lastReport >= 500) {
    fpsEl.textContent = String(Math.round((frames * 1000) / (now - lastReport)));
    let filled = 0;
    for (let i = 0; i < engine.cells.length; i++) if (engine.cells[i] !== EMPTY) filled++;
    filledEl.textContent = filled.toLocaleString("fr-FR");
    if (challenge && challenge.won(engine)) {
      const secs = Math.round((now - startedAt) / 1000);
      const record = records[challenge.name] === undefined || secs < records[challenge.name];
      if (record) {
        records[challenge.name] = secs;
        localStorage.setItem(RECORDS, JSON.stringify(records));
      }
      goalEl.textContent = `${challenge.name} — réussi en ${secs} s${record ? " — nouveau record !" : best(challenge.name)}`;
      challenge = null;
    }
    frames = 0;
    lastReport = now;
  }
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
