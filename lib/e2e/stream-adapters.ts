// Tiny adapters between the Web Streams API (ReadableStream) and the
// AsyncIterable<Uint8Array> convention used by the pipeline modules.
// Browser-compatible; no Node.js-specific APIs.

/**
 * Wrap a ReadableStream<Uint8Array> as an AsyncIterable<Uint8Array>.
 * Uses the stream's built-in async iterator if available (Chromium ≥ 124),
 * otherwise falls back to a reader loop so every browser is covered.
 */
export function streamToAsyncIterable(
  rs: ReadableStream<Uint8Array>,
): AsyncIterable<Uint8Array> {
  // The ReadableStream async iterator is defined in the Streams spec and
  // available in modern browsers; TS's lib.dom may not yet declare it on
  // the type so we probe at runtime via the well-known symbol.
  if (Symbol.asyncIterator in rs) {
    return rs as unknown as AsyncIterable<Uint8Array>;
  }
  // Fallback: reader loop.
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
          // Chunks from ReadableStream are Uint8Array at runtime; the cast
          // satisfies TS 5.9's stricter Uint8Array<ArrayBuffer> requirement.
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

/**
 * Wrap an AsyncIterable<Uint8Array> as a ReadableStream<Uint8Array>.
 * The stream pulls one chunk at a time from the iterator.
 */
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
        // value is Uint8Array at runtime; cast satisfies TS 5.9 strict enqueue typing.
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
