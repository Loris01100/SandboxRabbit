/**
 * L'écran du bac : colorie le miroir de la grille (world.ts) dans le canvas.
 *
 * Deux façons, une interface :
 * - **WebGL2** : la grille monte en textures (matière, `life`, figé, grain,
 *   température au degré, pression par palier), et un shader colorie chaque pixel. Le Worker
 *   ne colorie plus rien — 6 ms par tick de gagnés en 1920×1080 chargé — et la
 *   page ne fait qu'envoyer à la carte le rectangle changé ;
 * - **2D** : le secours d'un navigateur sans WebGL2, le même `Renderer` qu'en
 *   test, puis un `putImageData` du rectangle changé.
 *
 * WebGL2 ajoute l'éclairage global (voir `SCENE`) : quelques passes de plus,
 * sur tout le bac, à chaque frame qui arrive.
 *
 * Le shader est la **copie** de `Renderer.shade()` / `shadeHeat()` / `shadeAir()` (render.ts),
 * mêmes constantes et mêmes arrondis : une règle d'aspect changée d'un côté
 * l'est de l'autre. `preserveDrawingBuffer` garde l'image entre deux frames —
 * le PNG et la vidéo (share.ts) la relisent par `drawImage(canvas)`.
 *
 * ponytail: une perte de contexte WebGL (pilote qui redémarre) laisse le bac
 * noir jusqu'au rechargement. Écouter `webglcontextlost` / `restored` et tout
 * remonter le jour où ça se voit.
 */
import { AIR_LEVELS, GLOW, GLOWING, Renderer, lighting, palette, type Grid, type Tint, type View } from "./sim/render.ts";

export interface Screen {
  /** « webgl2 » ou « 2d » : ce qui colorie, pour le dire à qui le demande. */
  readonly kind: "webgl2" | "2d";
  /**
   * Repose le rectangle (x0, y0)–(x1, y1) exclus de `grid` ; une autre grille
   * (nouvelle taille) repart d'une image entière. `lit` : éclairage global,
   * WebGL2 seulement — il recalcule tout le bac, quel que soit le rectangle.
   * `tint` : l'heure de la journée (`HOURS` de render.ts). `view` : matière,
   * vue thermique ou vue pression — les deux dernières sans éclairage.
   */
  paint(grid: Grid, x0: number, y0: number, x1: number, y1: number, view: View, lit: boolean, tint: Tint): void;
}

/** L'écran du canvas : WebGL2 s'il le peut, sinon 2D. Un canvas n'a qu'un contexte : le choix est définitif. */
export function createScreen(canvas: HTMLCanvasElement): Screen {
  const gl = canvas.getContext("webgl2", { alpha: false, antialias: false, depth: false, stencil: false, preserveDrawingBuffer: true });
  return gl ? glScreen(gl) : flatScreen(canvas);
}

const VERTEX = `#version 300 es
void main() {
  vec2 v = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2);
  gl_Position = vec4(v * 2.0 - 1.0, 0.0, 1.0);
}`;

/** Éclat de la lumière reçue, ajouté tel quel : le halo sur le fond sombre. */
const LIGHT_HALO = 160;
/** Éclat de la lumière reçue, proportionnel à la couleur : les surfaces éclairées. */
const LIGHT_GAIN = 1.5;

