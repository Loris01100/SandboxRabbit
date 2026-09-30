---
name: ponytail-debt
description: Liste la dette connue du dépôt — tous les commentaires `ponytail:` du code, avec leur limite et ce qui ferait y revenir. À utiliser quand on demande la dette, les raccourcis assumés ou les `ponytail:`.
---

# Dette connue (`ponytail:`)

Un commentaire `ponytail:` marque un raccourci assumé et sa limite (voir
« Conventions » dans AGENTS.md). Cette commande en dresse la liste complète.

1. Chercher tous les marqueurs, commentaire entier compris (il court souvent
   sur plusieurs lignes) :

   ```bash
   grep -rn -A6 --exclude-dir=target "ponytail:" src test rust migrations .github index.html wrangler.jsonc
   ```

   Ne rien filtrer : la liste doit être complète, pas un échantillon. Si la
   sortie coupe un commentaire avant sa fin, lire la suite dans le fichier.

2. Rendre un tableau en français, regroupé par zone (moteur, rendu, page,
   salon, Worker, tests), une ligne par marqueur :

   | Où | Raccourci | Limite visible | À revoir quand |
   | --- | --- | --- | --- |

   - « Où » : lien markdown `[fichier:ligne](chemin#Lligne)`.
   - « Limite visible » : ce que le joueur ou le développeur constate, en une
     phrase, tiré du commentaire — pas inventé.
   - « À revoir quand » : le déclencheur écrit dans le commentaire ; s'il n'y
     en a pas, écrire « non dit » (c'est un défaut du commentaire, à signaler).

3. Terminer par le total, et signaler en une ligne chacun :
   - un marqueur dont le code voisin semble avoir corrigé la limite (dette
     peut-être soldée : proposer de retirer le commentaire, sans le faire) ;
   - un marqueur sans déclencheur ;
   - un écart avec le résumé « Dette connue » du README : une dette qu'il cite
     sans marqueur dans le code (soldée ?), ou un marqueur important qu'il
     omet. Proposer la correction, sans la faire.

Ce fichier existe en deux copies identiques, `.claude/skills/` (Claude Code)
et `.agents/skills/` (autres agents) : modifier les deux.

Ne rien modifier : c'est un inventaire. Corriger une dette est une autre tâche,
à demander explicitement.
