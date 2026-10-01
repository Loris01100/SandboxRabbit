/**
 * Le fil de l'éclairage du secours 2D : la page collecte la grille de lumière
 * (`FlatLight.collect()`, ~1 ms) et l'envoie ici, qui lance les rayons, lisse
 * et rend la lumière (`solve()`). Sur le fil de la page, le calcul tenait sa
 * grille à 80 texels (~4,5 ms par éclairage) ; ici, rien ne l'attend — la
 * page continue de peindre avec la lumière d'avant —, et la grille passe à
 * 160 (`FLAT_LIGHT`), où une ombre fine se voit.
 *
 * Ce n'est pas un fil de simulation : il ne lit ni n'écrit le moteur, il ne
 * reçoit qu'une grille de lumière déjà résumée.
 */
import { FlatLight, type Gathered } from "./flatlight.ts";

// `self` typé à la main, comme dans sim/worker.ts : le projet compile avec la lib DOM.
const worker = self as unknown as {
  postMessage(message: unknown, transfer?: Transferable[]): void;
  onmessage: ((e: MessageEvent<Gathered>) => void) | null;
};

const light = new FlatLight();
worker.onmessage = (e) => {
  light.load(e.data);
  light.solve();
  const out = light.light.slice();
  worker.postMessage({ light: out, width: light.width, height: light.height, scale: light.scale }, [out.buffer]);
};
