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
- `/ponytail-debt` ([.claude/skills/ponytail-debt/](.claude/skills/ponytail-debt/SKILL.md))
  liste la dette connue : tous les `ponytail:` du code, sans rien modifier.
- Chaque modification de code met à jour au moins un `.md` (table
  « Documentation à tenir à jour » d'AGENTS.md). Le hook `Stop` de
  [.claude/settings.json](.claude/settings.json) le vérifie : s'il bloque, mettre
  la doc à jour — ou, si rien de ce qu'elle décrit n'a changé, le dire à
  l'utilisateur.

### Permissions

[.claude/settings.json](.claude/settings.json) laisse passer sans demander les
commandes de la section « Commandes » d'AGENTS.md (`typecheck`, `check`, `bench`,
`stress`, `browser`, `build`, `directions`, `loc`, `rust`, un `node test/…`) et la
lecture du dépôt (`cat`, `sed -n`, `grep`, `git diff`, `git log`…) : « Avant de
rendre la main » les réclame à chaque tour, et refuser l'une d'elles n'a jamais
de sens.

Restent en `ask`, donc toujours confirmées à la main, même dans un mode qui
accepte les éditions : `npm run deploy` et `wrangler deploy` (AGENTS.md : sur
demande explicite seulement), `git commit` / `push` / `reset` / `checkout`,
`rm`, et `npm install <paquet>` — la CI tient deux budgets de 80 Kio, une
dépendance de plus se discute avant de s'installer.

### Hooks

Trois, tous en Node (pas de `jq` à installer), dans
[.claude/hooks/](.claude/hooks/) :

| Hook | Fichier | Ce qu'il fait |
| --- | --- | --- |
| `PreToolUse` | [write-guard.mjs](.claude/hooks/write-guard.mjs) | Refuse de retoucher une migration déjà versionnée (le schéma se change par un fichier de plus) ; demande confirmation avant de déplacer l'empreinte du moteur dans test/sim.ts ou de toucher à `sim/codec.ts`, format des mondes déjà enregistrés. |
| `PostToolUse` | [rules-check.mjs](.claude/hooks/rules-check.mjs) | Relance [test/rules.ts](test/rules.ts) dès qu'une écriture touche `src/`, index.html ou le README (0,3 s), et rend le message d'`assert` à Claude. |
| `Stop` | [doc-sync.mjs](.claude/hooks/doc-sync.mjs) | Refuse de clore un tour quand du code a changé sans aucun `.md`. |

Les hooks ne redisent jamais une règle que le code vérifie déjà : `rules-check`
appelle test/rules.ts au lieu d'en recopier les tests — deux copies
divergeraient, et c'est celle du hook, invisible depuis `npm run check`, qui
mentirait. `write-guard` ne garde donc que ce que rules.ts ne peut pas voir : un
fichier fautif y est parfaitement valide, ce qu'il casse est ailleurs (une D1
déjà déployée, un monde déposé dans la galerie, une divergence de salon qu'on
vient de recouvrir).

Ce que ni l'un ni l'autre n'attrape, et qui reste à la relecture : l'écriture
directe dans `press` plutôt que `puff()`, le `set()` là où il fallait
`become()`, le `wake()` oublié, la lecture de `MATERIALS[id]` dans le chemin
chaud. Aucun de ces quatre ne se distingue de sa forme légitime par une
expression régulière — `puff()` lui-même écrit dans `press`.

Ajouter un hook à une règle dont l'infraction serait silencieuse, pas à une
règle que `npm run check` attrape déjà.
