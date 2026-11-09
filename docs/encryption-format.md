# Encryption format

All encryption happens in the browser. The server stores opaque blobs and a
few numbers about each share; it never sees a key, a password, a file name or
plaintext. This document describes the current format (v2, stored by the
server as format 4) byte by byte, and the older formats that stay readable.

The reference implementation is `lib/e2e/v2/` (TypeScript, libsodium).
Known-answer vectors are in `test/fixtures/encryption-v2-vectors.json`.

## Overview

| Server format | Container | Kind | Content encryption | Status |
| --- | --- | --- | --- | --- |
| 2 | varint header, secretbox metadata | single file | cf=1 secretstream or cf=2 seekable AEAD | read and written |
| 3 | varint header, secretbox manifest | bundle | cf=1 or cf=2 | read and written |
| 4 | v2 container (this document) | single, bundle or note, encrypted | per-chunk XChaCha20-Poly1305 | read; written when asked for |

The upload page keeps writing formats 2 and 3 until the new UI switches over.
`uploadEncrypted(files, { format: 4, ... })` and `downloadDecryptedV2` in
`lib/e2e/` already speak format 4.

## Notation

- `||` is concatenation. `u32be(n)` and `u64be(n)` are big-endian unsigned
  integers of 4 and 8 bytes.
- `BLAKE2b-256(key = k, m)` is libsodium `crypto_generichash(32, m, k)`.
- `KDF(key, id, ctx, len)` is libsodium `crypto_kdf_derive_from_key(len, id,
  ctx, key)`: BLAKE2b keyed with `key`, with `id` as salt and the 8-byte
  `ctx` as personalization.
- `AEAD(k, n, m, ad)` is XChaCha20-Poly1305-IETF
  (`crypto_aead_xchacha20poly1305_ietf_encrypt`) with a 24-byte nonce `n`; it
  returns the ciphertext followed by a 16-byte tag.
- base64 is standard padded base64; base64url is unpadded and URL-safe.

## The link token

Every v2 share has a link token, carried in the URL fragment (`#k=...`), which
browsers never send to the server.

```
token = base64url( version(1) || mode(1) || S(32) )      34 bytes, 46 characters
```

| Field | Value |
| --- | --- |
| version | `0x02` |
| mode | `0x01` link, `0x02` link and password |
| S | 32 random bytes from `randombytes_buf`, fresh for every share |

A decoder rejects any other length, version or mode. The 46-character token
also tells a v2 link apart from an older one, whose `#k=` holds a bare
43-character key.

## Key schedule

### Link mode

```
R = BLAKE2b-256(key = S, "CastleParcel v2 root" || 0x01 || u32be(0) || u32be(0))
```

### Link and password mode

```
pw   = UTF-8 bytes of the password in Unicode NFC
salt = KDF(S, 1, "CPv2salt", 16)
P    = Argon2id13(pw, salt, ops = 3, mem = 67108864 bytes, out = 32)
R    = BLAKE2b-256(key = S, "CastleParcel v2 root" || 0x02 || u32be(3) || u32be(67108864) || P)
```

The label is the 20 ASCII bytes of `CastleParcel v2 root`. NFC normalization
makes a password typed on macOS (which produces NFD) match the same password
typed elsewhere.

R is keyed with S, so it cannot be computed without the link. P depends on the
password, so it cannot be computed without the password. The salt is a subkey
of S: it is unique per share and the server never has it, so the server cannot
even begin a guessing attack.

### Working keys

```
headerKey  = KDF(R, 1, "CPv2keys", 32)
contentKey = KDF(R, 2, "CPv2keys", 32)
verifier   = base64url(KDF(R, 3, "CPv2keys", 32))      43 characters
```

Each key serves exactly one purpose: the header AEAD, the content AEAD, and the
download proof. The mode and the Argon2id parameters enter R, so a token with
a changed mode byte derives unrelated keys.

### Argon2id parameters