const FRAGMENT = `#version 300 es
precision highp float;
precision highp int;
uniform highp usampler2D cells;
uniform highp usampler2D life;
uniform highp usampler2D frozen;
uniform highp isampler2D noise;
uniform highp isampler2D temp;
uniform highp sampler2D press;
uniform highp usampler2D palette;
uniform highp usampler2D table;
uniform vec3 tint;
uniform float ambient;
uniform int view;
uniform ivec4 glowing;
uniform sampler2D light;
uniform bool lighting;
uniform int scale;
out vec4 color;

void main() {
  ivec2 size = textureSize(cells, 0);
  ivec2 p = ivec2(int(gl_FragCoord.x), size.y - 1 - int(gl_FragCoord.y));
  float t = float(texelFetch(temp, p, 0).r);
  vec3 c;
  if (view == 2) {
    int l = int(min(255.0, floor(texelFetch(press, p, 0).r * ${AIR_LEVELS.toFixed(1)} + 0.5)));
    if (l == 0) {
      ivec3 b = ivec3(texelFetch(palette, ivec2(int(texelFetch(cells, p, 0).r), 0), 0).rgb);
      c = vec3((b * 77) >> 8);
    } else {
      c = vec3(clamp(3 * l - 510, 0, 255), clamp(3 * l - 255, 0, 255), 60 + min(195, (39 * l) / 17));
    }
    color = vec4(floor(c) / 255.0, 1.0);
    return;
  }
  if (view == 1) {
    if (t < ambient) {
      float cold = clamp((ambient - t) / 60.0, 0.0, 1.0);
      c = vec3(20.0 * (1.0 - cold), 40.0 + 80.0 * cold, 60.0 + 195.0 * cold);
    } else {
      float u = clamp((t - ambient) / 1180.0, 0.0, 1.0);
      c = vec3(30.0 + 225.0 * clamp(u * 3.0, 0.0, 1.0), 255.0 * clamp(u * 3.0 - 1.0, 0.0, 1.0), 255.0 * clamp(u * 3.0 - 2.0, 0.0, 1.0));
    }
    color = vec4(floor(c) / 255.0, 1.0);
    return;
  }
  int id = int(texelFetch(cells, p, 0).r);
  uvec4 base = texelFetch(palette, ivec2(id, 0), 0);
  float warm = ambient + ${GLOW.toFixed(1)};
  float lit = t > warm ? min(1.0, (t - warm) / 400.0) : 0.0;
  c = vec3(base.rgb);
  if (id != 0) {
    int l = int(texelFetch(life, p, 0).r);
    int glow = id == glowing.x ? l >> 1
      : id == glowing.y ? (l > 0 ? 110 : 0)
      : (id == glowing.z || id == glowing.w) && l == 1 ? 55
      : 0;
    int d;
    if (texelFetch(frozen, p, 0).r != 0u) d = ((p.y * size.x + p.x + p.y) & 1) == 1 ? 45 : -45;
    else d = glow != 0 ? glow : (texelFetch(noise, p, 0).r * int(base.a)) >> 7;
    c = floor(clamp(c + float(d), 0.0, 255.0));
  }
  if (texelFetch(table, ivec2(id, 0), 0).rgb == uvec3(0u)) c = floor(c * tint);
  if (lit > 0.0) c = floor(min(c + vec3(170.0, 95.0, 25.0) * lit, 255.0));
  if (lighting) {
    vec3 l = texture(light, (vec2(p) + 0.5) / vec2(textureSize(light, 0) * scale)).rgb;
    c = min(c + l * (${LIGHT_HALO.toFixed(1)} + c * ${LIGHT_GAIN.toFixed(1)}), 255.0);
  }
  color = vec4(c / 255.0, 1.0);
}`;

/**
 * Éclairage global par *radiance cascades* (Alexander Sannikov). La lumière
 * d'un point est la somme de ce qui lui arrive de toutes les directions ;
 * au lieu de lancer mille rayons par pixel, on remarque qu'une ombre proche
 * demande beaucoup de positions et peu d'angles, une lumière lointaine
 * l'inverse. Chaque cascade `n` pose donc des sondes tous les 2ⁿ texels, avec
 * 4·4ⁿ directions, et ne marche que sur son anneau de distances
 * [(4ⁿ − 1)/3, (4ⁿ⁺¹ − 1)/3[ : toutes les cascades ont le même nombre de
 * texels, et le coût croît avec le log de la portée plutôt qu'avec elle.
 * Puis, de la plus lointaine à la plus proche, chaque rayon qui n'a rien
 * heurté hérite de la cascade du dessus (4 directions filles × 4 sondes
 * voisines, en bilinéaire).
 *
 * Tout se fait dans une grille de lumière plus grossière que le bac (au plus
 * `LIGHT_WIDTH` texels de large), étirée en bilinéaire au mélange final :
 * 1. `SCENE` : chaque texel de lumière moyenne ses cellules — émission
 *    prémultipliée par l'opacité, opacité — puis mipmaps, où les cascades
 *    lointaines, qui marchent à grands pas, lisent ;
 * 2. `CASCADE`, de la dernière à la première ;
 * 3. `FLUENCE` : moyenne des 4 directions de la cascade 0 → texture `light`,
 *    que `FRAGMENT` ajoute à la couleur. Un texel opaque prend la lumière de
 *    son voisin non opaque le plus éclairé : sa propre sonde, enfermée dans
 *    le mur, ne voit rien — la pierre au bord de la lave restait noire. Un
 *    texel opaque qui brille, lui, ne reçoit rien : la lumière de son voisin
 *    est la sienne, et le bord d'une mer de lave virait au jaune saturé.
 *
 * ponytail: cascades « à la vanille », sans la correction bilinéaire des
 * rayons : de légers anneaux autour d'une petite flamme isolée, et un mur
 * fin fuit un peu vu de loin (mipmaps). Passer au *bilinear fix* le jour où
 * ça se remarque.
 */
