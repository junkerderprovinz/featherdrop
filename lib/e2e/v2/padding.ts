// Padmé padding (Nikitin et al., "Reducing Metadata Leakage from Encrypted
// Files and Communication with PURBs", PETS 2019). A padded length keeps only
// the top floor(log2(E)) + 1 bits of the length's E-bit exponent, so it leaks
// O(log log n) bits about the real length at an overhead of at most about 12%.

/** Content shorter than this is padded up to it, so tiny files all look alike. */
export const MIN_CONTENT_PAD = 4096;

/** The sealed header is padded to at least this, which hides short names and small file counts. */
export const MIN_HEADER_PAD = 1024;

function floorLog2(n: number): number {
  // Math.log2 can round up just below a large power of two.
  let e = 0;
  let p = 1;
  while (p * 2 <= n) {
    p *= 2;
    e++;
  }
  return e;
}

export function padme(len: number): number {
  if (!Number.isSafeInteger(len) || len < 0) {
    throw new Error("padme: length must be a non-negative safe integer");
  }
  if (len < 2) return len;
  const e = floorLog2(len);
  const s = floorLog2(e) + 1;
  const step = 2 ** (e - s);
  return Math.ceil(len / step) * step;
}

export function paddedContentLength(size: number): number {
  return padme(Math.max(size, MIN_CONTENT_PAD));
}

export function paddedHeaderLength(len: number): number {
  return padme(Math.max(len, MIN_HEADER_PAD));
}