`ops = 3`, `mem = 64 MiB`, one lane. These are the time and memory cost of
RFC 9106's second recommended setting, which names four lanes; libsodium's
`crypto_pwhash` always runs one, so the setting here is `p = 1`. One derivation took
about 0.12 s in libsodium's WebAssembly build on a desktop CPU; a phone several
times slower still finishes within about a second, and 64 MiB stays inside
what mobile browsers grant a tab. The
password is a second factor on top of a 256-bit secret, so the cost only has
to slow down an attacker who already holds the link and either the stored blob
or the stored verifier;
higher memory settings (libsodium's MODERATE uses 256 MiB) fail on some phones.

The parameters are fixed by the mode byte. A later parameter set gets a new
mode value, and the parameters are repeated in the encrypted header and checked
there.

Passwords must have at least 8 Unicode code points after NFC normalization
(`isPasswordLongEnough`), the floor of NIST SP 800-63B.

## Blob layout

```
offset  size        field
0       1           version = 0x02
1       4           u32be(sealedLen)
5       24          headerNonce
29      sealedLen-24  AEAD(headerKey, headerNonce, headerPlain, ad = bytes 0..4)
5+sealedLen         chunk_0 || chunk_1 || ... || chunk_{n-1}
```

`sealedLen` is between 24 + 1024 + 16 and 16 MiB. The five-byte prefix is the
associated data of the header, so changing the version or the length breaks
the header tag. The content starts at `contentOffset = 5 + sealedLen`.

### Header plaintext

```
headerPlain = u32be(jsonLen) || json || zeros
len(headerPlain) = pad_header(4 + jsonLen)
```

`json` is a UTF-8 JSON object with exactly these fields, written in this order
by the reference implementation:

| Field | Type | Meaning |
| --- | --- | --- |
| `v` | number | `2` |
| `kind` | string | `"single"` (exactly one file), `"bundle"` or `"text"` (a note, see below) |
| `mode` | string | `"link"` or `"link+password"`, must match the token |
| `kdf` | object or null | `{"alg":"argon2id13","ops":3,"mem":67108864}` in link and password mode, `null` in link mode; must match the token |
| `chunk` | number | plaintext bytes per chunk, a power of two from 4096 to 16777216; 65536 by default |
| `pad` | string | `"padme"` |
| `nonce` | string | base64 of the 24-byte `baseNonce` of the content |
| `size` | number | total plaintext length, the sum of the file sizes |
| `files` | array | `{"name", "type", "size"}` per file, in content order |

A decoder rejects a header with missing or extra fields, a field of the wrong
type, a `size` that is not the sum of the file sizes, nonzero padding, or a
`headerPlain` whose length is not `pad_header(4 + jsonLen)`.

A `"text"` share is a note. Its `files` holds exactly one entry with the name
`""` and the type `"text/plain; charset=utf-8"`, and the content is the note in
UTF-8, at most 1 MiB (`MAX_NOTE_BYTES` in `lib/e2e/note.ts`). A decoder rejects
a text header with a name, another type or more than one entry, and content
that is not valid UTF-8. The client shows a note as a text node and never
parses it as markup. Since the kind is inside the sealed header and the content
is padded like any file's, a note is a format 4 share like any other to the
server: a short note and a file of up to 4 KiB with a short name give blobs of
the same length.

Because kind, mode, KDF parameters, chunk size and padding scheme live inside
the authenticated header, the server can neither read nor swap them.

### Content

The plaintext is the files' bytes concatenated in header order, followed by
zeros up to `padded = pad_content(size)`. It is cut into `n = ceil(padded /
chunk)` chunks; all but the last are `chunk` bytes long, and `padded >= 4096`
means the last is never empty.

```
nonce_i = baseNonce with its last 8 bytes XORed with u64be(i)
ad_i    = u64be(i) || final_i            final_i = 0x01 for i = n-1, else 0x00
chunk_i = AEAD(contentKey, nonce_i, plain_i, ad_i)
```

Chunk `i` starts at `contentOffset + i * (chunk + 16)`. The index in the nonce
and the associated data stops reordering and splicing, the final flag stops
truncation at a chunk boundary, and the length is fixed by `size` in the
header, so bytes after the final chunk are an error. Decoders check that the
padding bytes are zero.

The total blob length is `5 + sealedLen + padded + 16n`. It is known before
any content is read, so an upload can declare its exact length up front and
stream the ciphertext as it is produced.

`baseNonce` and `headerNonce` are random for every encryption. S is fresh for
every share, so the keys never repeat; the random nonces keep a retried upload
that reuses a token from repeating a (key, nonce) pair.

## Uploading and resuming

Because the blob length is known up front, a format 4 upload writes no
encrypted copy first. Each tus request asks for a byte range, and the browser
encrypts just the chunks that range covers from the same range of the files
(`blobSource`). A chunk depends only on the content key, the base nonce and its
index, so any range comes out the same however often it is made.

That also makes an upload resumable after a reload or a closed tab. The
browser keeps a record in IndexedDB holding the tus upload URL and, sealed,
everything needed to make the rest of the blob again: the content key, the
sealed header, the link token, the verifier and a fingerprint of each file
(name, size, modification time and a SHA-256 of 16 samples of 4 KiB). The
password is never stored; the content key and the sealed header are all a
resume needs. To resume, the user picks the same files again, since browsers
keep no file handles across a reload; files that do not match are refused
before anything is sent. tus asks the server for its offset, and the upload
goes on from there.

The sealed part is AES-GCM under a non-extractable WebCrypto key kept in the
same record. That keeps the key, the link and the file names out of storage as
readable bytes, so they do not show up in a storage dump or the developer
tools, but it is no barrier to code running in the app's origin, which can use
the key. In link mode the record is as good as the link itself. So a record
lives only as long as its upload: it is deleted when the share is finalized,
when the user discards it, and when it has been untouched for 24 hours, after
which the server has dropped the unfinished upload anyway. A private window or
a browser that refuses storage simply uploads without a record.

## Padding


Both paddings use Padmé (Nikitin et al., PETS 2019):

```
padme(L) = L                                  for L < 2
padme(L) = ceil(L / 2^(E - S)) * 2^(E - S)    where E = floor(log2 L), S = floor(log2 E) + 1

pad_content(L) = padme(max(L, 4096))
pad_header(L)  = padme(max(L, 1024))
```

Padmé keeps the top `S` bits of the length, so a padded length reveals
`O(log log L)` bits and costs at most about 12% overhead (less for large
files). The minimums make every file up to 4 KiB look the same and hide name
lengths and file counts while the header fits in 1 KiB, which covers a few
files with ordinary names.

## Decryption

1. Decode the token; reject unknown versions and modes.
2. Derive R and the working keys; in link and password mode this runs Argon2id.
3. Send the verifier in `x-fd-key-verifier` with the download request. A wrong
   password or link gives a different verifier and the server answers 401
   without counting anything.
4. Read the prefix, check the version and the length range, open the header,
   check its padding and fields, and check that `mode` and `kdf` match the
   token.
5. Decrypt chunk by chunk, cut the padding off the plaintext, and check that the
   final chunk arrived and nothing follows it.

A seek reads the header the same way, then fetches and opens only the chunks
covering the wanted range (`cipherRange`, `decryptRange`). Each chunk is
authenticated on its own.

## What the server stores and learns

For a format 4 share the server stores the blob, its length, the format number,
the key verifier, the expiry, the download limit and the download count. It
rejects a finalize request whose blob does not start with `0x02`, whose header
length is outside 1064 bytes to 16 MiB, whose content is shorter than the
smallest padded content (4096 bytes and one tag), which has no verifier, or
which carries a wrapped key or salt. It does no cryptography.

| | Formats 2 and 3 | Format 4 |
| --- | --- | --- |
| single file or bundle | yes, from the format number | no |
| whether a password is set | yes (`hasPassword`) | no |
| password material | wrapped key and salt, served to anyone with the slug | none |
| offline password guessing | by anyone with the slug | only with the link and either the blob or the stored verifier |
| plaintext size | exact | Padmé bucket, at least 4 KiB |
| metadata size (names, file count) | exact | Padmé bucket, at least 1 KiB |
| key verifier | SHA-256 of the content key | an independent subkey |

Still visible in every format: the blob length within its bucket, the upload
time, the client's IP address, expiry, download limit, and when and how often
the share is downloaded.

A seek fetches byte ranges through the uncounted `?preview=1` read of an
unlimited share, so the server sees which chunks are read. A player that reads
the end of a file fetches the chunk holding its last byte, which gives away
the plaintext size to the chunk instead of to the Padmé bucket.

The verifier is a pseudorandom function of R, so it gives the server nothing to
guess against without S. With S it checks a password guess as well as the blob
does, so the link together with a copy of the database is enough for offline
guessing. Someone with the link but not the blob can only guess the password
online, one request per guess. The server counts wrong verifiers per share:
after ten in a row it locks the share for every client, for one second and
then twice as long after each further wrong one, up to an hour, and answers
`429` to every verifier, right or wrong, until the lock ends. A right verifier
resets the count, which is stored with the share, so a restart does not clear
it. With `RATE_LIMIT` on, each IPv4 address or IPv6 /64 also gets 10 failed
key checks at once and 20 a minute after that, shared with its unknown slugs
and new downloads across the share routes.

## File requests

A file request lets someone ask for files without an account. The requester
keeps a collect link; whoever gets the request link can send files or a note
that only the collect link opens. The reference implementation is
`lib/e2e/v2/request.ts` (keys) and `lib/e2e/request-flow.ts` (requests).

### Keys

The requester's browser draws a fresh 32-byte secret `Q` from
`randombytes_buf` and derives:

```
seed         = KDF(Q, 1, "CPv2rqst", 32)
(pk, sk)     = crypto_box_seed_keypair(seed)               X25519
collectToken = base64url(KDF(Q, 2, "CPv2rqst", 32))        43 characters
collectHash  = base64url(SHA-256(UTF-8 bytes of collectToken))
```

### Links

```
request link = /r/<slug>#p=base64url(0x02 || 0x11 || pk)    46 characters
collect link = /c/<slug>#c=base64url(0x02 || 0x10 || Q)     46 characters
```

The second byte tells the kinds apart, and neither 0x10 nor 0x11 is a share
token mode, so no link of one kind decodes as another. The collect link holds
everything: from `Q` the browser rebuilds `pk`, the request link and the collect
token. The request link holds only `pk`, from which neither `sk` nor the
collect token follows.

### Opening a request

`POST /api/requests` sends `publicKey = base64url(pk)` (43 characters),
`collectHash`, the expiry, an optional upload count (1 to 1000) and an optional
size cap in bytes of encrypted upload. It needs the upload password when the
server has one, since a request lets strangers upload. The server answers with
the slug.

### Sending

The uploader's browser checks `GET /api/r/<slug>` (expiry, size cap, whether
the request still takes an upload), then encrypts the files or the note as a
fresh link-mode format 4 share exactly as above, with a fresh token `T` of
34 bytes. It uploads the blob with tus and attaches it:

```
sealedKey = crypto_box_seal(T, pk)          34 + 48 = 82 bytes
POST /api/r/<slug>/uploads  { uploadId, sealedKey: base64(sealedKey) }
```

`crypto_box_seal` encrypts to `pk` under a fresh ephemeral key pair, so the
sealed key carries no sender identity and the uploader keeps nothing that
opens the upload once the page closes. The blob's own key verifier is not sent:
the collect token guards the download instead.

Every uploader request (the info, every tus request and the attach) carries
`x-fd-request-key: base64url(pk)`, and the tus requests also
`x-fd-request: <slug>`. The server compares the key with the stored one in
constant time. A matching key lets a tus upload pass without the upload
password; a tus create must also declare its length, fit the size cap and find
the request open. An upload without a declared length is refused at the
attach too, since it could still grow after the server checked its size.
Wrong keys, unknown slugs and expired requests all get the same 404, so the
slug alone, without the fragment, sends nothing and confirms nothing.

### Collecting

The requester's browser sends `x-fd-collect-token: collectToken` to:

| Route | |
| --- | --- |
| `GET /api/r/<slug>/uploads` | the uploads: id, encrypted size, time, sealed key |
| `GET /api/r/<slug>/uploads/<id>/header` | prefix and sealed header of one upload |
| `GET /api/r/<slug>/uploads/<id>` | the blob, with Range, never counted |
| `DELETE /api/r/<slug>/uploads/<id>` | deletes one upload and frees its place |
| `DELETE /api/r/<slug>` | closes the request and deletes it with its uploads |

