import { DurableObject } from "cloudflare:workers";
import { PLACES, cursor, freeId, nick, roster, route, unique, type Player } from "./relay.ts";

/**
 * Salon d'un bac partagé. Le Durable Object **ne simule rien** : il relaie.
 * Le premier connecté est l'hôte, il mène la partie : les autres lui envoient
 * leurs coups de pinceau, il les range dans sa partie au tick où il les
 * applique, et diffuse cette partie (un départ, puis sa suite). Le moteur
 * étant déterministe, chaque invité la rejoue chez lui et voit le même bac.
 *
 * Rien n'est gardé ici, pas même le dernier départ : l'hôte en renvoie un dès
 * que le compte de joueurs monte (`peers`), un arrivant n'attend donc qu'un
 * aller-retour.
 */
/**
 * Le joueur derrière un socket, gardé dans sa pièce jointe : elle survit à
 * l'hibernation. Un socket ouvert avant les pseudos n'a que `host` : il passe
 * pour le joueur 0, sans nom.
 */
function player(ws: WebSocket): Player {
  const p = ws.deserializeAttachment() as Partial<Player> | null;
  return { host: p?.host === true, id: p?.id ?? 0, name: p?.name ?? "" };
}
const isHost = (ws: WebSocket): boolean => player(ws).host;

export class Room extends DurableObject {
  fetch(request: Request): Response {
    const before = this.ctx.getWebSockets();
    if (before.length >= PLACES) {
      return new Response("salon complet", { status: 503 });
    }
    const [client, server] = Object.values(new WebSocketPair());
    // API « hibernation » : le DO peut dormir sans fermer les sockets.
    this.ctx.acceptWebSocket(server);
    const all = this.ctx.getWebSockets();
    const host = all.length === 1;
    const id = freeId(before.map((ws) => player(ws).id));
    const name = unique(nick(new URL(request.url).searchParams.get("nick")), before.map((ws) => player(ws).name));
    server.serializeAttachment({ host, id, name } satisfies Player);
    // Son numéro avec son rôle : la page s'en sert pour se reconnaître dans la liste.
    server.send(JSON.stringify({ type: "role", host, id }));
    this.announce(all);
    return new Response(null, { status: 101, webSocket: client });
  }

  webSocketMessage(from: WebSocket, message: string | ArrayBuffer): void {
    // Un curseur va à tous les autres, refait ici avec le numéro de l'émetteur
    // (relay.ts) : il ne touche pas la grille, invités compris.
    const pointer = cursor(message, player(from).id);
    if (pointer) {
      for (const ws of this.ctx.getWebSockets()) if (ws !== from) ws.send(pointer);
      return;
    }
    // La partie de l'hôte va aux invités, le geste d'un invité à l'hôte, et
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
   * seul — sans ça il téléverse sa partie vingt fois par seconde pour personne,
   * et réveille ce Durable Object autant de fois — et pour renvoyer un départ
   * quand quelqu'un arrive.
   */
  private announce(left: WebSocket[]): void {
    const message = JSON.stringify({ type: "peers", n: left.length });
    const players = roster(left.map(player));
    for (const ws of left) { ws.send(message); ws.send(players); }
  }

  webSocketError(ws: WebSocket): void {
    this.promote(ws);
  }

  /**
   * L'hôte est parti : le plus ancien socket restant prend la main. Sans ça le
   * salon reste figé, sans personne pour mener la partie. Le nouvel hôte a la
   * même grille que l'ancien (au retard près) : il repart de la sienne.
   */
  private promote(gone: WebSocket): void {
    const left = this.ctx.getWebSockets().filter((ws) => ws !== gone);
    this.announce(left);
    if (left.some(isHost)) return;
    const next = left[0];
    if (!next) return;
    const me = player(next);
    next.serializeAttachment({ ...me, host: true } satisfies Player);
    next.send(JSON.stringify({ type: "role", host: true, id: me.id }));
    // La liste annoncée plus haut n'avait plus d'hôte : elle repart avec le nouveau.
    const players = roster(left.map(player));
    for (const ws of left) ws.send(players);
  }
}
