// Photo metadata can only be removed in the browser, since the server never
// sees plaintext. JPEG metadata lives in marker segments between SOI and SOS,
// so dropping these leaves the image data untouched:
//   APP1  (0xFFE1): EXIF, including GPS, and XMP
//   APP13 (0xFFED): IPTC and Photoshop captions, credits, sometimes location
// JFIF, ICC colour profiles, Adobe APP14 and all image segments are kept.

const SOI = 0xffd8;
const SOS = 0xffda; // entropy-coded image data follows
const APP1 = 0xffe1;
const APP13 = 0xffed;

export interface StripResult {
  bytes: Uint8Array;
  /** True when at least one metadata segment was removed. */
  stripped: boolean;
}

/**
 * Drops the APP1 and APP13 segments from a JPEG. Anything that is not a JPEG or
 * fails to parse comes back unchanged, so a scrub never corrupts a file.
 */
export function stripJpegMetadataBytes(bytes: Uint8Array): StripResult {
  if (bytes.length < 4) return { bytes, stripped: false };
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint16(0) !== SOI) return { bytes, stripped: false };

  const keep: Array<[number, number]> = [[0, 2]];
  let stripped = false;
  let pos = 2;

  while (pos + 4 <= bytes.length) {
    if (bytes[pos] !== 0xff) return { bytes, stripped: false };
    const marker = view.getUint16(pos);
    if (marker === SOS) {
      keep.push([pos, bytes.length]);
      break;
    }
    const segLen = view.getUint16(pos + 2); // includes the 2 length bytes
    if (segLen < 2 || pos + 2 + segLen > bytes.length) {
      return { bytes, stripped: false };
    }
    const end = pos + 2 + segLen;
    if (marker === APP1 || marker === APP13) {
      stripped = true;
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

/**
 * Only JPEG carries EXIF in a form that can be stripped by segment; camera
 * metadata in PNG and WebP is rare and left alone.
 */
export function isStrippableType(type: string): boolean {
  return type === "image/jpeg" || type === "image/jpg";
}

/**
 * Returns the file unchanged unless it is a JPEG that held metadata segments.
 * Name, type and modification time are kept.
 */
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
    // Uploading the original beats breaking the upload.
    return file;
  }
}
