# CLAUDE.md

Les consignes des agents sont communes à tous les outils : elles vivent dans
[AGENTS.md](AGENTS.md), importé ci-dessous, et dans les guides de
[docs/agents/](docs/agents/). Pour changer une consigne, modifier ces
fichiers-là, pas celui-ci.

@AGENTS.md

## Propre à Claude Code

- Avant de modifier le moteur, lire [docs/agents/simulation.md](docs/agents/simulation.md) :
  seul AGENTS.md est chargé d'office, les guides ne le sont pas.
- Pour une tâche couverte par [docs/agents/recettes.md](docs/agents/recettes.md),
  suivre la recette et sa liste de ce qu'on oublie.
- Chaque modification de code met à jour au moins un `.md` (table
  « Documentation à tenir à jour » d'AGENTS.md). Le hook `Stop` de
  [.claude/settings.json](.claude/settings.json) le vérifie : s'il bloque, mettre
  la doc à jour — ou, si rien de ce qu'elle décrit n'a changé, le dire à
  l'utilisateur.