const SCENE = `#version 300 es
precision highp float;
precision highp int;
uniform highp usampler2D cells;
uniform highp isampler2D temp;
uniform highp usampler2D table;
uniform int scale;
out vec4 color;

void main() {
  ivec2 size = textureSize(cells, 0);
  ivec2 o = ivec2(gl_FragCoord.xy) * scale;
  vec4 sum = vec4(0.0);
  float n = 0.0;
  for (int y = 0; y < scale; y++) for (int x = 0; x < scale; x++) {
    ivec2 p = o + ivec2(x, y);
    if (p.x >= size.x || p.y >= size.y) continue;
    int id = int(texelFetch(cells, p, 0).r);
    vec4 m = vec4(texelFetch(table, ivec2(id, 0), 0)) / 255.0;
    float t = float(texelFetch(temp, p, 0).r);
    if (id != 0 && t > 450.0) m.rgb = max(m.rgb, vec3(1.0, 0.45, 0.1) * min(1.0, (t - 450.0) / 700.0));
    sum += vec4(m.rgb * m.a, m.a);
    n += 1.0;
  }
  color = sum / max(n, 1.0);
}`;

const CASCADE = `#version 300 es
precision highp float;
precision highp int;
uniform sampler2D scene;
uniform sampler2D upper;
uniform int level;
uniform bool top;
uniform vec2 size;
out vec4 color;

void main() {
  ivec2 t = ivec2(gl_FragCoord.xy);
  int side = 2 << level;
  ivec2 probe = t / side;
  ivec2 q = t % side;
  int d = q.y * side + q.x;
  float angle = (float(d) + 0.5) * 6.28318531 / float(side * side);
  vec2 dir = vec2(cos(angle), sin(angle));
  vec2 origin = (vec2(probe) + 0.5) * float(1 << level);
  float near = float((1 << (2 * level)) - 1) / 3.0;
  float far = float((1 << (2 * level + 2)) - 1) / 3.0;
  float stride = float(max(1, (1 << level) >> 1));
  float lod = log2(stride);
  vec3 rad = vec3(0.0);
  float through = 1.0;
  for (float s = near + stride * 0.5; s < far; s += stride) {
    vec2 p = origin + dir * s;
    if (p.x < 0.0 || p.y < 0.0 || p.x >= size.x || p.y >= size.y) break;
    vec4 m = textureLod(scene, p / size, lod);
    float pass = pow(1.0 - m.a, stride);
    if (m.a > 0.0) rad += through * m.rgb / m.a * (1.0 - pass);
    through *= pass;
    if (through < 0.01) break;
  }
  if (!top && through >= 0.01) {
    int up = side * 2;
    ivec2 count = textureSize(upper, 0) / up;
    vec2 u = origin / float(2 << level) - 0.5;
    ivec2 i0 = ivec2(floor(u));
    vec2 f = u - floor(u);
    vec3 sum = vec3(0.0);
    for (int k = 0; k < 4; k++) {
      ivec2 corner = clamp(i0 + ivec2(k & 1, k >> 1), ivec2(0), count - 1);
      float w = ((k & 1) == 1 ? f.x : 1.0 - f.x) * ((k >> 1) == 1 ? f.y : 1.0 - f.y);
      for (int c = 0; c < 4; c++) {
        int child = d * 4 + c;
        sum += w * texelFetch(upper, corner * up + ivec2(child % up, child / up), 0).rgb;
      }
    }
    rad += through * sum * 0.25;
  }
  color = vec4(rad, 1.0);
}`;

