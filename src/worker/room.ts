import { DurableObject } from "cloudflare:workers";

/**
 * Salon d'un bac partagé. Le Durable Object **ne simule rien** : il relaie.
 * Le premier connecté est l'hôte, sa grille fait foi ; les autres lui envoient
 * leurs coups de pinceau et reçoivent ses instantanés. Un seul simulateur, donc
 * aucune divergence à arbitrer — le moteur tire au sort à chaque tick.
 *
 * ponytail: un instantané complet (~1 ko de RLE) quatre fois par seconde plutôt
 * qu'un delta. À revoir le jour où un salon dépasse la poignée de joueurs.
 */
export class Room extends DurableObject {
  /** Dernier instantané reçu, servi tel quel aux arrivants. Perdu si le DO hiberne. */
  private snapshot: string | null = null;

  fetch(): Response {
    const [client, server] = Object.values(new WebSocketPair());
    // API « hibernation » : le DO peut dormir sans fermer les sockets.
    this.ctx.acceptWebSocket(server);
    const host = this.ctx.getWebSockets().length === 1;
    server.serializeAttachment({ host });
    server.send(JSON.stringify({ type: "role", host }));
    if (!host && this.snapshot) server.send(this.snapshot);
    return new Response(null, { status: 101, webSocket: client });
  }

  webSocketMessage(from: WebSocket, message: string | ArrayBuffer): void {
    if (typeof message !== "string") return;
    if (message.startsWith('{"type":"grid"')) this.snapshot = message;
    for (const ws of this.ctx.getWebSockets()) if (ws !== from) ws.send(message);
  }

  webSocketClose(ws: WebSocket): void {
    this.promote(ws);
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
    if (left.some((ws) => (ws.deserializeAttachment() as { host: boolean } | null)?.host)) return;
    const next = left[0];
    if (!next) { this.snapshot = null; return; }
    next.serializeAttachment({ host: true });
    next.send(JSON.stringify({ type: "role", host: true }));
  }
}
