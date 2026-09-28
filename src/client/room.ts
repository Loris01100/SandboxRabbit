/**
 * Le bac partagé, côté navigateur. En face, un Durable Object qui ne fait que
 * relayer (src/worker/room.ts).
 *
 * Lockstep : chacun simule chez soi. L'hôte mène la partie — les gestes des
 * invités lui arrivent, il les applique au tick où il en est et les range dans
 * sa partie, qu'il diffuse **dès qu'il n'est pas seul** : un départ (`start`,
 * la grille entière et l'état du tirage), puis vingt fois par seconde la suite
 * (`turn` : les gestes et changements de réglage, et jusqu'où il est allé).
 * Chaque invité la rejoue dans son bac, un peu derrière l'hôte ; le moteur
 * étant déterministe, tous voient le même bac à 60 images par seconde, pour
 * quelques octets par geste. C'est le rejeu de replay.ts, en direct.
 *
 * Une fois par seconde l'hôte joint l'empreinte de sa grille : un invité qui
 * ne la retrouve pas demande un nouveau départ (`sync`).
 *
 * ponytail: pas d'identité ni de verrou, qui entre peint. Et un invité voit
 * son propre coup de pinceau après un aller-retour : pas de prédiction locale.
 *
 * Ce module ne connaît ni le bouton Pause ni le sélecteur de taille : il les
 * demande par des rappels, sinon il faudrait importer main.ts et boucler.
 */
import { HEIGHT, WIDTH, listen, order } from "./world.ts";
import type { Gesture } from "./gestures.ts";

/** Appelé quand on devient hôte (true) ou invité (false) : un invité ne pilote pas la pause. */
let onRole: (host: boolean) => void = () => {};
/** Appelé quand l'hôte impose sa taille de grille. */
let onSize: (w: number, h: number) => void = () => {};
/**
 * Applique le geste d'un invité. C'est main.ts qui le fait, pas ce module : le
 * geste d'un pair doit emprunter le même chemin que ceux de l'hôte, sinon il
 * manque à l'enregistrement de la partie (replay.ts).
 */
let onApply: (g: Gesture) => void = () => {};

export function initRoom(hooks: {
  role(host: boolean): void;
  size(w: number, h: number): void;
  apply(g: Gesture): void;
}): void {
  onRole = hooks.role;
  onSize = hooks.size;
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
let room = "";
let host = false;
/** Connectés au salon, compté par le Durable Object. Seul, l'hôte ne diffuse rien. */
let peers = 1;
/** Plafond d'un message relayé par le salon (`MAX` de src/worker/relay.ts). */
const HEAVY = 200_000;
/**
 * Un départ coûte la grille entière à chaque invité : un invité qui divergerait
 * sans cesse (ou qui le prétendrait) n'en obtient pas plus d'un toutes les
 * `RESYNC` ms. La demande est différée, pas jetée : sinon il resterait figé.
 */
const RESYNC = 2000;
let lastStart = 0;
let resync = 0;

/** L'hôte (re)part de sa grille présente, si quelqu'un est là pour la suivre. */
function restart(): void {
  clearTimeout(resync);
  resync = 0;
  if (!host) return;
  order({ t: "host", on: peers >= 2 });
}

function send(message: string): void {
  if (socket?.readyState !== WebSocket.OPEN) return;
  if (message.length > HEAVY) {
    statusEl.textContent = "Grille trop chargée pour le salon : les invités ne la reçoivent plus.";
    return;
  }
  socket.send(message);
}

listen((news) => {
  if (!socket) return;
  if (news.t === "start" && host) {
    lastStart = Date.now();
    send(JSON.stringify({ type: "start", rec: news.rec }));
  }
  if (news.t === "turn" && host) {
    send(JSON.stringify({ type: "turn", ticks: news.ticks, beats: news.beats, sums: news.sums }));
  }
  if (news.t === "desync" && !host) send(JSON.stringify({ type: "sync" }));
});

function leaveRoom(): void {
  clearTimeout(resync);
  resync = 0;
  socket = null;
  host = false;
  peers = 1;
  order({ t: "host", on: false });
  order({ t: "follow", rec: null });
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
  room = name;
  roomButton.textContent = "Quitter le salon";
  statusEl.textContent = `Connexion au salon « ${name} »…`;

  ws.addEventListener("message", (e) => {
    // Le salon relaie sans lire : ce qui arrive n'est pas forcément du JSON.
    const msg = parse(e.data as string);
    if (!msg) return;
    if (msg.type === "role") {
      host = msg.host === true;
      onRole(host);
      statusEl.textContent = host
        ? `Salon « ${room} » — vous menez la partie.`
        : `Salon « ${room} » — vous suivez l'hôte.`;
      if (host) {
        order({ t: "follow", rec: null });
        restart();
      }
    }
    if (msg.type === "peers" && typeof msg.n === "number") {
      const before = peers;
      peers = msg.n;
      if (host && (peers > before || peers < 2)) restart();
    }
    if (msg.type === "start" && !host && msg.rec && typeof msg.rec === "object") {
      const { w, h } = msg.rec;
      if (w !== WIDTH || h !== HEIGHT) onSize(w, h);
      if (w !== WIDTH || h !== HEIGHT) return;
      order({ t: "follow", rec: msg.rec });
    }
    if (msg.type === "turn" && !host && typeof msg.ticks === "number" && Array.isArray(msg.beats) && Array.isArray(msg.sums)) {
      order({ t: "turn", ticks: msg.ticks, beats: msg.beats, sums: msg.sums });
    }
    if (msg.type === "do" && host && msg.g) onApply(msg.g);
    if (msg.type === "sync" && host && !resync) {
      resync = setTimeout(restart, Math.max(0, lastStart + RESYNC - Date.now()));
    }
  });
  // Une connexion qui échoue déclenche « error » puis « close » : sans ce
  // drapeau, « Salon quitté » effacerait aussitôt « Salon injoignable ».
  let failed = false;
  ws.addEventListener("error", () => (failed = true));
  ws.addEventListener("close", () => {
    leaveRoom();
    statusEl.textContent = failed ? "Salon injoignable." : "Salon quitté.";
  });
});
