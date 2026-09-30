/**
 * Auto-vérification du panneau : `npm run check`.
 * Seule la logique pure est ici — le reste de main.ts tient au DOM.
 */
import assert from "node:assert/strict";
import { ACTIONS, DEFAULT_BINDINGS, KEY_GROUPS, clampPan, combo, goalText, keyLabel, keymap, panAfterZoom, parseBindings, parseGoal, pushRecent, rebind, refreshPeriod, ticksFor } from "../src/client/ui.ts";
import { EMPTY, HERO, HERO_HEAD, MATERIALS, SAND, STONE, WATER } from "../src/client/sim/materials.ts";
import { look } from "../src/client/sight.ts";
import { REPORT, reporter } from "../src/client/errors.ts";

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

// La vue zoomée recouvre toujours son cadre : on ne pousse plus le bac hors de l'écran.
{
  assert.equal(clampPan(50, 800, 3), 0, "pas de vide à gauche du bac");
  assert.equal(clampPan(-5000, 800, 3), -1600, "ni à droite : au plus deux cadres de décalage à ×3");
  assert.equal(clampPan(-700, 800, 3), -700, "entre les deux, le décalage est gardé");
  assert.equal(clampPan(-30, 800, 1), 0, "à ×1, rien à déplacer");
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

// Cadence du Worker : la fréquence de l'écran, bornée entre 60 et 240 Hz.
{
  const hz144 = 1000 / 144;
  assert.equal(refreshPeriod([hz144, hz144, 2 * hz144, hz144, 5000]), hz144, "une frame manquée ou un onglet revenu ne comptent pas");
  assert.equal(refreshPeriod([]), 1000 / 60, "rien de mesuré : 60 Hz");
  assert.equal(refreshPeriod([40, 40, 40]), 1000 / 60, "une page qui rame ne ralentit pas le Worker sous 60 Hz");
  assert.equal(refreshPeriod([1, 1, 1]), 1000 / 240, "240 Hz au plus");
}

/**
 * Ce que voit le héros : un mur de sable à sa droite, rien à sa gauche. Tourné
 * vers le mur, le rayon du milieu le voit ; son propre corps ne lui bouche pas
 * la vue ; tourné vers le vide, il voit le bord du monde, un mur de pierre.
 */
{
  const W = 40, H = 20, cells = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) cells[y * W + 20] = SAND;
  cells[10 * W + 10] = HERO;
  cells[8 * W + 10] = HERO_HEAD;
  const out = new Uint8ClampedArray(9 * 4);
  const milieu = (): number[] => [...out.subarray(16, 19)];
  look(cells, W, H, 10, 10, 1, out);
  const sable = MATERIALS[SAND].color;
  assert.ok(milieu()[0] > 0.9 * sable[0] && milieu()[0] <= sable[0], "droit devant, le sable, à peine assombri par la distance");
  look(cells, W, H, 10, 10, -1, out);
  assert.ok(milieu()[0] < MATERIALS[STONE].color[0] && milieu()[0] > MATERIALS[EMPTY].color[0], "de l'autre côté, le bord du monde, en pierre");
}

/**
 * Touches réassignables : un échange quand la touche est prise, un refus
 * quand elle est réservée, des combinaisons avec Ctrl, et des flèches qui
 * restent là.
 */
{
  const touche = (key: string, mods: Partial<{ ctrlKey: boolean; metaKey: boolean; altKey: boolean; shiftKey: boolean }> = {}) =>
    combo({ key, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...mods });
  assert.equal(touche("Q", { shiftKey: true }), "q", "Maj seule ne compte pas : une lettre reste elle-même");
  assert.equal(touche("1", { shiftKey: true }), "1", "les chiffres d'un clavier AZERTY demandent Maj");
  assert.equal(touche("Z", { ctrlKey: true, shiftKey: true }), "Ctrl+Maj+z", "avec Ctrl, Maj compte");
  assert.equal(touche("z", { metaKey: true }), "Ctrl+z", "Cmd vaut Ctrl");

  const b = rebind(DEFAULT_BINDINGS, "left", touche("J"))!;
  assert.equal(b.left, "j");
  assert.equal(keymap(b).j, "left");
  assert.equal(keymap(b).ArrowLeft, "left", "les flèches marchent toujours");
  const échange = rebind(DEFAULT_BINDINGS, "dig", "g")!;
  assert.deepEqual([échange.dig, échange.gravity], ["g", "e"], "prendre la touche d'une autre action échange les deux");
  const annuler = rebind(DEFAULT_BINDINGS, "undo", touche("w", { ctrlKey: true }))!;
  assert.equal(keymap(annuler)["Ctrl+w"], "undo", "une combinaison s'attribue");
  assert.equal(keymap(annuler).w, "up", "et ne prend pas la touche seule");
  assert.equal(keymap(DEFAULT_BINDINGS)["Ctrl+Maj+z"], "redo", "Ctrl+Maj+Z rétablit aussi");
  assert.equal(rebind(DEFAULT_BINDINGS, "view", "Tab"), null, "Tab navigue : réservée");
  assert.equal(rebind(DEFAULT_BINDINGS, "view", "Ctrl+Shift"), null, "un modificateur seul non plus");
  assert.equal(keymap(rebind(DEFAULT_BINDINGS, "dig", "a")!).a, "dig", "une touche choisie passe avant un alias");
  assert.equal(keyLabel("Ctrl+z"), "Ctrl+Z");
  assert.equal(keyLabel("Ctrl++"), "Ctrl++");
  assert.equal(keyLabel(" "), "Espace");
  assert.deepEqual(parseBindings(JSON.stringify(b)), b, "relues telles qu'écrites");
  assert.deepEqual(parseBindings("{abîmé"), DEFAULT_BINDINGS, "illisible : les touches d'origine");
  assert.deepEqual(parseBindings(JSON.stringify({ up: "Enter", left: 3 })), DEFAULT_BINDINGS, "réservée ou pas une chaîne : écartée");
  const rangées = KEY_GROUPS.flatMap((g) => g.actions);
  assert.deepEqual([...rangées].sort(), [...ACTIONS].sort(), "chaque action est dans un encadré, et un seul");
  assert.equal(new Set(Object.values(DEFAULT_BINDINGS)).size, ACTIONS.length, "les touches d'origine sont toutes différentes");
}

// Rapports d'erreur : chaque message une fois, cinq au plus, coupés au plafond.
{
  const sent: string[] = [];
  const report = reporter((text) => sent.push(text));
  for (let i = 0; i < 60; i++) report("boucle de rendu");
  assert.deepEqual(sent, ["boucle de rendu"], "une erreur répétée ne part qu'une fois");
  for (let i = 0; i < 10; i++) report(`erreur ${i}`);
  assert.equal(sent.length, 5, "cinq rapports au plus par visite");
  const long = reporter((text) => sent.push(text));
  long("x".repeat(REPORT + 100));
  assert.equal(sent.at(-1)!.length, REPORT, "un rapport est coupé au plafond");
}

console.log("ok — panneau conforme");