The server hashes the token and compares it with `collectHash` in constant
time, also when there is no such request. A missing or wrong token, the request
key sent as a token, an unknown slug, an expired request and an upload of
another request all get the same 404. The browser opens each sealed key with
`crypto_box_seal_open(sealedKey, pk, sk)`, checks that it decodes as a
link-mode token, derives the share's keys and opens the header and the content
as for any format 4 share. Anyone with the request link can attach a sealed key
that opens nothing; the browser lists such an upload as unreadable next to the
others, and the requester can delete it. A deleted upload gives its place back,
so a request filled with junk takes uploads again.

### Why the collect proof is separate

Anyone who has the request link must not be able to list or download, so
the collect proof cannot be anything the request link carries. A hash of a
random token, as for the management link, would need a second secret in the
collect link; deriving the token from `Q` keeps the link to one secret. The
token is a KDF subkey independent of the box seed, so neither it nor its hash
says anything about `sk`, and the stored hash does not let a copy of the
database collect. A signature over a server challenge would prove the same with
an extra round trip and gains nothing while the token goes over TLS only.

### What the server stores and learns

For a request the server stores the slug, `pk`, `collectHash`, the expiry, the
upload count and its cap and the size cap. For each upload it stores the blob,
its length, the sealed key and the time. It never has `Q`, `sk` or any share
token, so it opens nothing. It sees the collect token on every collect request
and keeps only its hash. The token opens nothing either, but whoever reads it,
from a proxy that logs request headers for example, can list, fetch the
ciphertext and delete until the request expires.

