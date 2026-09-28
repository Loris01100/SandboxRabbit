/**
 * La piste « carte graphique » de `npm run directions`, qui ne se mesure que
 * dans un navigateur : ouvrir test/gpu.html pendant `npm run dev`.
 *
 * Mêmes noyaux que directions-kernels.ts, reformulés pour le GPU :
 * - le sable en **blocs de Margolus** : chaque fil traite un carré 2×2, le
 *   quadrillage se décale d'une cellule à chaque tick. Il n'y a plus de
 *   balayage ni d'horloge — deux grains ne peuvent pas viser la même case, ils
 *   sont dans le même carré. C'est la réécriture qu'imposerait le moteur ;
 * - la chaleur telle quelle : un fil par cellule, deux tampons qui alternent.
 *
 * Dans un carré, `a b` en haut et `c d` en bas ; 0 vide, 1 sable, 2 pierre ;
 * `p` = (largeur, hauteur, décalage du quadrillage, tick).
 *
 * Le temps compte des lots de ticks attendus par `onSubmittedWorkDone()` : le
 * rythme réel du GPU, sans relire la grille (qui resterait sur la carte).
 * Pas de types WebGPU installés : l'API est typée à la main, au minimum.
 */

type Gpu = any;

const out = document.querySelector<HTMLPreElement>("#out")!;
const say = (line: string) => { out.textContent += `${line}\n`; };

const SAND = /* wgsl */ `
@group(0) @binding(0) var<storage, read_write> cells: array<u32>;
@group(0) @binding(1) var<uniform> p: vec4<u32>;

fn hash(a: u32) -> u32 {
  var h = a * 747796405u + 2891336453u;
  h = ((h >> ((h >> 28u) + 4u)) ^ h) * 277803737u;
  return (h >> 22u) ^ h;
}

@compute @workgroup_size(16, 16)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  let w = p.x; let h = p.y; let o = p.z;
  let x = id.x * 2u + o; let y = id.y * 2u + o;
  if (x + 1u >= w || y + 1u >= h) { return; }
  let i = y * w + x;
  var a = cells[i]; var b = cells[i + 1u]; var c = cells[i + w]; var d = cells[i + w + 1u];
  if (a == 1u && c == 0u) { c = 1u; a = 0u; }
  if (b == 1u && d == 0u) { d = 1u; b = 0u; }
  let r = hash(i ^ (p.w * 2654435761u)) & 1u;
  if (a == 1u && c != 0u && d == 0u && (b == 0u || r == 0u)) { d = 1u; a = 0u; }
  else if (b == 1u && d != 0u && c == 0u && (a == 0u || r == 1u)) { c = 1u; b = 0u; }
  cells[i] = a; cells[i + 1u] = b; cells[i + w] = c; cells[i + w + 1u] = d;
}`;

const HEAT = /* wgsl */ `
@group(0) @binding(0) var<storage, read> src: array<f32>;
@group(0) @binding(1) var<storage, read_write> dst: array<f32>;
@group(0) @binding(2) var<uniform> p: vec4<u32>;

@compute @workgroup_size(16, 16)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  let w = p.x; let h = p.y;
  if (id.x >= w || id.y >= h) { return; }
  let i = id.y * w + id.x;
  let t = src[i];
  var s = 0.0;
  if (id.y > 0u) { s += src[i - w]; } else { s += t; }
  if (id.y < h - 1u) { s += src[i + w]; } else { s += t; }
  if (id.x > 0u) { s += src[i - 1u]; } else { s += t; }
  if (id.x < w - 1u) { s += src[i + 1u]; } else { s += t; }
  dst[i] = t + 0.16 * (s - 4.0 * t) + 0.02 * (20.0 - t);
}`;

/** STORAGE | COPY_DST, UNIFORM | COPY_DST : les drapeaux de `GPUBufferUsage`, sans les types. */
const STORAGE = 0x80 | 0x08, UNIFORM = 0x40 | 0x08;

/** Chronomètre `ticks` ticks d'un noyau : un lot soumis d'un coup, attendu une fois. */
async function time(device: Gpu, ticks: number, encode: (tick: number, pass: Gpu) => void): Promise<number> {
  const batch = async (n: number, from: number) => {
    const encoder = device.createCommandEncoder();
    for (let t = 0; t < n; t++) {
      const pass = encoder.beginComputePass();
      encode(from + t, pass);
      pass.end();
    }
    device.queue.submit([encoder.finish()]);
    await device.queue.onSubmittedWorkDone();
  };
  await batch(10, 0);
  const t0 = performance.now();
  await batch(ticks, 10);
  return (performance.now() - t0) / ticks;
}

