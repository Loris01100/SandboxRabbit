/**
 * Une pile d'erreur de production, retraduite dans les sources : la pile
 * copiée du journal sur l'entrée standard (`npm run pile < pile.txt`, ou
 * collée puis Ctrl+D), ou en argument sur une ligne (`npm run pile --
 * "<pile>"` — npm coupe un argument à son premier saut de ligne sous
 * Windows). Les rapports des joueurs (errors.ts, `POST /api/error`)
 * pointent dans le bundle minifié — `index-….js:1:48213` ne dit rien.
 *
 * Reconstruit le client avec ses cartes de sources (`SOURCEMAP=hidden`,
 * vite.config.ts), lit les cartes des fichiers que la pile cite, les efface
 * aussitôt de `dist/` (elles ne doivent jamais partir en ligne : un
 * `wrangler deploy` lancé seul les servirait), puis écrit chaque ligne avec
 * son `fichier.ts:ligne:colonne`. Le décodage des cartes (VLQ base64) est
 * écrit ici : quarante lignes plutôt qu'une dépendance.
 *
 * Il faut construire **le même code** que celui déployé : le nom haché du
 * fichier le garantit. Une pile qui cite un `index-AbC123.js` absent du
 * build vient d'un autre commit — le dire, et se placer sur ce commit.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";

const ASSETS = "dist/client/assets";
const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/** Une carte de sources (v3), décodée : par ligne générée, des segments [colonne, source, ligne, colonne, nom?]. */
export interface SourceMap { sources: string[]; names: string[]; lines: number[][][] }

/** Décode le champ `mappings` d'une carte (VLQ base64, valeurs relatives au segment d'avant). */
export function decode(map: { sources: string[]; names?: string[]; mappings: string }): SourceMap {
  const lines: number[][][] = [];
  let source = 0, line = 0, column = 0, name = 0;
  for (const row of map.mappings.split(";")) {
    let generated = 0;
    const segments: number[][] = [];
    for (const text of row.split(",")) {
      if (!text) continue;
      const values: number[] = [];
      let value = 0, shift = 0;
      for (const ch of text) {
        const digit = B64.indexOf(ch);
        value += (digit & 31) << shift;
        if (digit & 32) { shift += 5; continue; }
        values.push(value & 1 ? -(value >>> 1) : value >>> 1);
        value = 0; shift = 0;
      }
      generated += values[0];
      if (values.length < 4) { segments.push([generated]); continue; }
      source += values[1]; line += values[2]; column += values[3];
      const seg = [generated, source, line, column];
      if (values.length > 4) { name += values[4]; seg.push(name); }
      segments.push(seg);
    }
    lines.push(segments);
  }
  return { sources: map.sources, names: map.names ?? [], lines };
}

/** La position d'origine de (ligne, colonne) générées, comptées à partir de 1 comme dans une pile. */
export function locate(map: SourceMap, line: number, column: number): { source: string; line: number; column: number; name?: string } | null {
  const segments = map.lines[line - 1];
  if (!segments) return null;
  let best: number[] | null = null;
  for (const seg of segments) {
    if (seg[0] > column - 1) break;
    if (seg.length >= 4) best = seg;
  }
  if (!best) return null;
  return { source: map.sources[best[1]], line: best[2] + 1, column: best[3] + 1, name: best.length > 4 ? map.names[best[4]] : undefined };
}

// Lancé comme commande (pas importé par un test).
if (process.argv[1]?.endsWith("pile.ts")) {
  const stack = process.argv.slice(2).join(" ") || readFileSync(0, "utf8");
  const cited = [...new Set([...stack.matchAll(/(?<![\w-])([\w-]+\.js):\d+:\d+/g)].map((m) => m[1]))];
  if (cited.length === 0) {
    console.error("Aucune position `fichier.js:ligne:colonne` dans cette pile.");
    process.exit(1);
  }
  console.error("Construction avec les cartes de sources…");
  execFileSync(process.execPath, ["node_modules/vite/bin/vite.js", "build", "--logLevel", "error"], {
    stdio: ["ignore", "ignore", "inherit"], env: { ...process.env, SOURCEMAP: "hidden" },
  });
  const maps = new Map<string, SourceMap>();
  try {
    for (const file of cited) {
      try { maps.set(file, decode(JSON.parse(readFileSync(join(ASSETS, `${file}.map`), "utf8")))); } catch { /* absent : autre commit */ }
    }
  } finally {
    for (const f of readdirSync(ASSETS)) if (f.endsWith(".map")) rmSync(join(ASSETS, f));
  }
  const missing = cited.filter((f) => !maps.has(f));
  if (missing.length) console.error(`Absents de ce build (autre commit ?) : ${missing.join(", ")}`);
  for (const raw of stack.split("\n")) {
    // L'URL entière part avec : `https://…/assets/index-….js:1:2` devient `src/…ts:3:4`.
    const out = raw.replace(/(?:(?<![^\s(])[^\s(]*\/)?(?<![\w-])([\w-]+\.js):(\d+):(\d+)/g, (all, file: string, l: string, c: string) => {
      const map = maps.get(file);
      const at = map && locate(map, Number(l), Number(c));
      if (!at) return all;
      const where = `${at.source.replace(/^(\.\.\/)+/, "")}:${at.line}:${at.column}`;
      return at.name ? `${where} (${at.name})` : where;
    });
    console.log(out);
  }
}
