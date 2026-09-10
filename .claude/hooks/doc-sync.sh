#!/usr/bin/env bash
# Hook Stop de Claude Code : du code a changé (par rapport à HEAD) mais aucun
# fichier .md ne l'a été → on bloque la fin du tour avec un rappel.
# La règle elle-même est dans AGENTS.md (« Documentation à tenir à jour ») ;
# ce script ne fait que la faire respecter par Claude.
input=$(cat)

# Deuxième passage : Claude a déjà reçu le rappel. On le laisse finir, sinon il
# boucle quand aucune doc n'est concernée.
if [ "$(printf '%s' "$input" | jq -r '.stop_hook_active // false')" = "true" ]; then
  exit 0
fi

cd "${CLAUDE_PROJECT_DIR:-.}" || exit 0

# Modifié (indexé ou non) + nouveaux fichiers non ignorés.
changed=$({ git diff --name-only HEAD; git ls-files --others --exclude-standard; } 2>/dev/null | sort -u)
[ -z "$changed" ] && exit 0

# Une doc a déjà bougé : rien à rappeler.
printf '%s\n' "$changed" | grep -qE '\.md$' && exit 0

code=$(printf '%s\n' "$changed" | grep -E '^(src/|test/|migrations/|\.github/|index\.html$|wrangler\.jsonc$|package\.json$|tsconfig[^/]*\.json$|vite\.config\.ts$)')
[ -z "$code" ] && exit 0

jq -n --arg files "$code" '{
  decision: "block",
  reason: ("Du code a changé sans qu'\''aucun fichier .md ne soit modifié :\n" + $files + "\n\nMets à jour la documentation correspondante (table « Documentation à tenir à jour » d'\''AGENTS.md : docs/agents/*.md, AGENTS.md, README.md), ou ajoute un guide dans docs/agents/ si rien ne couvre le sujet. Si la modification ne change rien de ce que la doc décrit, dis-le explicitement à l'\''utilisateur plutôt que d'\''inventer une retouche.")
}'
