/**
 * Le shader de screen.ts contre `Renderer` de render.ts, dans un vrai
 * navigateur : les deux copies du coloriage doivent sortir les mêmes pixels,
 * à une unité près (la division approchée du GPU, voir test/browser.ts).
 * Aucun test Node ne le voit — Node n'a pas de carte graphique — et une règle
 * d'aspect changée d'un seul côté ne se remarquait qu'à l'œil, sur une machine
 * sans WebGL2.
 *
 * La grille : un monde généré qui a tourné un peu, et en haut une bande de
 * chaque matière où `life`, la température et le figé varient, de quoi passer
 * par toutes les branches (lueurs, halo de chaleur, damier du figé), et la
 * pression d'un souffle plus une rampe de tous ses paliers. Comparée aux
 * quatre heures, en vue thermique, en vue thermique sous zéro et en vue pression.
 *
 * Le résultat va dans `window.screenReport` et dans la page : test/browser.ts
 * le lit, et on peut aussi ouvrir http://localhost:5173/test/screen.html
 * pendant `npm run dev`.
 */
import { Engine } from "../src/client/sim/engine.ts";
import { MATERIALS } from "../src/client/sim/materials.ts";
import { AIR_LEVELS, HOURS, Renderer, type Grid, type Mirror, type Tint, type View } from "../src/client/sim/render.ts";
import { terrain } from "../src/client/terrain.ts";
import { createScreen, type Screen } from "../src/client/screen.ts";

export interface Case {
  name: string;
  /** Pixels dont un canal au moins diffère. */
  differ: number;
  /** Le plus grand écart sur un canal. */
  worst: number;
  /** Le premier pixel qui diffère, pour chercher la branche en cause. */
  first: string | null;
}

export interface Report {
  kind: "webgl2" | "2d";
  pixels: number;
  cases: Case[];
}

declare global {
  interface Window { screenReport?: Report }
}

const W = 240, H = 135;

/** Le monde du test : généré, quelques ticks, puis la bande de toutes les matières. */
function scene(): Mirror {
  const e = new Engine(W, H, 1234);
  terrain(e, 7);
  for (let t = 0; t < 20; t++) e.step();
  e.explode(W >> 1, H >> 1, 9);
  e.step();
  const grid = {
    width: W, height: H, ambient: e.ambient,
    cells: e.cells.slice(), life: e.life.slice(), frozen: e.frozen.slice(), noise: e.noise.slice(),
    // Brutes, comme dans le miroir de la page (world.ts).
    temp: e.temp.slice(), press: e.press.slice(),
  };
  const ids = Object.values(MATERIALS).map((m) => m.id);
  for (let y = 0; y < 30; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      grid.cells[i] = ids[(x >> 2) % ids.length];
      grid.life[i] = (x * 7 + y * 13) % 251;
      grid.frozen[i] = y % 5 === 0 ? 1 : 0;
      grid.temp[i] = -100 + y * 50;
      grid.press[i] = y < 10 ? ((x + y * W) % 256) / AIR_LEVELS : 0; // tous les paliers, saturation comprise
    }
  }
  return grid;
}

/** Relit le canvas WebGL2 (même contexte, `preserveDrawingBuffer`), rangées remises dans le sens de la grille. */
function readGl(canvas: HTMLCanvasElement): Uint8Array {
  const gl = canvas.getContext("webgl2")!;
  const raw = new Uint8Array(W * H * 4);
  gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, raw);
  const out = new Uint8Array(raw.length);
  for (let y = 0; y < H; y++) out.set(raw.subarray((H - 1 - y) * W * 4, (H - y) * W * 4), y * W * 4);
  return out;
}

/** Colorie `grid` des deux façons et compte les écarts. */
function compare(name: string, screen: Screen, grid: Grid, view: View, tint: Tint): Case {
  screen.paint(grid, 0, 0, W, H, view, false, tint);
  const gpu = readGl(canvas);
  const cpu = new Renderer(grid);
  cpu.view = view;
  cpu.tint = tint;
  cpu.draw();
  let differ = 0, worst = 0, first: string | null = null;
  for (let i = 0; i < W * H; i++) {
    let gap = 0;
    for (let c = 0; c < 3; c++) gap = Math.max(gap, Math.abs(gpu[i * 4 + c] - cpu.pixels[i * 4 + c]));
    if (gap === 0) continue;
    differ++;
    worst = Math.max(worst, gap);
    first ??= `(${i % W}, ${Math.floor(i / W)}) matière ${grid.cells[i]}, life ${grid.life[i]}, ${grid.temp[i]} °C : `
      + `shader ${[...gpu.subarray(i * 4, i * 4 + 3)]}, Renderer ${[...cpu.pixels.subarray(i * 4, i * 4 + 3)]}`;
  }
  return { name, differ, worst, first };
}

const canvas = document.querySelector<HTMLCanvasElement>("#gl")!;
canvas.width = W;
canvas.height = H;
const screen = createScreen(canvas);
const grid = scene();
const cases: Case[] = [];
if (screen.kind === "webgl2") {
  for (const [hour, tint] of Object.entries(HOURS)) cases.push(compare(hour, screen, grid, "matter", tint));
  cases.push(compare("thermique", screen, grid, "heat", HOURS["apres-midi"]));
  cases.push(compare("pression", screen, grid, "air", HOURS["apres-midi"]));
  grid.ambient = -40;
  cases.push(compare("thermique à -40 °C", screen, grid, "heat", HOURS["apres-midi"]));
}
window.screenReport = { kind: screen.kind, pixels: W * H, cases };
document.querySelector("#out")!.textContent = JSON.stringify(window.screenReport, null, 2);
