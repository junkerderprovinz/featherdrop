# featherdrop multi-file upload — design

**Goal:** Let the user select/drop several files, upload them under **one** share
link, and have the recipient get the **original files back individually** (not a
zip). Stays zero-knowledge: the server still stores/serves **one opaque blob** and
never learns it holds multiple files.

## Approach (chosen with the user)

One encrypted blob, N files packed inside, unpacked client-side on download.
**Not** a zip — our own manifest format inside the existing libsodium secretstream.
A dropped folder / archive is never required; we only concatenate the chosen files.

### Blob format

The existing single-file blob is `[varint(metaLen)][enc_meta][secretstream header][frames]`,
where `enc_meta` encrypts `FileMeta {name,type}` and the secretstream carries the
single file's bytes (`lib/e2e/blob-layout.ts`, `lib/e2e/crypto.ts`).

Multi-file keeps that exact envelope and only changes the two payloads:

- **`enc_meta`** encrypts a **manifest**: `{ files: [{ name, type, size }, …] }`
  (size = plaintext byte length per file). Same `encryptMeta`/`decryptMeta`
  (they JSON-serialize whatever object they're given).
- **secretstream content** = the N files' bytes **concatenated in manifest order**
  (`file0 ‖ file1 ‖ …`). Unchanged `encryptChunks`/`decryptChunks`; it just
  encrypts a longer logical stream. On download the plaintext stream is split back
  by the manifest `size`s.

This means **zero crypto changes** — only a new pack/unpack layer around the
existing primitives, and a richer meta object.

### Format versioning (DB `format` column)

`format` already exists: `1` = legacy age, `2` = zero-knowledge single file.
Add **`3` = zero-knowledge multi-file**. To avoid any regression of the existing
single-file UX (inline preview, current download page):

- Upload of **1 file** → `format = 2` (today's path, untouched).
- Upload of **2+ files** → `format = 3` (new manifest path).
- Old `format = 1/2` links keep working exactly as now (additive change).

`key_verifier`, password/link modes, expiry, download-limit, branding all apply to
`format = 3` unchanged (they operate on the one blob, not the file count).

## Upload flow

`lib/e2e/upload-flow.ts` takes `File[]` instead of one `File`:
- 1 file → current single-file path (format 2).
- N files → build the manifest (name/type/size per file), concatenate the file
  streams into one plaintext `AsyncIterable`, `encryptForUpload` with the manifest
  meta, OPFS scratch → tus → finalize with `format: 3`. Still one slug, one key,
  one link. The 500 MB in-memory fallback cap (no-OPFS / HTTP) applies to the
  **combined** size.

## Download flow

`format = 3` on the download page:
1. Derive key (URL `#k=` or password) → fetch the one blob → decrypt.
2. Read the manifest → split the plaintext stream into the N files by `size`.
3. Present a **file list** (name + size). Saving the originals (no zip):
   - **Everywhere:** per-file "Download" button + "Download all" that saves them
     sequentially (Chrome shows its one-time "allow multiple downloads" prompt).
     Original names preserved.
   - **Chromium + secure context (optional):** a "Save to folder" button via the
     File System Access API (`showDirectoryPicker`) writes all files into a chosen
     folder. Absent on Firefox / plain-HTTP → the list/Download-all is the fallback.
   - No inline preview for multi-file (single-file `format = 2` keeps its preview).

Large bundles stream per-file through the existing download service worker
(`lib/e2e/stream-download.ts`) one at a time; the in-memory blob path is the
fallback for small bundles / no-SW contexts (mirrors today's single-file logic).

## UI

- `components/DropArea.tsx`: `multiple` enabled; `onDrop` collects all files (still
  via the `filesFromDropEvent` helper from #4 — no `webkitGetAsEntry`).
- `app/page.tsx`: hold `File[]`; show the selected files (names + total size); the
  settings/encrypt/upload flow operates on the list.
- `components/DownloadView.tsx`: render the manifest list + the save controls above.
- New i18n keys (file count, total size, "Download all", "Save to folder", "N files")
  in **all 26 locales** (parity test enforces completeness).

## Out of scope / non-goals

- No zip output. No server-side knowledge of the file set (stays one opaque blob).
- No per-file expiry/limit (the share is one unit).
- No folder/directory drop traversal (we never call `webkitGetAsEntry`).

## Testing

- `lib/e2e/multi-file.ts` (pack/unpack manifest + stream split) — pure, unit-tested
  first (TDD): round-trip N files, byte-exact, boundary splits across 64 KiB chunks,
  1-file and 0-byte-file edge cases.
- End-to-end (existing CI Playwright `test/e2e`): extend to upload 2 files via the
  link, then assert both come back byte-identical.
- `tsc`, `next lint`, locale parity, unit + e2e all green before release.

## Rollout

Phased (TDD), then **one release** (likely v4.2.0 — a feature, backward
compatible). Subagents for UI wiring + the 26 locales; crypto/format/pack by hand.
