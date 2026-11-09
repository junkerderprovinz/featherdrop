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
| 4 | v2 container (this document) | single or bundle, encrypted | per-chunk XChaCha20-Poly1305 | read; written when asked for |

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
| `kind` | string | `"single"` (exactly one file) or `"bundle"` |
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
guessing. Someone with the link but not the blob can only guess
the password online, one download request per guess, and the download endpoint
is rate limited.

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
