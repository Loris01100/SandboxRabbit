/**
 * L'écran du bac : colorie le miroir de la grille (world.ts) dans le canvas.
 *
 * Deux façons, une interface :
 * - **WebGL2** : la grille monte en textures entières (matière, `life`, figé,
 *   grain, température au degré), et un shader colorie chaque pixel. Le Worker
 *   ne colorie plus rien — 6 ms par tick de gagnés en 1920×1080 chargé — et la
 *   page ne fait qu'envoyer à la carte le rectangle changé ;
 * - **2D** : le secours d'un navigateur sans WebGL2, le même `Renderer` qu'en
 *   test, puis un `putImageData` du rectangle changé.
 *
 * Le shader est la **copie** de `Renderer.shade()` / `shadeHeat()` (render.ts),
 * mêmes constantes et mêmes arrondis : une règle d'aspect changée d'un côté
 * l'est de l'autre. `preserveDrawingBuffer` garde l'image entre deux frames —
 * le PNG et la vidéo (share.ts) la relisent par `drawImage(canvas)`.
 *
 * ponytail: une perte de contexte WebGL (pilote qui redémarre) laisse le bac
 * noir jusqu'au rechargement. Écouter `webglcontextlost` / `restored` et tout
 * remonter le jour où ça se voit.
 */
import { GLOW, GLOWING, Renderer, palette, type Grid } from "./sim/render.ts";

export interface Screen {
  /** « webgl2 » ou « 2d » : ce qui colorie, pour le dire à qui le demande. */
  readonly kind: "webgl2" | "2d";
  /** Repose le rectangle (x0, y0)–(x1, y1) exclus de `grid` ; une autre grille (nouvelle taille) repart d'une image entière. */
  paint(grid: Grid, x0: number, y0: number, x1: number, y1: number, heatmap: boolean): void;
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

const FRAGMENT = `#version 300 es
precision highp float;
precision highp int;
uniform highp usampler2D cells;
uniform highp usampler2D life;
uniform highp usampler2D frozen;
uniform highp isampler2D noise;
uniform highp isampler2D temp;
uniform highp usampler2D palette;
uniform float ambient;
uniform bool heatmap;
uniform ivec4 glowing;
out vec4 color;

void main() {
  ivec2 size = textureSize(cells, 0);
  ivec2 p = ivec2(int(gl_FragCoord.x), size.y - 1 - int(gl_FragCoord.y));
  float t = float(texelFetch(temp, p, 0).r);
  vec3 c;
  if (heatmap) {
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
  if (lit > 0.0) c = floor(min(c + vec3(170.0, 95.0, 25.0) * lit, 255.0));
  color = vec4(c / 255.0, 1.0);
}`;

/** Les tableaux du miroir montés en textures, une unité de texture chacun dans cet ordre ; la palette prend l'unité suivante. */
const LAYERS = ["cells", "life", "frozen", "noise", "temp"] as const;

function glScreen(gl: WebGL2RenderingContext): Screen {
  const compile = (type: number, source: string) => {
    const shader = gl.createShader(type)!;
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader) ?? "shader");
    return shader;
  };
  const program = gl.createProgram()!;
  gl.attachShader(program, compile(gl.VERTEX_SHADER, VERTEX));
  gl.attachShader(program, compile(gl.FRAGMENT_SHADER, FRAGMENT));
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program) ?? "programme");
  gl.useProgram(program);
  gl.bindVertexArray(gl.createVertexArray());
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);

  const formats: Record<(typeof LAYERS)[number], [number, number]> = {
    cells: [gl.R8UI, gl.UNSIGNED_BYTE],
    life: [gl.R8UI, gl.UNSIGNED_BYTE],
    frozen: [gl.R8UI, gl.UNSIGNED_BYTE],
    noise: [gl.R8I, gl.BYTE],
    temp: [gl.R16I, gl.SHORT],
  };
  /** Une texture sans filtrage (les textures entières l'exigent), liée à `unit` et à l'échantillonneur `name` du shader. */
  const texture = (unit: number, name: string) => {
    const t = gl.createTexture()!;
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.uniform1i(gl.getUniformLocation(program, name), unit);
    return t;
  };
  let textures: WebGLTexture[] = [];
  texture(LAYERS.length, "palette");
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8UI, 256, 1, 0, gl.RGBA_INTEGER, gl.UNSIGNED_BYTE, palette());
  gl.uniform4i(gl.getUniformLocation(program, "glowing"), ...GLOWING);
  const ambient = gl.getUniformLocation(program, "ambient");
  const heatmap = gl.getUniformLocation(program, "heatmap");

  let w = 0, h = 0;
  return {
    kind: "webgl2",
    paint(grid, x0, y0, x1, y1, heat) {
      if (grid.width !== w || grid.height !== h) {
        w = grid.width; h = grid.height;
        x0 = 0; y0 = 0; x1 = w; y1 = h;
        for (const t of textures) gl.deleteTexture(t);
        textures = LAYERS.map((name, unit) => {
          const t = texture(unit, name);
          gl.texStorage2D(gl.TEXTURE_2D, 1, formats[name][0], w, h);
          return t;
        });
      }
      if (x1 > x0 && y1 > y0) {
        gl.pixelStorei(gl.UNPACK_ROW_LENGTH, w);
        gl.pixelStorei(gl.UNPACK_SKIP_PIXELS, x0);
        gl.pixelStorei(gl.UNPACK_SKIP_ROWS, y0);
        LAYERS.forEach((name, unit) => {
          gl.activeTexture(gl.TEXTURE0 + unit);
          gl.bindTexture(gl.TEXTURE_2D, textures[unit]);
          gl.texSubImage2D(gl.TEXTURE_2D, 0, x0, y0, x1 - x0, y1 - y0, gl.RED_INTEGER, formats[name][1], grid[name] as unknown as ArrayBufferView);
        });
        gl.pixelStorei(gl.UNPACK_ROW_LENGTH, 0);
        gl.pixelStorei(gl.UNPACK_SKIP_PIXELS, 0);
        gl.pixelStorei(gl.UNPACK_SKIP_ROWS, 0);
      }
      gl.uniform1f(ambient, grid.ambient);
      gl.uniform1i(heatmap, heat ? 1 : 0);
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
    paint(grid, x0, y0, x1, y1, heat) {
      if (grid !== of || !renderer || !image) {
        of = grid;
        renderer = new Renderer(grid);
        image = new ImageData(renderer.pixels as Uint8ClampedArray<ArrayBuffer>, grid.width, grid.height);
        x0 = 0; y0 = 0; x1 = grid.width; y1 = grid.height;
      }
      if (x1 <= x0 || y1 <= y0) return;
      renderer.heatmap = heat;
      renderer.paint(x0, y0, x1, y1);
      ctx.putImageData(image, 0, 0, x0, y0, x1 - x0, y1 - y0);
    },
  };
}
