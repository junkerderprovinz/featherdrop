import { test } from "node:test";
import assert from "node:assert/strict";
import { stripJpegMetadataBytes, isStrippableType } from "../lib/exif";

// Build a JPEG segment: marker (2 bytes) + length (2 bytes, incl. itself) + payload.
function seg(marker: number, payload: number[]): number[] {
  const len = payload.length + 2;
  return [0xff, marker & 0xff, (len >> 8) & 0xff, len & 0xff, ...payload];
}

const SOI = [0xff, 0xd8];
const APP0 = seg(0xe0, [0x4a, 0x46, 0x49, 0x46, 0x00, 1, 2]); // "JFIF"
const APP1 = seg(0xe1, [0x45, 0x78, 0x69, 0x66, 0x00, 0x00, 9, 9]); // "Exif" (GPS lives here)
const APP13 = seg(0xed, [0x50, 0x68, 0x6f, 0x74, 0x6f]); // IPTC/"Photo"shop
const DQT = seg(0xdb, [0x00, 1, 2, 3]);
// SOS: after its header the entropy-coded stream follows until EOI — the walker
// must copy everything verbatim from the SOS marker on.
const SOS_AND_DATA = [
  0xff, 0xda, 0x00, 0x04, 0x01, 0x02, /* image data: */ 0xaa, 0xbb, 0xcc,
  /* EOI: */ 0xff, 0xd9,
];

function jpeg(...parts: number[][]): Uint8Array {
  return new Uint8Array(parts.flat());
}

test("strips APP1 (EXIF) and APP13 (IPTC), keeps everything else", () => {
  const input = jpeg(SOI, APP0, APP1, APP13, DQT, SOS_AND_DATA);
  const { bytes, stripped } = stripJpegMetadataBytes(input);
  assert.equal(stripped, true);
  assert.deepEqual([...bytes], [...jpeg(SOI, APP0, DQT, SOS_AND_DATA)]);
});

test("a JPEG without metadata segments is returned unchanged", () => {
  const input = jpeg(SOI, APP0, DQT, SOS_AND_DATA);
  const { bytes, stripped } = stripJpegMetadataBytes(input);
  assert.equal(stripped, false);
  assert.equal(bytes, input); // same reference — nothing copied
});

test("non-JPEG bytes are returned unchanged", () => {
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]);
  const { bytes, stripped } = stripJpegMetadataBytes(png);
  assert.equal(stripped, false);
  assert.equal(bytes, png);
});

test("a malformed segment length bails out unchanged (never corrupts)", () => {
  // APP1 claiming a length that runs past the end of the buffer.
  const input = new Uint8Array([0xff, 0xd8, 0xff, 0xe1, 0xff, 0xff, 0x00]);
  const { bytes, stripped } = stripJpegMetadataBytes(input);
  assert.equal(stripped, false);
  assert.equal(bytes, input);
});

test("image data after SOS is copied verbatim (incl. 0xFFE1-looking bytes)", () => {
  // Entropy-coded data may contain byte pairs that LOOK like markers; the
  // walker must stop parsing at SOS and never touch them.
  const data = [0xff, 0xda, 0x00, 0x04, 0x01, 0x02, 0xff, 0xe1, 0x00, 0x02, 0xff, 0xd9];
  const input = jpeg(SOI, APP1, [ ...data ]);
  const { bytes, stripped } = stripJpegMetadataBytes(input);
  assert.equal(stripped, true);
  assert.deepEqual([...bytes], [...jpeg(SOI, [ ...data ])]);
});

test("isStrippableType matches JPEG mime types only", () => {
  assert.equal(isStrippableType("image/jpeg"), true);
  assert.equal(isStrippableType("image/jpg"), true);
  assert.equal(isStrippableType("image/png"), false);
  assert.equal(isStrippableType("application/pdf"), false);
});
