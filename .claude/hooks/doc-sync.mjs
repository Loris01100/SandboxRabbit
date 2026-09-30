// Hook Stop de Claude Code : du code a changé (par rapport à HEAD) mais aucun
// fichier .md ne l'a été → on bloque la fin du tour avec un rappel.
// La règle elle-même est dans AGENTS.md (« Documentation à tenir à jour ») ;
// ce script ne fait que la faire respecter par Claude. En Node plutôt qu'en
// bash + jq : jq manquait sur Windows, le hook échouait sans bruit et ne
// bloquait jamais.
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";

const input = JSON.parse(readFileSync(0, "utf8") || "{}");

// Deuxième passage : Claude a déjà reçu le rappel. On le laisse finir, sinon il
// boucle quand aucune doc n'est concernée.
if (input.stop_hook_active) process.exit(0);

const git = (args) => {
  try {
    return execSync(`git ${args}`, { cwd: process.env.CLAUDE_PROJECT_DIR || ".", encoding: "utf8" }).split("\n");
  } catch {
    return [];
  }
};

// Modifié (indexé ou non) + nouveaux fichiers non ignorés.
const changed = [...new Set([...git("diff --name-only HEAD"), ...git("ls-files --others --exclude-standard")])].filter(Boolean);

// Une doc a déjà bougé : rien à rappeler.
if (changed.some((f) => f.endsWith(".md"))) process.exit(0);

const code = changed.filter((f) =>
  /^(src\/|test\/|rust\/|migrations\/|\.github\/|index\.html$|wrangler\.jsonc$|package\.json$|tsconfig[^/]*\.json$|vite\.config\.ts$)/.test(f),
);
if (code.length === 0) process.exit(0);

console.log(JSON.stringify({
  decision: "block",
  reason:
    `Du code a changé sans qu'aucun fichier .md ne soit modifié :\n${code.join("\n")}\n\n` +
    "Mets à jour la documentation correspondante (table « Documentation à tenir à jour » d'AGENTS.md : docs/agents/*.md, AGENTS.md, README.md), ou ajoute un guide dans docs/agents/ si rien ne couvre le sujet. Si la modification ne change rien de ce que la doc décrit, dis-le explicitement à l'utilisateur plutôt que d'inventer une retouche.",
}));
