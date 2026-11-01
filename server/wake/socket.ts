import type { FastifyRequest } from 'fastify';

/**
 * Socket helpers for waiting reads (long-polls and streams). A leaf module (type imports only), so
 * the guest routes (links/routes.ts) can use them without pulling wake/routes.ts into their
 * import graph: in the single-file bundle a new import edge can reorder module initialization.
 */

/** Aborts when the client's connection closes (a long-poll or stream nobody reads any more). */
export function disconnectSignal(request: FastifyRequest): { signal: AbortSignal; done(): void } {
  const controller = new AbortController();
  const socket = request.raw.socket;
  const abort = () => controller.abort();
  socket?.once?.('close', abort);
  return { signal: controller.signal, done: () => socket?.off?.('close', abort) };
}

/**
 * Node's idle-socket timeout (Fastify connectionTimeout 15 s) must outlast a 25 s wait. Called
 * only after authentication and only for a real wait, so unauthenticated sockets keep 15 s.
 */
export function keepSocket(request: FastifyRequest, ms: number): void {
  request.raw.socket?.setTimeout?.(ms);
}
