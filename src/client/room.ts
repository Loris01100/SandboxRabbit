/**
 * Le bac partagé, côté navigateur. En face, un Durable Object qui ne fait que
 * relayer (src/worker/room.ts). L'hôte est le seul à simuler : il diffuse sa
 * grille quatre fois par seconde **dès qu'il n'est pas seul**, les invités lui
 * envoient leurs gestes et
 * affichent ce qu'ils reçoivent — un seul simulateur, donc rien à réconcilier.
 * ponytail: pas d'identité ni de verrou, qui entre peint. Et l'instantané ne
 * porte que matière et figé : la vue thermique d'un invité reste muette.
 *
 * Ce module ne connaît ni le bouton Pause ni le sélecteur de taille : il les
 * demande par deux rappels, sinon il faudrait importer main.ts et boucler.
 */
import { HEIGHT, WIDTH, engine, resize } from "./world.ts";
import { decode, decodeFrozen, encode } from "./sim/codec.ts";
import { applyGesture, type Gesture } from "./gestures.ts";

/** Appelé quand on devient hôte (true) ou invité (false) : un invité ne simule pas. */
let onRole: (host: boolean) => void = () => {};
/** Appelé quand l'hôte impose sa taille de grille. */
let onSize: (w: number, h: number) => void = (w, h) => resize(w, h, true);

export function initRoom(hooks: { role(host: boolean): void; size(w: number, h: number): void }): void {
  onRole = hooks.role;
  onSize = hooks.size;
}

/** Relaie un geste à l'hôte. Sans salon, ou quand on est l'hôte, ne fait rien. */
export function relay(g: Gesture): void {
  if (socket?.readyState === WebSocket.OPEN && !host) socket.send(JSON.stringify({ type: "do", g }));
}

/** JSON toléré : un message illisible est ignoré, pas propagé en exception. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function parse(data: string): any {
  try {
    const msg = JSON.parse(data);
    return typeof msg === "object" && msg !== null ? msg : null;
  } catch {
    return null;
  }
}

const statusEl = document.querySelector<HTMLParagraphElement>("#status")!;
const roomButton = document.querySelector<HTMLButtonElement>("#room")!;
let socket: WebSocket | null = null;
let host = false;
let beat = 0;
/** Connectés au salon, compté par le Durable Object. Seul, l'hôte ne diffuse rien. */
let peers = 1;

/** Grille reçue de l'hôte : posée sans passer par la pile d'annulation (4 par seconde). */
function applyGrid(data: string, w: number, h: number): void {
  // La grille de l'hôte impose sa taille.
  if (w !== WIDTH || h !== HEIGHT) onSize(w, h);
  // Une taille refusée (ou fantaisiste) laisserait `set()` jeter sur la longueur.
  if (w !== WIDTH || h !== HEIGHT) return;
  engine.adopt(decode(data, w * h));
  engine.frozen.set(decodeFrozen(data, w * h));
}

function leaveRoom(): void {
  clearInterval(beat);
  socket = null;
  host = false;
  peers = 1;
  roomButton.textContent = "Bac partagé";
  // On redevient maître de son bac : sans ça un invité qui part reste en pause.
  onRole(true);
}

roomButton.addEventListener("click", () => {
  if (socket) { socket.close(); return; }
  const name = prompt("Nom du salon ?", "public");
  if (!name) return;
  const ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/api/room/${encodeURIComponent(name)}`);
  socket = ws;
  roomButton.textContent = "Quitter le salon";
  statusEl.textContent = `Connexion au salon « ${name} »…`;

  ws.addEventListener("message", (e) => {
    // Le salon relaie sans lire : ce qui arrive n'est pas forcément du JSON.
    const msg = parse(e.data as string);
    if (!msg) return;
    if (msg.type === "role") {
      host = msg.host;
      // Un invité ne simule pas : sa grille est écrasée quatre fois par seconde.
      onRole(host);
      statusEl.textContent = host
        ? `Salon « ${name} » — vous simulez pour tout le monde.`
        : `Salon « ${name} » — vous suivez l'hôte.`;
    }
    if (msg.type === "peers" && typeof msg.n === "number") peers = msg.n;
    if (msg.type === "grid" && !host && typeof msg.data === "string") applyGrid(msg.data, msg.width, msg.height);
    if (msg.type === "do" && host && msg.g) applyGesture(msg.g);
  });
  // Une connexion qui échoue déclenche « error » puis « close » : sans ce
  // drapeau, « Salon quitté » effacerait aussitôt « Salon injoignable ».
  let failed = false;
  ws.addEventListener("error", () => (failed = true));
  ws.addEventListener("close", () => {
    leaveRoom();
    statusEl.textContent = failed ? "Salon injoignable." : "Salon quitté.";
  });

  beat = setInterval(() => {
    // Personne en face : ni encodage, ni téléversement, ni réveil du salon.
    if (host && peers > 1 && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "grid", width: WIDTH, height: HEIGHT, data: encode(engine.cells, engine.frozen) }));
    }
  }, 250);
});
