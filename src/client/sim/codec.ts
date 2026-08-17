/**
 * Sérialisation d'une grille : RLE puis base64.
 * Un monde de 320x180 majoritairement vide tient en quelques centaines d'octets,
 * ce qui rentre sans souci dans une colonne D1 plus tard.
 */

export function encode(cells: Uint8Array): string {
  const out: number[] = [];
  let id = cells[0], run = 0;
  for (let i = 0; i < cells.length; i++) {
    if (cells[i] === id && run < 255) { run++; continue; }
    out.push(id, run);
    id = cells[i];
    run = 1;
  }
  out.push(id, run);
  let binary = "";
  for (let i = 0; i < out.length; i += 4096) {
    binary += String.fromCharCode(...out.slice(i, i + 4096));
  }
  return btoa(binary);
}

export function decode(data: string, size: number): Uint8Array {
  const binary = atob(data);
  const cells = new Uint8Array(size);
  let at = 0;
  for (let i = 0; i + 1 < binary.length; i += 2) {
    const id = binary.charCodeAt(i);
    const run = binary.charCodeAt(i + 1);
    cells.fill(id, at, Math.min(at + run, size));
    at += run;
    if (at >= size) break;
  }
  return cells;
}
