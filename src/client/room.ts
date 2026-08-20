/**
 * Le bac partagé, côté navigateur. En face, un Durable Object qui ne fait que
 * relayer (src/worker/room.ts). L'hôte est le seul à simuler : il diffuse sa
 * grille quatre fois par seconde **dès qu'il n'est pas seul**, les invités lui
 * envoient leurs gestes et affichent ce qu'ils reçoivent — un seul simulateur,
 * donc rien à réconcilier.
 * ponytail: pas d'identité ni de verrou, qui entre peint. Et l'instantané ne
 * porte que matière et figé : la vue thermique d'un invité reste muette.
 *
 * La grille diffusée n'est pas encodée ici : c'est le bac qui l'envoie tout
 * encodée (nouvelle « grid »), quatre fois par seconde, et seulement pendant
 * qu'un salon est ouvert — le réglage `room` le lui dit.
 *
 * Ce module ne connaît ni le bouton Pause ni le sélecteur de taille : il les
 * demande par des rappels, sinon il faudrait importer main.ts et boucler.
 */
import { HEIGHT, WIDTH, listen, order } from "./world.ts";
import type { Gesture } from "./gestures.ts";

/** Appelé quand on devient hôte (true) ou invité (false) : un invité ne simule pas. */
let onRole: (host: boolean) => void = () => {};
/** Appelé quand l'hôte impose sa taille de grille. */
let onSize: (w: number, h: number) => void = () => {};
/** Pose la grille de l'hôte dans le bac, sans cran d'annulation (4 par seconde). */
let onGrid: (data: string) => void = () => {};
/**
 * Applique le geste d'un invité. C'est main.ts qui le fait, pas ce module : le
 * geste d'un pair doit emprunter le même chemin que ceux de l'hôte, sinon il
 * manque à l'enregistrement de la partie (replay.ts).
 */
let onApply: (g: Gesture) => void = () => {};

export function initRoom(hooks: {
  role(host: boolean): void;
  size(w: number, h: number): void;
  grid(data: string): void;
  apply(g: Gesture): void;
}): void {
  onRole = hooks.role;
  onSize = hooks.size;
  onGrid = hooks.grid;
  onApply = hooks.apply;
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
/** La dernière grille courte (matière + figé) envoyée par le bac. */
let mine = "";

listen((news) => {
  if (news.t === "grid" && news.room !== undefined) mine = news.room;
});

/** Grille reçue de l'hôte : posée sans passer par la pile d'annulation. */
function applyGrid(data: string, w: number, h: number): void {
  // La grille de l'hôte impose sa taille.
  if (w !== WIDTH || h !== HEIGHT) onSize(w, h);
  // Une taille refusée (ou fantaisiste) laisserait le bac poser une bouillie.
  if (w !== WIDTH || h !== HEIGHT) return;
  onGrid(data);
}

function leaveRoom(): void {
  clearInterval(beat);
  socket = null;
  host = false;
  peers = 1;
  mine = "";
  order({ t: "set", k: { room: false } }); // le bac cesse d'encoder pour personne
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
  order({ t: "set", k: { room: true } });
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
    if (msg.type === "do" && host && msg.g) onApply(msg.g);
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
    // Personne en face : ni téléversement, ni réveil du salon.
    if (host && peers > 1 && mine && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "grid", width: WIDTH, height: HEIGHT, data: mine }));
    }
  }, 250);
});
