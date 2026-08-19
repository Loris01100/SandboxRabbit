/**
 * Le bac partagé, côté navigateur. En face, un Durable Object qui ne fait que
 * relayer (src/worker/room.ts). L'hôte est le seul à simuler : il diffuse sa
 * grille quatre fois par seconde, les invités lui envoient leurs gestes et
 * affichent ce qu'ils reçoivent — un seul simulateur, donc rien à réconcilier.
 * ponytail: pas d'identité ni de verrou, qui entre peint. Et l'instantané ne
 * porte que matière et figé : la vue thermique d'un invité reste muette.
 *
 * Ce module ne connaît ni le bouton Pause ni le sélecteur de taille : il les
 * demande par deux rappels, sinon il faudrait importer main.ts et boucler.
 */
import { HEIGHT, WIDTH, engine, resize } from "./world.ts";
import { decode, decodeFrozen, encode } from "./sim/codec";
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

const statusEl = document.querySelector<HTMLParagraphElement>("#status")!;
const roomButton = document.querySelector<HTMLButtonElement>("#room")!;
let socket: WebSocket | null = null;
let host = false;
let beat = 0;

/** Grille reçue de l'hôte : posée sans passer par la pile d'annulation (4 par seconde). */
function applyGrid(data: string, w: number, h: number): void {
  // La grille de l'hôte impose sa taille.
  if (w !== WIDTH || h !== HEIGHT) onSize(w, h);
  engine.cells.set(decode(data, w * h));
  engine.frozen.set(decodeFrozen(data, w * h));
}

function leaveRoom(): void {
  clearInterval(beat);
  socket = null;
  host = false;
  roomButton.textContent = "Bac partagé";
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
    const msg = JSON.parse(e.data as string);
    if (msg.type === "role") {
      host = msg.host;
      // Un invité ne simule pas : sa grille est écrasée quatre fois par seconde.
      onRole(host);
      statusEl.textContent = host
        ? `Salon « ${name} » — vous simulez pour tout le monde.`
        : `Salon « ${name} » — vous suivez l'hôte.`;
    }
    if (msg.type === "grid" && !host) applyGrid(msg.data, msg.width, msg.height);
    if (msg.type === "do" && host) applyGesture(msg.g);
  });
  ws.addEventListener("close", () => {
    leaveRoom();
    statusEl.textContent = "Salon quitté.";
  });
  ws.addEventListener("error", () => {
    leaveRoom();
    statusEl.textContent = "Salon injoignable.";
  });

  beat = setInterval(() => {
    if (host && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "grid", width: WIDTH, height: HEIGHT, data: encode(engine.cells, engine.frozen) }));
    }
  }, 250);
});
