// Hook PostToolUse de Claude Code : un fichier que test/rules.ts lit vient de
// changer → on relance test/rules.ts tout de suite et on rend la main à Claude
// si une règle est tombée.
//
// Pourquoi pas une garde qui refuse l'écriture, comme le hook PreToolUse voisin :
// les règles mécaniques (tirage reproductible, ids gelés, CSP, cloisonnement de
// la page, localStorage, SELECT *) ont déjà leur vérification, dans
// test/rules.ts. La réécrire ici en ferait deux copies qui divergeraient — et
// c'est la copie du hook, invisible depuis `npm run check`, qui mentirait. Le
// hook ne fait donc qu'avancer le moment où elle tourne : à l'écriture plutôt
// qu'à l'étape 2 d'« Avant de rendre la main », quand l'infraction est encore à
// une ligne de son auteur. 0,3 s par édition, contre une minute de `check`.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const input = JSON.parse(readFileSync(0, "utf8") || "{}");
const racine = process.env.CLAUDE_PROJECT_DIR || ".";
const outil = input.tool_name ?? "";
const champs = input.tool_input ?? {};

// Les fichiers que test/rules.ts lit — hors eux, rien à relancer. Non ancré :
// on passe ici aussi bien un chemin qu'une ligne de commande entière, où le
// chemin arrive après un espace et un verbe.
const concerné = (texte) => /src\/|index\.html|README\.md/.test(texte);

let touché = false;
if (outil === "Bash") {
  // Une commande qui écrit (`sed -i`, un `cat >`, un `tee`) et qui nomme un de
  // ces fichiers. On ne cherche pas à démêler la ligne de commande : au pire on
  // relance pour rien, et ça coûte un tiers de seconde.
  const cmd = champs.command ?? "";
  touché = /sed\s+-i|>\s*\S|tee\s/.test(cmd) && concerné(cmd);
} else {
  const chemins = [champs.file_path, ...(champs.edits ?? []).map((e) => e.file_path)].filter(Boolean);
  touché = chemins.some(concerné);
}
if (!touché) process.exit(0);

try {
  execFileSync("node", ["test/rules.ts"], { cwd: racine, encoding: "utf8", stdio: "pipe" });
} catch (e) {
  // Le message d'assert de rules.ts dit déjà quelle règle est tombée et
  // pourquoi : on le passe tel quel.
  const brut = `${e.stdout ?? ""}${e.stderr ?? ""}`;
  // Le message de l'assert suffit ; la pile de Node ne dit rien d'utile ici.
  const sortie = (brut.match(/^AssertionError.*$/m)?.[0] ?? brut).trim();
  console.log(JSON.stringify({
    decision: "block",
    reason:
      "test/rules.ts refuse la modification qui vient d'être écrite (règle d'AGENTS.md, « Règles à ne pas enfreindre ») :\n\n" +
      `${sortie.slice(0, 4000)}\n\n` +
      "Corrige le code plutôt que le test : chacune de ces règles a son commentaire dans test/rules.ts, qui dit ce qu'elle casse quand on l'enfreint.",
  }));
}
