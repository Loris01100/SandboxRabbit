/**
 * Sérialisation d'une grille : RLE puis base64.
 * Un monde de 320x180 majoritairement vide tient en quelques centaines d'octets,
 * ce qui rentre sans souci dans une colonne D1 plus tard.
 *
 * Des blocs séparés par des points : la matière, le figé, puis `life` et la
 * température quand on veut sauver l'état vivant (un incendie enregistré doit
 * repartir chaud). Un monde d'avant, avec un bloc ou deux, reste lisible : les
 * blocs absents valent zéro.
 *
 * La température est ramenée à un octet par pas de 8 °C depuis -60 : la
 * diffusion est continue, personne ne verra la marche.
 *
 * Base64 **url** (`-` et `_`, sans `=`) : les trois seuls caractères du base64
 * classique qu'`encodeURIComponent` échappe, à trois caractères pièce. Un lien
 * de partage tenait le tiers de sa longueur en `%2F`.
 *
 * Une longueur de 0 est une échappe : les deux octets suivants portent un
 * compte sur 16 bits. Sans elle, un ciel vide coûtait une paire tous les 255
 * pixels. L'encodeur d'avant n'écrivait jamais 0, donc les mondes déjà
 * enregistrés se relisent sans rien changer.
 */

/** Pas de quantification de la température, en °C. */
const STEP = 8;
/** Température la plus froide représentable. */
const FLOOR = -60;

export function encode(cells: Uint8Array, frozen?: Uint8Array, life?: Uint8Array, temp?: Float32Array): string {
  const blocks = [rle(cells)];
  // Les blocs sont positionnels : garder `life` impose d'écrire le figé, même vide.
  if (life && temp) {
    blocks.push(rle(frozen ?? new Uint8Array(cells.length)), rle(life), rle(bytes(temp)));
  } else if (frozen?.some(Boolean)) {
    blocks.push(rle(frozen));
  }
  return blocks.join(".");
}

function bytes(temp: Float32Array): Uint8Array {
  const out = new Uint8Array(temp.length);
  for (let i = 0; i < temp.length; i++) {
    const v = Math.round((temp[i] - FLOOR) / STEP);
    out[i] = v < 0 ? 0 : v > 255 ? 255 : v;
  }
  return out;
}

export function decode(data: string, size: number): Uint8Array {
  return unrle(data.split(".")[0], size);
}

/** Le second bloc, ou une grille vide pour un monde sauvegardé sans figé. */
export function decodeFrozen(data: string, size: number): Uint8Array {
  const block = data.split(".")[1];
  return block ? unrle(block, size) : new Uint8Array(size);
}

/** Le troisième bloc (`life`), ou null pour un monde enregistré sans lui. */
export function decodeLife(data: string, size: number): Uint8Array | null {
  const block = data.split(".")[2];
  return block ? unrle(block, size) : null;
}

/** Le quatrième bloc (températures), ou null. */
export function decodeTemp(data: string, size: number): Float32Array | null {
  const block = data.split(".")[3];
  if (!block) return null;
  const raw = unrle(block, size);
  const temp = new Float32Array(raw.length);
  for (let i = 0; i < raw.length; i++) temp[i] = raw[i] * STEP + FLOOR;
  return temp;
}

function rle(cells: Uint8Array): string {
  const out: number[] = [];
  const push = (id: number, run: number) => {
    if (run < 255) out.push(id, run);
    else out.push(id, 0, run & 255, run >> 8);
  };
  let id = cells[0], run = 0;
  for (let i = 0; i < cells.length; i++) {
    if (cells[i] === id && run < 65535) { run++; continue; }
    push(id, run);
    id = cells[i];
    run = 1;
  }
  push(id, run);
  let binary = "";
  for (let i = 0; i < out.length; i += 4096) {
    binary += String.fromCharCode(...out.slice(i, i + 4096));
  }
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

/**
 * Un flux tronqué (monde corrompu, lien coupé) ne décrit qu'un préfixe de la
 * grille : on renvoie ce préfixe tel quel plutôt qu'un tableau de la taille
 * demandée complété de vide, pour que l'appelant (`adopt`, `.set()`) ne pose
 * que ce qui est décrit et laisse le reste de la grille en place.
 */
function unrle(data: string, size: number): Uint8Array {
  const binary = atob(data.replaceAll("-", "+").replaceAll("_", "/"));
  const cells = new Uint8Array(size);
  let at = 0;
  for (let i = 0; i + 1 < binary.length; ) {
    const id = binary.charCodeAt(i);
    let run = binary.charCodeAt(i + 1);
    i += 2;
    if (run === 0) {
      run = binary.charCodeAt(i) | (binary.charCodeAt(i + 1) << 8);
      i += 2;
    }
    cells.fill(id, at, Math.min(at + run, size));
    at += run;
    if (at >= size) { at = size; break; }
  }
  return at >= size ? cells : cells.slice(0, at);
}
