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
 * Chacun entre avec un pseudo (Paramètres › Général), que le salon nettoie et
 * numérote (1 à 8, d'où la couleur) ; la liste des joueurs s'affiche sous la
 * barre de statut, et chacun voit les curseurs des autres. Le curseur ne
 * touche pas la grille : il voyage à part (`cursor`), au plus toutes les
 * `POINT` ms, et ne peut pas faire diverger le lockstep.
 *
 * ponytail: un pseudo n'est pas une identité — rien ne l'authentifie, deux
 * joueurs peuvent porter le même, et il n'y a pas de verrou : qui entre peint.
 * Et un invité voit son propre coup de pinceau après un aller-retour : pas de
 * prédiction locale.
 *
 * Ce module ne connaît ni le bouton Pause ni le sélecteur de taille : il les
 * demande par des rappels, sinon il faudrait importer main.ts et boucler.
 */
import { HEIGHT, WIDTH, cellBox, listen, order } from "./world.ts";
import type { Gesture } from "./gestures.ts";
import { peerColor } from "./ui.ts";

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
const nickInput = document.querySelector<HTMLInputElement>("#nick")!;
const rosterEl = document.querySelector<HTMLUListElement>("#roster")!;
const peersEl = document.querySelector<HTMLDivElement>("#peers")!;

/** Un joueur du salon tel que la page le montre ; `x`, `y` : la cellule sous son curseur (-1 : hors du bac). */
interface Peer { name: string; host: boolean; x: number; y: number; el: HTMLDivElement | null }
/** Les joueurs, par numéro (donné par le salon). Le nôtre y est, sans curseur. */
const players = new Map<number, Peer>();
/** Notre numéro dans le salon (message `role`) ; 0 tant qu'on ne le connaît pas. */
let me = 0;
const nameOf = (id: number, name: string): string => name || `Joueur ${id}`;

/** La liste des joueurs (message `roster`) : refait la liste affichée et les curseurs, garde les positions connues. */
function seat(list: unknown): void {
  if (!Array.isArray(list)) return;
  const next = new Map<number, Peer>();
  for (const p of list) {
    if (!p || typeof p.id !== "number" || typeof p.name !== "string") continue;
    const old = players.get(p.id);
    next.set(p.id, { name: p.name, host: p.host === true, x: old?.x ?? -1, y: old?.y ?? -1, el: old?.el ?? null });
  }
  // Un joueur parti emporte son curseur.
  for (const [id, p] of players) if (!next.has(id)) p.el?.remove();
  players.clear();
  for (const [id, p] of next) players.set(id, p);
  drawRoster();
}

/** La liste affichée sous la barre de statut, et un curseur par autre joueur. */
function drawRoster(): void {
  rosterEl.hidden = players.size === 0;
  rosterEl.replaceChildren(...[...players].sort(([a], [b]) => a - b).map(([id, p]) => {
    const li = document.createElement("li");
    li.style.setProperty("--peer", peerColor(id)); // CSSOM : la CSP refuse l'attribut style=
    // textContent : le pseudo vient d'un autre joueur.
    li.textContent = nameOf(id, p.name) + (p.host ? " (hôte)" : "") + (id === me ? " (vous)" : "");
    if (id === me) {
      li.className = "me";
      p.el?.remove();
      p.el = null;
      return li;
    }
    if (!p.el) {
      p.el = document.createElement("div");
      p.el.className = "peer";
      p.el.hidden = true;
      p.el.style.setProperty("--peer", peerColor(id));
      p.el.append(document.createElement("span"));
      peersEl.append(p.el);
    }
    p.el.querySelector("span")!.textContent = nameOf(id, p.name);
    return li;
  }));
}

/**
 * Replace les curseurs des autres sur la scène : main.ts l'appelle à chaque
 * image, zoom et caméra compris, comme le cadre du héros.
 */
export function placeCursors(): void {
  if (players.size === 0) return;
  const c = cellBox(), stage = peersEl.getBoundingClientRect();
  for (const p of players.values()) {
    if (!p.el) continue;
    // Une grille d'une autre taille (le temps d'un nouveau départ) : on ne sait pas où il est.
    const away = p.x < 0 || p.x >= WIDTH || p.y >= HEIGHT;
    p.el.hidden = away;
    if (!away) p.el.style.transform = `translate(${c.left - stage.left + (p.x + 0.5) * c.sx}px, ${c.top - stage.top + (p.y + 0.5) * c.sy}px)`;
  }
}

/**
 * Intervalle minimal entre deux curseurs envoyés, en ms : chaque curseur
 * réveille le Durable Object et part à tous les autres. 80 ms suivent un geste
 * sans saccade gênante ; à huit joueurs, ~100 messages par seconde au plus.
 */
const POINT = 80;
let pending: [number, number] | null = null;
let pointed = "";
let pointTimer = 0;

/** La cellule sous notre curseur (-1, -1 : hors du bac), à montrer aux autres. main.ts l'appelle avec la sonde. */
export function pointAt(x: number, y: number): void {
  if (socket?.readyState !== WebSocket.OPEN || peers < 2) return;
  pending = [x, y];
  if (!pointTimer) pointTimer = window.setTimeout(flushPoint, POINT);
}

function flushPoint(): void {
  pointTimer = 0;
  if (!pending) return;
  const [x, y] = pending;
  pending = null;
  // Le pinceau tenu immobile rappelle la sonde à chaque image : rien de neuf à dire.
  if (`${x},${y}` === pointed) return;
  pointed = `${x},${y}`;
  send(JSON.stringify({ type: "cursor", x, y }));
}
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
  me = 0;
  pointed = "";
  players.clear();
  peersEl.replaceChildren();
  drawRoster();
  order({ t: "host", on: false });
  order({ t: "follow", rec: null });
  roomButton.textContent = "Bac partagé";
  // On redevient maître de son bac : sans ça un invité qui part reste en pause.
  onRole(true);
}