async function measure(device: Gpu, w: number, h: number): Promise<{ sand: number; heat: number }> {
  const n = w * h;
  const cells = new Uint32Array(n);
  const top = Math.floor(h * 0.1), bottom = Math.floor(h * 0.43);
  cells.fill(1, top * w, bottom * w);
  cells.fill(2, (h - 8) * w);
  const temp = new Float32Array(n).map((_, i) => 20 + ((i * 2654435761) >>> 24));

  const buffer = (data: ArrayBufferView, usage: number) => {
    const b = device.createBuffer({ size: data.byteLength, usage });
    device.queue.writeBuffer(b, 0, data);
    return b;
  };
  const grid = buffer(cells, STORAGE);
  const a = buffer(temp, STORAGE), b = buffer(temp, STORAGE);

  const sandPipe = device.createComputePipeline({ layout: "auto", compute: { module: device.createShaderModule({ code: SAND }), entryPoint: "main" } });
  const params = [0, 1].map((o) => buffer(new Uint32Array([w, h, o, 0]), UNIFORM));
  const sandGroups = params.map((u) => device.createBindGroup({
    layout: sandPipe.getBindGroupLayout(0),
    entries: [{ binding: 0, resource: { buffer: grid } }, { binding: 1, resource: { buffer: u } }],
  }));
  const sand = await time(device, 120, (tick, pass) => {
    pass.setPipeline(sandPipe);
    pass.setBindGroup(0, sandGroups[tick & 1]);
    pass.dispatchWorkgroups(Math.ceil(w / 32), Math.ceil(h / 32));
  });

  const heatPipe = device.createComputePipeline({ layout: "auto", compute: { module: device.createShaderModule({ code: HEAT }), entryPoint: "main" } });
  const size = buffer(new Uint32Array([w, h, 0, 0]), UNIFORM);
  const heatGroups = [[a, b], [b, a]].map(([s, d]) => device.createBindGroup({
    layout: heatPipe.getBindGroupLayout(0),
    entries: [{ binding: 0, resource: { buffer: s } }, { binding: 1, resource: { buffer: d } }, { binding: 2, resource: { buffer: size } }],
  }));
  const heat = await time(device, 120, (tick, pass) => {
    pass.setPipeline(heatPipe);
    pass.setBindGroup(0, heatGroups[tick & 1]);
    pass.dispatchWorkgroups(Math.ceil(w / 16), Math.ceil(h / 16));
  });

  for (const x of [grid, a, b, size, ...params]) x.destroy();
  return { sand, heat };
}

async function main(): Promise<void> {
  out.textContent = "";
  const gpu = (navigator as unknown as { gpu?: Gpu }).gpu;
  const adapter = await gpu?.requestAdapter();
  if (!adapter) { say("WebGPU indisponible dans ce navigateur : la piste GPU exigerait un moteur de secours."); return; }
  const info = adapter.info ?? {};
  say(`Carte : ${info.vendor ?? "?"} ${info.architecture ?? ""} ${info.description ?? ""}`.trim());
  const device = await adapter.requestDevice({
    requiredLimits: { maxStorageBufferBindingSize: adapter.limits.maxStorageBufferBindingSize, maxBufferSize: adapter.limits.maxBufferSize },
  });
  say(`${"grille".padEnd(12)} ${"sable".padStart(10)} ${"chaleur".padStart(10)}   ticks/s (les deux)`);
  for (const [w, h] of [[1920, 1080], [3840, 2160], [7680, 4320]]) {
    if (w * h * 4 > adapter.limits.maxStorageBufferBindingSize) { say(`${w}×${h}`.padEnd(12) + "  trop grand pour cette carte"); continue; }
    const m = await measure(device, w, h);
    say(`${`${w}×${h}`.padEnd(12)} ${`${m.sand.toFixed(3)} ms`.padStart(10)} ${`${m.heat.toFixed(3)} ms`.padStart(10)}   ${Math.round(1000 / (m.sand + m.heat))}`);
  }
  say("\nComparer à « 1 cœur » de `npm run directions` (même grille 1920×1080, même travail).");
}

void main();
