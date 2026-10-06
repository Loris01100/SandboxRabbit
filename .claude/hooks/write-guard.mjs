// Hook PreToolUse de Claude Code : garde les trois formats gelés du dépôt, que
// rien d'autre ne garde.
//
// Les règles mécaniques d'AGENTS.md ont déjà test/rules.ts (relancé à chaque
// écriture par rules-check.mjs) ; elles ne sont pas reprises ici. Ce qui suit
// est le reste : une migration déjà appliquée, l'empreinte du moteur et le
// codec ne se vérifient pas en lisant le fichier, parce qu'un fichier fautif y
// est parfaitement valide. Ce qu'ils cassent est ailleurs — une base D1 déjà
// déployée, une divergence de moteur qu'on vient de recouvrir, un monde déposé
// dans la galerie l'an dernier.
//
// D'où « ask » et non « deny » pour deux d'elles : changer l'empreinte ou le
// codec est parfois exactement ce qu'il faut faire, mais jamais sans que
// l'humain le sache.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const input = JSON.parse(readFileSync(0, "utf8") || "{}");
const racine = process.env.CLAUDE_PROJECT_DIR || ".";
const outil = input.tool_name ?? "";
const champs = input.tool_input ?? {};

const laisse = () => process.exit(0);
const réponse = (décision, raison) => {
  console.log(JSON.stringify({
    hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: décision, permissionDecisionReason: raison },
  }));
  process.exit(0);
};

// Deux chaînes à part : les chemins visés et ce qui s'écrit dedans. Sans la
// séparation, une doc qui *parle* de codec.ts (docs/agents/architecture.md en
// parle) déclencherait la garde du codec.
//
// Une ligne de commande, elle, ne se démêle pas : on la traite en bloc, chemins
// et contenu confondus. Les lectures ne passent pas le filtre juste en dessous,
// donc un `grep` qui nommerait codec.ts ne demande rien.
let chemins, corps;
if (outil === "Bash") {
  const cmd = champs.command ?? "";
  if (!/sed\s+-i|>\s*\S|tee\s|mv\s|cp\s|rm\s/.test(cmd)) laisse();
  chemins = corps = cmd;
} else {
  chemins = [champs.file_path, ...(champs.edits ?? []).map((e) => e.file_path)].filter(Boolean).join("\n");
  corps = [champs.content, champs.old_string, champs.new_string,
    ...(champs.edits ?? []).flatMap((e) => [e.old_string, e.new_string])].filter(Boolean).join("\n");
}

/* Une migration déjà versionnée. Elle a tourné sur la D1 de production (et sur
 * celles des autres) : la retoucher ne la rejoue pas, ça laisse deux schémas
 * qui se croient identiques. Un schéma se change par un fichier numéroté de
 * plus — jamais de retouche, donc un vrai refus. */
for (const chemin of chemins.match(/migrations\/[\w.-]+\.sql/g) ?? []) {
  try {
    execFileSync("git", ["ls-files", "--error-unmatch", chemin], { cwd: racine, stdio: "ignore" });
  } catch {
    continue; // Pas suivie par git : c'est la nouvelle migration, elle a le droit.
  }
  réponse("deny",
    `${chemin} est déjà versionnée, donc déjà appliquée sur la D1 déployée : la retoucher laisse deux schémas différents qui se croient identiques. ` +
    "Ajouter un fichier numéroté à la suite dans migrations/ (règle « Schéma D1 » d'AGENTS.md), et noter la route touchée dans docs/agents/architecture.md.");
}

/* L'empreinte du moteur : 300 ticks depuis la graine 1234, un hash de huit
 * chiffres hexadécimaux dans test/sim.ts. La recopier fait passer le test, et
 * c'est tout : la divergence qu'elle signalait reste dans le moteur, et part
 * dans le prochain salon entre deux navigateurs. */
if (/test\/sim\.ts/.test(chemins) && /"[0-9a-f]{8}"/.test(corps)) {
  réponse("ask",
    "Cette écriture touche l'empreinte du moteur dans test/sim.ts. AGENTS.md : « Une empreinte de moteur qui change doit être justifiée, pas recopiée par réflexe. » " +
    "Dire quel changement de règle la déplace et pourquoi c'est voulu, avant de la remplacer.");
}

/* Le codec est le format des mondes déjà enregistrés : ils dorment dans la
 * galerie, dans les liens de partage et dans le localStorage des joueurs.
 * Changer un bloc existant les relit de travers, et rien ici ne le dira. */
if (/sim\/codec\.ts/.test(chemins)) {
  réponse("ask",
    "src/client/sim/codec.ts porte le format des mondes déjà enregistrés (galerie, liens de partage, localStorage des joueurs). " +
    "AGENTS.md : n'ajouter qu'un bloc en fin, ne jamais changer un bloc existant — un ancien monde doit se relire tel quel. " +
    "Confirmer que la modification est bien additive.");
}

laisse();
