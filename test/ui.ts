/**
 * Auto-vérification du panneau : `npm run check`.
 * Seule la logique pure est ici — le reste de main.ts tient au DOM.
 */
import assert from "node:assert/strict";
import { goalText, panAfterZoom, parseGoal, pushRecent, ticksFor } from "../src/client/ui.ts";
import { SAND, STONE, WATER } from "../src/client/sim/materials.ts";

// Objectifs : ce qui vient d'un autre visiteur ne passe pas sans contrôle.
{
  assert.deepEqual(parseGoal("ge:2:600"), { op: "ge", id: 2, n: 600 });
  assert.equal(parseGoal("lt:2:1")?.op, "lt");
  for (const bad of [null, "", "gagné !", "gt:2:600", "ge:2", "ge:250:1"]) {
    assert.equal(parseGoal(bad), null, `« ${bad} » refusé`);
  }
  assert.equal(goalText("ge:2:600"), "Au moins 600 cellules de Eau");
  assert.equal(goalText("n'importe quoi"), null);
}

// Matières récentes : la dernière en tête, pas de doublon, plafond tenu.
{
  let list = pushRecent([], SAND, 3);
  list = pushRecent(list, WATER, 3);
  list = pushRecent(list, SAND, 3);
  assert.deepEqual(list, [SAND, WATER], "revenir à une matière la remonte sans la dupliquer");
  list = pushRecent(pushRecent(list, STONE, 3), 5, 3);
  assert.equal(list.length, 3, "le plafond tient");
  assert.equal(list[0], 5, "la dernière est en tête");
}

// Zoom : le point sous le curseur ne bouge pas d'un pixel.
{
  // Boîte affichée : 800 px de large à partir de x = 100, sans décalage.
  const [edge, size, zoom] = [100, 800, 1];
  for (const client of [100, 340, 900]) {
    for (const next of [1.2, 3, 12]) {
      const pan = panAfterZoom(client, edge, size, 0, zoom, next);
      // Position rendue du même point après coup : origine + décalage + fraction.
      const fraction = (client - edge) / size;
      const after = edge + pan + fraction * size * next;
      assert.ok(Math.abs(after - client) < 1e-9, `point fixe à ${client} px, zoom ×${next}`);
    }
  }
  // Un aller-retour ramène exactement où l'on était.
  const out = panAfterZoom(500, edge, size, 0, 1, 4);
  const back = panAfterZoom(500, edge + out, size * 4, out, 4, 1);
  assert.ok(Math.abs(back) < 1e-9, "revenir à ×1 remet le décalage à zéro");
}

// Cadence : la vitesse est par 60e de seconde, pas par frame.
{
  assert.equal(ticksFor(1, 1000 / 60, 0).ticks, 1, "60 Hz, ×1 : un tick par frame");
  assert.equal(ticksFor(4, 1000 / 60, 0).ticks, 4, "60 Hz, ×4 : quatre ticks");

  // 120 Hz : un tick une frame sur deux, soit la même vitesse qu'à 60 Hz.
  let pending = 0, ticks = 0;
  for (let f = 0; f < 120; f++) {
    const step = ticksFor(1, 1000 / 120, pending);
    pending = step.pending;
    ticks += step.ticks;
  }
  assert.equal(ticks, 60, "120 frames à 120 Hz = une seconde = 60 ticks");

  // Un onglet revenu au premier plan ne rattrape pas dix secondes d'un coup.
  assert.ok(ticksFor(4, 10_000, 0).ticks <= 8, "le rattrapage est plafonné");
  assert.equal(ticksFor(1, -5, 0).ticks, 0, "une horloge qui recule ne simule rien");
}

console.log("ok — panneau conforme");
