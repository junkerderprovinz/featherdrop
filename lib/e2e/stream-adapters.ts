// Adapters between ReadableStream and the AsyncIterable<Uint8Array> the
// pipeline modules use.

// lib.dom declares the async iterator on every ReadableStream, so an inline
// `Symbol.asyncIterator in rs` check would narrow rs to never in the fallback.
// A plain boolean function keeps the fallback typed for older browsers.
function supportsAsyncIterator(rs: ReadableStream<Uint8Array>): boolean {
  return Symbol.asyncIterator in rs;
}

/**
 * Wraps a ReadableStream as an AsyncIterable, using the stream's own iterator
 * where the browser has one and a reader loop otherwise.
 */
export function streamToAsyncIterable(
  rs: ReadableStream<Uint8Array>,
): AsyncIterable<Uint8Array> {
  if (supportsAsyncIterator(rs)) {
    return rs as unknown as AsyncIterable<Uint8Array>;
  }
  return {
    [Symbol.asyncIterator]() {
      const reader = rs.getReader();
      return {
        async next() {
          const { done, value } = await reader.read();
          if (done) {
            reader.releaseLock();
            return { done: true as const, value: undefined };
          }
          return { done: false as const, value: value as Uint8Array };
        },
        async return() {
          try {
            await reader.cancel();
          } catch {
            /* ignore */
          }
          reader.releaseLock();
          return { done: true as const, value: undefined };
        },
      };
    },
  };
}

/** Wraps an AsyncIterable as a ReadableStream that pulls one chunk at a time. */
export function asyncIterableToStream(
  it: AsyncIterable<Uint8Array>,
): ReadableStream<Uint8Array> {
  const iter = it[Symbol.asyncIterator]();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const { done, value } = await iter.next();
      if (done) {
        controller.close();
      } else {
        // The chunks are ArrayBuffer-backed; the cast satisfies enqueue's type.
        controller.enqueue(value as Uint8Array<ArrayBuffer>);
      }
    },
    async cancel(reason) {
      try {
        await iter.return?.(reason);
      } catch {
        /* ignore */
      }
    },
  });
}

/**
 * Passes rs through and settles consumed once a reader has read it to the
 * end, or rejects when it fails or the reader cancels. A save such as
 * streamToDownload resolves before the browser has read a byte, so this is
 * how a caller learns that a download really finished.
 */
export function watchConsumed(rs: ReadableStream<Uint8Array>): {
  stream: ReadableStream<Uint8Array>;
  consumed: Promise<void>;
} {
  let finished!: () => void;
  let failed!: (e: unknown) => void;
  const consumed = new Promise<void>((resolve, reject) => {
    finished = resolve;
    failed = reject;
  });
  consumed.catch(() => {});
  const reader = rs.getReader();
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          controller.close();
          finished();
        } else {
          controller.enqueue(value as Uint8Array<ArrayBuffer>);
        }
      } catch (e) {
        failed(e);
        controller.error(e);
      }
    },
    cancel(reason) {
      failed(new Error("the save stopped reading"));
      return reader.cancel(reason);
    },
  });
  return { stream, consumed };
}
