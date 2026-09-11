import { DurableObject } from "cloudflare:workers";
import { route } from "./relay.ts";

/**
 * Salon d'un bac partagé. Le Durable Object **ne simule rien** : il relaie.
 * Le premier connecté est l'hôte, sa grille fait foi ; les autres lui envoient
 * leurs coups de pinceau et reçoivent ses instantanés. Un seul simulateur, donc
 * aucune divergence à arbitrer — le moteur tire au sort à chaque tick.
 *
 * Rien n'est gardé ici, pas même la dernière grille : l'hôte en diffuse une
 * toutes les 250 ms, un arrivant n'attend donc jamais plus que ça.
 *
 * ponytail: un instantané complet (~1 ko de RLE) quatre fois par seconde plutôt
 * qu'un delta. À revoir le jour où un salon dépasse la poignée de joueurs.
 */
/** Joueurs par salon. Au-delà, la diffusion (une grille par joueur, 4 fois par seconde) coûte plus qu'elle ne rend. */
const PLACES = 8;

/** Le rôle est gardé dans la pièce jointe du socket : elle survit à l'hibernation. */
const isHost = (ws: WebSocket): boolean =>
  (ws.deserializeAttachment() as { host: boolean } | null)?.host === true;

export class Room extends DurableObject {
  fetch(): Response {
    if (this.ctx.getWebSockets().length >= PLACES) {
      return new Response("salon complet", { status: 503 });
    }
    const [client, server] = Object.values(new WebSocketPair());
    // API « hibernation » : le DO peut dormir sans fermer les sockets.
    this.ctx.acceptWebSocket(server);
    const all = this.ctx.getWebSockets();
    const host = all.length === 1;
    server.serializeAttachment({ host });
    server.send(JSON.stringify({ type: "role", host }));
    this.announce(all);
    return new Response(null, { status: 101, webSocket: client });
  }

  webSocketMessage(from: WebSocket, message: string | ArrayBuffer): void {
    // La grille de l'hôte va aux invités, le geste d'un invité à l'hôte, et
    // rien d'autre ne passe (voir relay.ts) : un invité ne parle jamais aux
    // autres invités.
    const to = route(message, isHost(from));
    if (!to) return;
    for (const ws of this.ctx.getWebSockets()) {
      if (ws !== from && isHost(ws) === (to === "host")) ws.send(message as string);
    }
  }

  webSocketClose(ws: WebSocket): void {
    this.promote(ws);
  }

  /**
   * Combien de monde dans le salon. L'hôte s'en sert pour se taire quand il est
   * seul : sans ça il téléverse sa grille quatre fois par seconde pour personne,
   * et réveille ce Durable Object autant de fois.
   */
  private announce(left: WebSocket[]): void {
    const message = JSON.stringify({ type: "peers", n: left.length });
    for (const ws of left) ws.send(message);
  }

  webSocketError(ws: WebSocket): void {
    this.promote(ws);
  }

  /**
   * L'hôte est parti : le plus ancien socket restant prend la main. Sans ça le
   * salon continue de tourner sans personne pour simuler.
   */
  private promote(gone: WebSocket): void {
    const left = this.ctx.getWebSockets().filter((ws) => ws !== gone);
    this.announce(left);
    if (left.some(isHost)) return;
    const next = left[0];
    if (!next) return;
    next.serializeAttachment({ host: true });
    next.send(JSON.stringify({ type: "role", host: true }));
  }
}
