// Client-side photo-metadata removal — the only place it CAN happen in a
// zero-knowledge app: the server never sees plaintext, so any EXIF/GPS scrub
// must run in the browser BEFORE encryption. JPEG metadata lives in marker
// segments between SOI and SOS; dropping the right segments never touches
// image data, so the photo is byte-identical to look at:
//   APP1  (0xFFE1) — EXIF (incl. GPS) and XMP
//   APP13 (0xFFED) — IPTC/Photoshop (captions, credits, sometimes location)
// Everything else (JFIF APP0, ICC APP2 colour profiles, Adobe APP14, all
// DQT/DHT/SOF/SOS image segments) is preserved. Pure byte-level function, no
// DOM — fully unit-testable; the File wrapper below is the only browser bit.

const SOI = 0xffd8; // start of image
const SOS = 0xffda; // start of scan — from here on it's entropy-coded data
const APP1 = 0xffe1;
const APP13 = 0xffed;

export interface StripResult {
  bytes: Uint8Array;
  /** True when at least one metadata segment was removed. */
  stripped: boolean;
}

/** Drop EXIF/XMP (APP1) + IPTC (APP13) segments from a JPEG. Non-JPEG input
 *  (or anything that fails to parse) is returned unchanged — never corrupt a
 *  file for the sake of a scrub. */
export function stripJpegMetadataBytes(bytes: Uint8Array): StripResult {
  if (bytes.length < 4) return { bytes, stripped: false };
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint16(0) !== SOI) return { bytes, stripped: false };

  const keep: Array<[number, number]> = [[0, 2]]; // SOI itself
  let stripped = false;
  let pos = 2;

  while (pos + 4 <= bytes.length) {
    if (bytes[pos] !== 0xff) return { bytes, stripped: false }; // malformed — bail out unchanged
    const marker = view.getUint16(pos);
    if (marker === SOS) {
      // Image data starts; copy the rest verbatim and stop walking.
      keep.push([pos, bytes.length]);
      break;
    }
    const segLen = view.getUint16(pos + 2); // includes the 2 length bytes
    if (segLen < 2 || pos + 2 + segLen > bytes.length) {
      return { bytes, stripped: false }; // malformed length — bail out unchanged
    }
    const end = pos + 2 + segLen;
    if (marker === APP1 || marker === APP13) {
      stripped = true; // drop it
    } else {
      keep.push([pos, end]);
    }
    pos = end;
  }

  if (!stripped) return { bytes, stripped: false };

  const total = keep.reduce((sum, [s, e]) => sum + (e - s), 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const [s, e] of keep) {
    out.set(bytes.subarray(s, e), off);
    off += e - s;
  }
  return { bytes: out, stripped: true };
}

/** Types the scrub applies to. Only JPEG carries EXIF in a form we strip
 *  segment-wise; PNG/WebP metadata is rare from cameras and left alone. */
export function isStrippableType(type: string): boolean {
  return type === "image/jpeg" || type === "image/jpg";
}

/** File-level wrapper: returns the original File untouched unless it is a JPEG
 *  that actually contained metadata segments. Name/type/mtime are preserved. */
export async function stripFileMetadata(file: File): Promise<File> {
  if (!isStrippableType(file.type)) return file;
  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const { bytes: out, stripped } = stripJpegMetadataBytes(bytes);
    if (!stripped) return file;
    return new File([out as BlobPart], file.name, {
      type: file.type,
      lastModified: file.lastModified,
    });
  } catch {
    return file; // read failure → upload the original rather than break the flow
  }
}
