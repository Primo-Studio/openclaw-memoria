/**
 * Erreur HTTP attendue (4xx, ou 5xx posé sciemment) : `reportAndSend` (server.ts)
 * la rend telle quelle au client, sans stack dans le journal sauf pour 500.
 * À part de server.ts pour que les modules de routes (triage-routes.ts) lèvent
 * la même classe.
 */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
  }
}
