import "./style.css";
import { AMBIENT, Engine } from "./sim/engine.ts";
import { Renderer } from "./sim/render";
import { decode, encode } from "./sim/codec";
import { EMPTY, MATERIALS, PALETTE, SAND, SOURCE, STONE, WATER, type MaterialId } from "./sim/materials.ts";

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

for (const id of PALETTE) {
  const m = MATERIALS[id];
  const button = document.createElement("button");
  button.type = "button";
  button.dataset.id = String(id);
  button.setAttribute("aria-pressed", String(id === current));
  button.innerHTML = `<span class="swatch" style="background:rgb(${m.color.join(",")})"></span>${m.name}`;
  button.addEventListener("click", () => select(id));
  button.addEventListener("pointerenter", () => (hintEl.textContent = m.hint));
  paletteEl.append(button);
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
  const n = Number(e.key);
  if (!Number.isNaN(n) && PALETTE[n - 1] !== undefined) select(PALETTE[n - 1]);
  if (e.key === "0") select(EMPTY);
  if (e.key === "g") flipGravity();
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

/** Les liquides et gaz sont déposés en pointillé, sinon on en crée trop d'un coup. */
function paintAt(x: number, y: number): void {
  const kind = MATERIALS[current].kind;
  const density = kind === "liquid" || kind === "gas" ? 0.35 : 1;
  engine.paint(x, y, brush, current, density, !keepInput.checked);
}

canvas.addEventListener("pointerdown", (e) => {
  painting = true;
  canvas.setPointerCapture(e.pointerId);
  const p = toCell(e);
  last = p;
  paintAt(p.x, p.y);
});

canvas.addEventListener("pointermove", (e) => {
  if (!painting) return;
  const p = toCell(e);
  // Interpolation : à 60 fps un geste rapide saute des dizaines de cellules.
  if (last) {
    const steps = Math.max(Math.abs(p.x - last.x), Math.abs(p.y - last.y));
    for (let s = 1; s < steps; s++) {
      paintAt(
        Math.round(last.x + ((p.x - last.x) * s) / steps),
        Math.round(last.y + ((p.y - last.y) * s) / steps),
      );
    }
  }
  paintAt(p.x, p.y);
  last = p;
});

for (const type of ["pointerup", "pointercancel", "pointerleave"] as const) {
  canvas.addEventListener(type, () => { painting = false; last = null; });
}

/* ----------------------------------------------------------------- réglages */

const brushInput = document.querySelector<HTMLInputElement>("#brush")!;
const brushValue = document.querySelector<HTMLOutputElement>("#brush-value")!;
brushInput.addEventListener("input", () => {
  brush = Number(brushInput.value);
  brushValue.value = brushInput.value;
});

const keepInput = document.querySelector<HTMLInputElement>("#keep")!;

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

const gravityButton = document.querySelector<HTMLButtonElement>("#gravity")!;
function flipGravity(): void {
  engine.gravity = engine.gravity === 1 ? -1 : 1;
  gravityButton.textContent = engine.gravity === 1 ? "Gravité ↓" : "Gravité ↑";
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

document.querySelector<HTMLButtonElement>("#clear")!.addEventListener("click", () => engine.clear());

/* -------------------------------------------------------------- mondes/API */

const statusEl = document.querySelector<HTMLParagraphElement>("#status")!;
const worldsEl = document.querySelector<HTMLUListElement>("#worlds")!;

interface WorldSummary { id: string; name: string; createdAt: string }

async function listWorlds(): Promise<void> {
  try {
    const res = await fetch("/api/worlds");
    const worlds: WorldSummary[] = await res.json();
    worldsEl.replaceChildren(
      ...worlds.map((w) => {
        const li = document.createElement("li");
        const button = document.createElement("button");
        button.type = "button";
        button.textContent = w.name;
        button.title = new Date(w.createdAt).toLocaleString("fr-FR");
        button.addEventListener("click", () => loadWorld(w.id));
        li.append(button);
        return li;
      }),
    );
    if (worlds.length === 0) statusEl.textContent = "Aucun monde sauvegardé.";
  } catch {
    statusEl.textContent = "API injoignable.";
  }
}

async function loadWorld(id: string): Promise<void> {
  const res = await fetch(`/api/worlds/${id}`);
  if (!res.ok) { statusEl.textContent = "Monde introuvable."; return; }
  const world = await res.json() as { name: string; width: number; height: number; data: string };
  if (world.width !== WIDTH || world.height !== HEIGHT) {
    statusEl.textContent = "Taille de grille incompatible.";
    return;
  }
  load(world.data);
  statusEl.textContent = `« ${world.name} » chargé.`;
}

document.querySelector<HTMLButtonElement>("#save")!.addEventListener("click", async () => {
  const name = prompt("Nom du monde ?", `bac-${new Date().toLocaleTimeString("fr-FR")}`);
  if (!name) return;
  statusEl.textContent = "Sauvegarde…";
  const res = await fetch("/api/worlds", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name, width: WIDTH, height: HEIGHT, data: encode(engine.cells) }),
  });
  statusEl.textContent = res.ok ? "Sauvegardé." : "Échec de la sauvegarde.";
  if (res.ok) void listWorlds();
});

/** Charge une grille encodée (API ou lien partagé). */
function load(data: string): void {
  engine.cells.set(decode(data, WIDTH * HEIGHT));
  engine.life.fill(0);
  engine.temp.fill(AMBIENT);
}

// Partage : le monde entier tient dans l'URL (RLE + base64, ~1 ko).
document.querySelector<HTMLButtonElement>("#share")!.addEventListener("click", async () => {
  location.hash = encodeURIComponent(encode(engine.cells));
  try {
    await navigator.clipboard.writeText(location.href);
    statusEl.textContent = "Lien copié.";
  } catch {
    statusEl.textContent = "Lien dans la barre d'adresse.";
  }
});

document.querySelector<HTMLButtonElement>("#refresh")!.addEventListener("click", () => void listWorlds());
void listWorlds();

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

if (location.hash.length > 1) load(decodeURIComponent(location.hash.slice(1)));
else seed();

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
    frames = 0;
    lastReport = now;
  }
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