const FLUENCE = `#version 300 es
precision highp float;
precision highp int;
uniform sampler2D upper;
uniform sampler2D scene;
out vec4 color;

vec3 at(ivec2 t) {
  ivec2 p = t * 2;
  return (texelFetch(upper, p, 0).rgb + texelFetch(upper, p + ivec2(1, 0), 0).rgb
    + texelFetch(upper, p + ivec2(0, 1), 0).rgb + texelFetch(upper, p + ivec2(1, 1), 0).rgb) * 0.25;
}

void main() {
  ivec2 t = ivec2(gl_FragCoord.xy);
  ivec2 size = textureSize(scene, 0);
  vec4 self = texelFetch(scene, t, 0);
  if (self.a < 0.5) {
    color = vec4(at(t), 1.0);
    return;
  }
  if (max(self.r, max(self.g, self.b)) > 0.1) {
    color = vec4(0.0, 0.0, 0.0, 1.0);
    return;
  }
  vec3 best = vec3(0.0);
  for (int k = 0; k < 9; k++) {
    ivec2 n = t + ivec2(k % 3 - 1, k / 3 - 1);
    if (k == 4 || any(lessThan(n, ivec2(0))) || any(greaterThanEqual(n, size))) continue;
    if (texelFetch(scene, n, 0).a < 0.5) best = max(best, at(n));
  }
  color = vec4(best, 1.0);
}`;

/** Largeur maximale de la grille de lumière, en texels : au-delà, un texel couvre plusieurs cellules. */
const LIGHT_WIDTH = 480;
/** Nombre maximal de cascades : la dernière porte à (4⁶ − 1)/3 = 1365 texels. */
const CASCADES = 6;

/** Les tableaux du miroir montés en textures, une unité de texture chacun dans cet ordre ; la palette et l'éclairage prennent les suivantes. */
const LAYERS = ["cells", "life", "frozen", "noise", "temp", "press"] as const;

/** Une cible de rendu de l'éclairage : sa texture, son framebuffer, sa taille. */
interface Target { texture: WebGLTexture; fb: WebGLFramebuffer; w: number; h: number }

