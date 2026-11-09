import { test } from "node:test";
import assert from "node:assert/strict";
import { uploadNote, readNote, NOTE_TYPE, MAX_NOTE_BYTES } from "../lib/e2e/note";
import type { FinalizeRequest, UploadDeps } from "../lib/e2e/upload-flow";
import { buildEncryptor, createEncryptor } from "../lib/e2e/v2/share";
import { deriveKeys } from "../lib/e2e/v2/keys";
import { fetchShareBlob } from "../lib/e2e/download-flow";

// An in-memory stand-in for tus, finalize and the counted download, which
// checks the key verifier as the server does.
function fakeServer() {
  const uploads = new Map<string, Uint8Array>();
  const shares = new Map<string, { blob: Uint8Array; body: FinalizeRequest }>();
  const deps: UploadDeps = {
    baseUrl: "https://drop.example",
    async upload(source) {
      const id = `up${uploads.size}`;
      uploads.set(id, new Uint8Array(await new Blob([(await source.slice(0, source.size)) as BlobPart]).arrayBuffer()));
      return id;
    },
    async finalize(body) {
      const slug = `s${shares.size}`;
      shares.set(slug, { blob: uploads.get(body.uploadId)!, body });
      return { slug };
    },
  };
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    const slug = decodeURIComponent(String(url).split("/").pop()!);
    const share = shares.get(slug);
    const verifier = new Headers(init?.headers).get("x-fd-key-verifier");
    if (!share) return new Response(null, { status: 404 });
    if (verifier !== share.body.keyVerifier) return new Response(null, { status: 401 });
    return new Response(share.blob.slice());
  }) as typeof fetch;
  return { deps, shares, fetchImpl };
}

function linkParts(shareUrl: string) {
  const url = new URL(shareUrl);
  return { slug: url.pathname.split("/").pop()!, token: url.hash.replace(/^#k=/, "") };
}

const NOTE = "Wi-Fi: castle-guest\nPassword: drawbridge 🏰\n<script>alert(1)</script>";

test("a note round trips in link mode", async () => {
  const srv = fakeServer();
  const { shareUrl, manageUrl } = await uploadNote(NOTE, { expiry: "1d", maxDownloads: 1 }, srv.deps);
  const { slug, token } = linkParts(shareUrl);
  assert.equal(token.length, 46);
  assert.match(manageUrl, /\/m\/s0#t=/);
  const stored = srv.shares.get(slug)!;
  assert.equal(stored.body.format, 4);
  assert.equal(stored.body.maxDownloads, 1);
  assert.equal(stored.body.expiry, "1d");

  const text = await readNote(fetchShareBlob(slug, srv.fetchImpl), { token });
  assert.equal(text, NOTE);
});

test("a note round trips in link and password mode", async () => {
  const srv = fakeServer();
  const password = "correct horse battery";
  const { shareUrl } = await uploadNote(NOTE, { expiry: "1h", maxDownloads: null, password }, srv.deps);
  const { slug, token } = linkParts(shareUrl);
  assert.equal(srv.shares.get(slug)!.body.wrappedKey, undefined);

  assert.equal(await readNote(fetchShareBlob(slug, srv.fetchImpl), { token, password }), NOTE);
  await assert.rejects(
    readNote(fetchShareBlob(slug, srv.fetchImpl), { token, password: "wrong horse battery" }),
    /401/,
  );
});

test("a note looks like any small share to the server", async () => {
  const srv = fakeServer();
  await uploadNote("hi", { expiry: "1d", maxDownloads: null }, srv.deps);
  const file = await createEncryptor([{ name: "hi.txt", type: "text/plain", size: 2 }]);
  const note = srv.shares.get("s0")!;
  assert.equal(note.blob.length, file.blobLength);
});

test("reading a file share as a note fails", async () => {
  const keys = await deriveKeys({ mode: "link", secret: new Uint8Array(32).fill(3) });
  const enc = buildEncryptor({
    keys,
    kind: "single",
    files: [{ name: "a.txt", type: "text/plain", size: 0 }],
    chunk: 4096,
    headerNonce: new Uint8Array(24),
    baseNonce: new Uint8Array(24),
  });
  const blob = new Uint8Array(Buffer.concat([enc.prefix, ...enc.finish()]));
  const fetchBlob = async () => new Response(blob).body!;
  await assert.rejects(readNote(fetchBlob, { keys }), /not a note/);
});

test("an empty note or one over the cap is refused before anything is sent", async () => {
  const srv = fakeServer();
  await assert.rejects(uploadNote("", { expiry: "1d", maxDownloads: null }, srv.deps), /empty/);
  await assert.rejects(
    uploadNote("x".repeat(MAX_NOTE_BYTES + 1), { expiry: "1d", maxDownloads: null }, srv.deps),
    /too long/,
  );
  assert.equal(srv.shares.size, 0);
});

test("a text share holds exactly one unnamed plain text entry", async () => {
  const keys = await deriveKeys({ mode: "link", secret: new Uint8Array(32).fill(4) });
  const build = (files: { name: string; type: string; size: number }[]) =>
    buildEncryptor({ keys, kind: "text", files, chunk: 4096, headerNonce: new Uint8Array(24), baseNonce: new Uint8Array(24) });
  assert.ok(build([{ name: "", type: NOTE_TYPE, size: 3 }]));
  assert.throws(() => build([{ name: "note.html", type: NOTE_TYPE, size: 3 }]), /text/);
  assert.throws(() => build([{ name: "", type: "text/html", size: 3 }]), /text/);
  assert.throws(
    () => build([{ name: "", type: NOTE_TYPE, size: 1 }, { name: "", type: NOTE_TYPE, size: 1 }]),
    /text/,
  );
});
