// A counted download hands out a resume token in a response header. With it,
// a body that breaks off is fetched again from the first missing byte by
// Range, and the server does not count it a second time. The token lives only
// in this closure, so it dies with the page.

export const RESUME_TOKEN_HEADER = "x-fd-resume-token";

export interface ResumeOptions {
  /** Attempts after a break that brought no new bytes. */
  retries?: number;
  /** Delay before the first attempt, doubled for each further one. */
  baseDelayMs?: number;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

class ResumeRefused extends Error {}

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Works like fetch for GET /api/d/{slug}. When the response carries a resume
 * token, its body survives dropped connections: each break is resumed up to
 * `retries` times in a row, with a growing delay, and the body errors only
 * when that fails or the server refuses. Any other response comes back as it
 * is.
 */
export async function fetchResumable(
  url: string,
  init: RequestInit = {},
  { retries = 5, baseDelayMs = 1000, fetchImpl = fetch, sleep = wait }: ResumeOptions = {},
): Promise<Response> {
  const first = await fetchImpl(url, init);
  const token = first.headers.get(RESUME_TOKEN_HEADER);
  if (!first.ok || !first.body || !token) return first;

  const total = Number(first.headers.get("content-length") ?? NaN);
  let reader: ReadableStreamDefaultReader<Uint8Array> = first.body.getReader();
  let offset = 0;
  let failures = 0;

  const reopen = async (): Promise<ReadableStreamDefaultReader<Uint8Array>> => {
    const headers = new Headers(init.headers);
    headers.set(RESUME_TOKEN_HEADER, token);
    headers.set("Range", `bytes=${offset}-`);
    const res = await fetchImpl(url, { ...init, headers });
    if (res.status === 429 || res.status >= 500) throw new Error(`resume ${res.status}`);
    if (res.status !== 206 || !res.body) throw new ResumeRefused(`resume ${res.status}`);
    if (!res.headers.get("content-range")?.startsWith(`bytes ${offset}-`)) {
      throw new ResumeRefused("resume answered the wrong range");
    }
    return res.body.getReader();
  };

  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      for (;;) {
        try {
          const { done, value } = await reader.read();
          if (!done) {
            offset += value.byteLength;
            failures = 0;
            controller.enqueue(value);
            return;
          }
          if (Number.isNaN(total) || offset >= total) {
            controller.close();
            return;
          }
          throw new Error(`body ended at ${offset} of ${total} bytes`);
        } catch (err) {
          if (init.signal?.aborted || err instanceof ResumeRefused) throw err;
          if (offset >= total) {
            controller.close();
            return;
          }
          if (++failures > retries) throw err;
          await sleep(baseDelayMs * 2 ** (failures - 1));
          try {
            reader = await reopen();
          } catch (reopenErr) {
            if (reopenErr instanceof ResumeRefused) throw reopenErr;
            // The next read fails at once and counts as the next attempt.
            reader = failedReader(reopenErr);
          }
        }
      }
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
  return new Response(body, { status: first.status, statusText: first.statusText, headers: first.headers });
}

function failedReader(err: unknown): ReadableStreamDefaultReader<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.error(err);
    },
  }).getReader();
}