/** Reconnexion en attente après une coupure, annulée si le joueur reprend la main. */
let retry = 0;
/** Le joueur a demandé à partir : la fermeture qui suit n'est pas une coupure. */
let quitting = false;

roomButton.addEventListener("click", () => {
  clearTimeout(retry);
  if (socket) { quitting = true; socket.close(); return; }
  const name = prompt("Nom du salon ?", "public");
  if (name) join(name);
});

/**
 * Entre dans le salon. Une connexion établie qui tombe (Wi-Fi qui saute,
 * déploiement du Worker) est retentée une fois après une seconde : sans ça il
 * fallait retaper le nom du salon. Une tentative qui n'aboutit pas ne relance
 * rien, donc pas de boucle contre un salon plein ou un Worker à terre.
 */
function join(name: string): void {
  quitting = false;
  // Le pseudo voyage dans l'URL : le salon le nettoie et le range avec le socket.
  const nick = encodeURIComponent(nickInput.value.trim());
  const ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/api/room/${encodeURIComponent(name)}?nick=${nick}`);
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
      if (typeof msg.id === "number") { me = msg.id; drawRoster(); }
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
    if (msg.type === "roster") seat(msg.players);
    if (msg.type === "cursor" && Number.isInteger(msg.x) && Number.isInteger(msg.y)) {
      const p = players.get(msg.id);
      if (p) { p.x = msg.x; p.y = msg.y; }
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
      resync = window.setTimeout(restart, Math.max(0, lastStart + RESYNC - Date.now()));
    }
  });
  // Une connexion qui échoue déclenche « error » puis « close » : sans ce
  // drapeau, « Salon quitté » effacerait aussitôt « Salon injoignable ».
  let failed = false;
  let opened = false;
  ws.addEventListener("open", () => (opened = true));
  ws.addEventListener("error", () => (failed = true));
  ws.addEventListener("close", () => {
    leaveRoom();
    if (opened && !quitting) {
      statusEl.textContent = `Salon « ${name} » perdu, reconnexion…`;
      retry = window.setTimeout(() => join(name), 1000);
      return;
    }
    statusEl.textContent = failed ? "Salon injoignable." : "Salon quitté.";
  });
}
