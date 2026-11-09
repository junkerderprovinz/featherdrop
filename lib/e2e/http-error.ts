// A refusal from the server that the page explains to the person: the status
// tells a missing share from a wrong password or a busy one, and a 429 says
// how long to wait.

export class HttpError extends Error {
  constructor(
    what: string,
    readonly status: number,
    /** Seconds the server asks to wait before trying again, or null. */
    readonly retryAfter: number | null,
  ) {
    super(`${what} ${status}`);
    this.name = "HttpError";
  }
}

/** Reads a Retry-After header, which holds either seconds or an HTTP date. */
export function retryAfterSeconds(value: string | null, now = Date.now()): number | null {
  if (!value) return null;
  if (/^\d+$/.test(value.trim())) return Number(value);
  const at = Date.parse(value);
  return Number.isNaN(at) ? null : Math.max(0, Math.ceil((at - now) / 1000));
}

export const httpError = (what: string, res: Response) =>
  new HttpError(what, res.status, retryAfterSeconds(res.headers.get("Retry-After")));