It learns how many uploads arrive and when, from which address, and the padded
length of each. It cannot tell files from notes or count the files in an
upload. The request link and the slug say nothing to an outsider without the
fragment.

What it cannot stop: anyone with the request link, and the operator, who has
`pk`, can add uploads; the requester cannot tell who sent one. The operator can
drop uploads or answer the requester with a smaller list. It cannot swap the
key an uploader encrypts to, because the uploader uses `pk` from the fragment.
An uploader learns only whether the request still takes an upload, not how
many others came before. A copy of the database with `pk` lets its holder add
uploads to a live request, never read them.

## Password-only mode

The older formats offer a password mode without a key in the link: the content
key is wrapped with an Argon2id key and the server hands the wrap and salt to
anyone who asks for the slug's metadata. Whoever has the slug, which is in every
copy of the link, can therefore guess the password offline, and the server
operator can do the same for every password share at once. Its strength is the
password alone.

Format 4 does not offer it. Link and password mode protects in every case the
password-only mode does and needs nothing extra from the sender, who has to
pass the link on anyway. Existing password-only shares stay readable.

## Older formats

These stay readable through `lib/e2e/pipeline.ts` and
`lib/e2e/multi-pipeline.ts`; `test/fixtures/legacy-blobs.json` pins one blob of
each kind.

```
blob     = varint(metaLen) || enc_meta || content      (unsigned LEB128 varint)
enc_meta = nonce(24) || crypto_secretbox_easy(JSON(meta), nonce, K)
```

`K` is a 32-byte random key. In link mode it is the URL fragment
(`#k=base64url(K)`, 43 characters); in password mode the fragment is empty and
the server stores `wrappedKey = nonce(24) || crypto_secretbox_easy(K, nonce,
KEK)` and `kdfSalt` (16 bytes), with `KEK = Argon2id13(password, kdfSalt, ops =
3, mem = 64 MiB, out = 32)`. The verifier is `base64url(SHA-256(K))`.

Format 2 `meta` is `{name, type, size?, cf?, chunkSize?, baseNonce?}`; format 3
is `{files: [{name, type, size}], cf?, chunkSize?, baseNonce?, size?}`.

- `cf` absent or 1: content is a `crypto_secretstream_xchacha20poly1305` stream,
  a 24-byte header and then frames of 65536 plaintext bytes, the last tagged
  `TAG_FINAL`.
- `cf = 2`: content is per-chunk XChaCha20-Poly1305 under `K` itself, 65536
  plaintext bytes per chunk, nonce `baseNonce XOR u64be(i)`, associated data
  `u32be(i) || final`, no padding.

Format 1 (age ciphertext written by older servers) is not served; its shares answer 404.

## Test vectors

`test/fixtures/encryption-v2-vectors.json` holds:

- `padme`: pairs of `[L, padme(L)]`.
- `keys`: for a link token and a link-and-password token, the salt, R, the
  header and content keys and the verifier, all in hex except the verifier.
  One password appears in NFC and in NFD and gives the same keys.
- `blobs`: complete blobs with every input fixed (token, password, kind, chunk
  size, both nonces, files, plaintext), the exact header JSON, and the
  resulting blob in hex. In one of them the final chunk holds only padding.

`scripts/encryption-vectors.ts` wrote the file once; `test/encryption-vectors.test.ts`
checks the reference implementation against it.
