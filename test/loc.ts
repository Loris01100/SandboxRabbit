/**
 * Mesure : `npm run loc`. Combien de lignes fait le projet, et où elles sont.
 *
 * `git ls-files` fait tout le travail de sélection : ce qui est suivi par git
 * est le projet, le reste (node_modules, dist, .wrangler) est ignoré sans avoir
 * à en tenir la liste. Restent deux fichiers suivis que personne n'écrit à la
 * main — le verrou npm et les typages régénérés par `cf-typegen`.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const GENERATED = ["package-lock.json", "worker-configuration.d.ts"];

/** À quel poste compter un fichier. Le premier motif qui accroche gagne. */
const GROUPS: [string, RegExp][] = [
  ["moteur", /^src\/client\/sim\//],
  ["client", /^(src\/client\/|index\.html$)/],
  ["worker", /^src\/worker\//],
  ["tests", /^test\//],
  ["config", /^(\.github\/|tsconfig|vite\.config|wrangler\.|package\.json|\.gitignore)/],
  ["sql", /^migrations\//],
  ["docs", /\.md$/],
];

const files = execFileSync("git", ["ls-files"], { encoding: "utf8" })
  .split("\n")
  .filter((f) => f && !GENERATED.includes(f) && !/\.(png|jpe?g|gif|ico|webp|woff2?)$/.test(f));

const totals = new Map<string, { files: number; lines: number; code: number }>();
for (const file of files) {
  const group = GROUPS.find(([, re]) => re.test(file))?.[0] ?? "autres";
  const lines = readFileSync(file, "utf8").split("\n");
  const row = totals.get(group) ?? { files: 0, lines: 0, code: 0 };
  row.files++;
  row.lines += lines.length;
  // « Code » = ce qui n'est ni vide ni un commentaire de ligne : de quoi voir
  // la part de prose sans écrire un analyseur syntaxique.
  row.code += lines.filter((l) => l.trim() && !/^\s*(\/\/|\/?\*|#|--)/.test(l)).length;
  totals.set(group, row);
}

const rows = [...totals].sort((a, b) => b[1].lines - a[1].lines);
console.log("poste        fichiers   lignes     code");
for (const [name, r] of rows) {
  console.log(
    name.padEnd(13) + String(r.files).padStart(8) + String(r.lines).padStart(9) + String(r.code).padStart(9),
  );
}
const sum = (k: "files" | "lines" | "code") => rows.reduce((n, [, r]) => n + r[k], 0);
console.log("-".repeat(39));
console.log("total".padEnd(13) + String(sum("files")).padStart(8) + String(sum("lines")).padStart(9) + String(sum("code")).padStart(9));
