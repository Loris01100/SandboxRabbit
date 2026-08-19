/**
 * Sérialisation d'une grille : RLE puis base64.
 * Un monde de 320x180 majoritairement vide tient en quelques centaines d'octets,
 * ce qui rentre sans souci dans une colonne D1 plus tard.
 *
 * Deux blocs séparés par un point : la matière, puis le figé s'il y en a. Un
 * monde d'avant (sans point) reste lisible, son figé est simplement vide.
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

export function encode(cells: Uint8Array, frozen?: Uint8Array): string {
  return frozen?.some(Boolean) ? rle(cells) + "." + rle(frozen) : rle(cells);
}

export function decode(data: string, size: number): Uint8Array {
  return unrle(data.split(".")[0], size);
}

/** Le second bloc, ou une grille vide pour un monde sauvegardé sans figé. */
export function decodeFrozen(data: string, size: number): Uint8Array {
  const block = data.split(".")[1];
  return block ? unrle(block, size) : new Uint8Array(size);
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
    if (at >= size) break;
  }
  return cells;
}