function glScreen(gl: WebGL2RenderingContext): Screen {
  const compile = (type: number, source: string) => {
    const shader = gl.createShader(type)!;
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader) ?? "shader");
    return shader;
  };
  const vertex = compile(gl.VERTEX_SHADER, VERTEX);
  /** Un programme plein écran, ses échantillonneurs liés chacun à son unité de texture. */
  const link = (fragment: string, units: Record<string, number>) => {
    const p = gl.createProgram()!;
    gl.attachShader(p, vertex);
    gl.attachShader(p, compile(gl.FRAGMENT_SHADER, fragment));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p) ?? "programme");
    gl.useProgram(p);
    for (const [name, unit] of Object.entries(units)) gl.uniform1i(gl.getUniformLocation(p, name), unit);
    return p;
  };
  const PALETTE = LAYERS.length, LIGHT = PALETTE + 1, TABLE = LIGHT + 1, SCENE_UNIT = TABLE + 1, UPPER = SCENE_UNIT + 1;
  const scene = link(SCENE, { cells: 0, temp: 4, table: TABLE });
  const cascade = link(CASCADE, { scene: SCENE_UNIT, upper: UPPER });
  const fluence = link(FLUENCE, { upper: UPPER, scene: SCENE_UNIT });
  const program = link(FRAGMENT, { ...Object.fromEntries(LAYERS.map((name, unit) => [name, unit])), palette: PALETTE, light: LIGHT, table: TABLE });
  gl.bindVertexArray(gl.createVertexArray());
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);

  /** Format interne, type et format des données de chaque couche. La pression, flottante, n'est lue qu'au texel près (`NEAREST`). */
  const formats: Record<(typeof LAYERS)[number], [number, number, number]> = {
    cells: [gl.R8UI, gl.UNSIGNED_BYTE, gl.RED_INTEGER],
    life: [gl.R8UI, gl.UNSIGNED_BYTE, gl.RED_INTEGER],
    frozen: [gl.R8UI, gl.UNSIGNED_BYTE, gl.RED_INTEGER],
    noise: [gl.R8I, gl.BYTE, gl.RED_INTEGER],
    temp: [gl.R16I, gl.SHORT, gl.RED_INTEGER],
    press: [gl.R32F, gl.FLOAT, gl.RED],
  };
  /** Une texture liée à `unit`, filtrée `filter` (les textures entières exigent `NEAREST`). */
  const texture = (unit: number, filter: number = gl.NEAREST) => {
    const t = gl.createTexture()!;
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter === gl.LINEAR ? gl.LINEAR : gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return t;
  };
  let textures: WebGLTexture[] = [];
  texture(PALETTE);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8UI, 256, 1, 0, gl.RGBA_INTEGER, gl.UNSIGNED_BYTE, palette());
  texture(TABLE);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8UI, 256, 1, 0, gl.RGBA_INTEGER, gl.UNSIGNED_BYTE, lighting());
  gl.useProgram(program);
  gl.uniform4i(gl.getUniformLocation(program, "glowing"), ...GLOWING);
  const ambient = gl.getUniformLocation(program, "ambient");
  const viewAt = gl.getUniformLocation(program, "view");
  const lightingOn = gl.getUniformLocation(program, "lighting");
  const drawScale = gl.getUniformLocation(program, "scale");
  const tintAt = gl.getUniformLocation(program, "tint");
  const sceneScale = gl.getUniformLocation(scene, "scale");
  const level = gl.getUniformLocation(cascade, "level");
  const top = gl.getUniformLocation(cascade, "top");
  const lightSize = gl.getUniformLocation(cascade, "size");

  /**
   * Demi-flottants quand la carte sait y dessiner (presque partout) : en
   * octets, un halo faible s'échelonne en paliers visibles.
   */
  const hdr = gl.getExtension("EXT_color_buffer_float") !== null;
  /** Une cible de rendu : sa texture, liée à `unit`, et son framebuffer. */
  const target = (unit: number, tw: number, th: number, format: number, filter: number, levels = 1): Target => {
    const t = texture(unit, filter);
    gl.texStorage2D(gl.TEXTURE_2D, levels, format, tw, th);
    const fb = gl.createFramebuffer()!;
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return { texture: t, fb, w: tw, h: th };
  };
  /** Ce que lit la dernière cascade, qui n'a pas de dessus : un texel noir, jamais la texture où elle écrit. */
  const none = target(UPPER, 1, 1, gl.RGBA8, gl.NEAREST);
  let lights: { scale: number; scene: Target; cascades: Target[]; light: Target } | null = null;

  /** Refait les cibles de l'éclairage pour un bac `bw` × `bh`. */
  const resize = (bw: number, bh: number) => {
    for (const old of lights ? [lights.scene, lights.light, ...lights.cascades] : []) {
      gl.deleteTexture(old.texture);
      gl.deleteFramebuffer(old.fb);
    }
    const scale = Math.ceil(bw / LIGHT_WIDTH);
    const lw = Math.ceil(bw / scale), lh = Math.ceil(bh / scale);
    const format = hdr ? gl.RGBA16F : gl.RGBA8;
    let count = 1;
    while (count < CASCADES && (4 ** count - 1) / 3 < Math.hypot(lw, lh)) count++;
    const cascades: Target[] = [];
    for (let n = 0; n < count; n++) {
      const side = 2 << n;
      cascades.push(target(UPPER, Math.ceil(lw / (1 << n)) * side, Math.ceil(lh / (1 << n)) * side, format, gl.NEAREST));
    }
    const levels = Math.floor(Math.log2(Math.max(lw, lh))) + 1;
    lights = {
      scale,
      scene: target(SCENE_UNIT, lw, lh, gl.RGBA8, gl.NEAREST_MIPMAP_NEAREST, levels),
      cascades,
      light: target(LIGHT, lw, lh, format, gl.LINEAR),
    };
  };

  /** Une passe plein écran de `p` dans `into`. */
  const pass = (p: WebGLProgram, into: Target) => {
    gl.useProgram(p);
    gl.bindFramebuffer(gl.FRAMEBUFFER, into.fb);
    gl.viewport(0, 0, into.w, into.h);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  };
  /** Refait toute la lumière du bac depuis les textures de la grille, jusqu'à la texture `light`. */
  const illuminate = () => {
    const { scale, scene: into, cascades, light } = lights!;
    gl.useProgram(scene);
    gl.uniform1i(sceneScale, scale);
    pass(scene, into);
    gl.activeTexture(gl.TEXTURE0 + SCENE_UNIT);
    gl.bindTexture(gl.TEXTURE_2D, into.texture);
    gl.generateMipmap(gl.TEXTURE_2D);
    gl.useProgram(cascade);
    gl.uniform2f(lightSize, into.w, into.h);
    gl.activeTexture(gl.TEXTURE0 + UPPER);
    for (let n = cascades.length - 1; n >= 0; n--) {
      const last = n === cascades.length - 1;
      gl.bindTexture(gl.TEXTURE_2D, last ? none.texture : cascades[n + 1].texture);
      gl.uniform1i(level, n);
      gl.uniform1i(top, last ? 1 : 0);
      pass(cascade, cascades[n]);
    }
    gl.bindTexture(gl.TEXTURE_2D, cascades[0].texture);
    pass(fluence, light);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  };

  let w = 0, h = 0;
  return {
    kind: "webgl2",
    paint(grid, x0, y0, x1, y1, view, lit, tint) {
      if (grid.width !== w || grid.height !== h) {
        w = grid.width; h = grid.height;
        x0 = 0; y0 = 0; x1 = w; y1 = h;
        for (const t of textures) gl.deleteTexture(t);
        textures = LAYERS.map((name, unit) => {
          const t = texture(unit);
          gl.texStorage2D(gl.TEXTURE_2D, 1, formats[name][0], w, h);
          return t;
        });
        resize(w, h);
      }
      if (x1 > x0 && y1 > y0) {
        gl.pixelStorei(gl.UNPACK_ROW_LENGTH, w);
        gl.pixelStorei(gl.UNPACK_SKIP_PIXELS, x0);
        gl.pixelStorei(gl.UNPACK_SKIP_ROWS, y0);
        LAYERS.forEach((name, unit) => {
          gl.activeTexture(gl.TEXTURE0 + unit);
          gl.bindTexture(gl.TEXTURE_2D, textures[unit]);
          gl.texSubImage2D(gl.TEXTURE_2D, 0, x0, y0, x1 - x0, y1 - y0, formats[name][2], formats[name][1], grid[name] as unknown as ArrayBufferView);
        });
        gl.pixelStorei(gl.UNPACK_ROW_LENGTH, 0);
        gl.pixelStorei(gl.UNPACK_SKIP_PIXELS, 0);
        gl.pixelStorei(gl.UNPACK_SKIP_ROWS, 0);
      }
      const on = lit && view === "matter";
      if (on) illuminate();
      gl.useProgram(program);
      gl.uniform1f(ambient, grid.ambient);
      gl.uniform1i(viewAt, view === "air" ? 2 : view === "heat" ? 1 : 0);
      gl.uniform1i(lightingOn, on ? 1 : 0);
      gl.uniform1i(drawScale, lights!.scale);
      gl.uniform3f(tintAt, ...tint);
      gl.viewport(0, 0, w, h);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    },
  };
}

/** Le secours sans WebGL2 : `Renderer` sur le miroir, puis `putImageData` du rectangle changé. */
function flatScreen(canvas: HTMLCanvasElement): Screen {
  const ctx = canvas.getContext("2d", { alpha: false })!;
  let of: Grid | null = null;
  let renderer: Renderer | null = null;
  let image: ImageData | null = null;
  return {
    kind: "2d",
    paint(grid, x0, y0, x1, y1, view, _lit, tint) {
      if (grid !== of || !renderer || !image) {
        of = grid;
        renderer = new Renderer(grid);
        image = new ImageData(renderer.pixels as Uint8ClampedArray<ArrayBuffer>, grid.width, grid.height);
        x0 = 0; y0 = 0; x1 = grid.width; y1 = grid.height;
      }
      if (x1 <= x0 || y1 <= y0) return;
      renderer.view = view;
      renderer.tint = tint;
      renderer.paint(x0, y0, x1, y1);
      ctx.putImageData(image, 0, 0, x0, y0, x1 - x0, y1 - y0);
    },
  };
}
