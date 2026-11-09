# Verifying the client

The server sends the JavaScript that encrypts your files, so the encryption is
only as trustworthy as that code. This page describes how a release pins the
client down and how to check that an instance serves exactly that client. The
README's threat model says what such a check proves and what it does not.

## The manifest

Every release has a `castleparcel-client.json` attached, and every instance
serves the manifest of the client it embeds at
`/.well-known/castleparcel-client.json`. Both are built the same way, by
`scripts/client-manifest.mjs` for the release and by
`server-go/internal/clientmanifest` in the server, and for the same client they
are byte for byte the same.

```json
{
  "format": "castleparcel-client/1",
  "root": "057624abfab3ca6d67ec3b5cd14e4b3c19fca69113a22572a3365ab64875d877",
  "files": [
    {
      "path": "assets/index-3AdWDt_V.js",
      "sha256": "..."
    }
  ]
}
```

`files` lists every file of the built client (`server-go/webroot`), sorted by
the bytes of its path, with the hex SHA-256 of its content. `root` is the
SHA-256 of the lines `sha256sum` prints for those files in that order, one
`<sha256>  <path>` line per file with two spaces and a final newline. On Linux,
coreutils alone recompute it:

```sh
cd server-go/webroot
find . -type f -printf '%P\n' | LC_ALL=C sort | xargs -d '\n' sha256sum | sha256sum
```

The format string changes whenever the layout or the root definition does.

## The page and its template

The page at `/` is not served byte for byte. At startup the server fills the
`%%APP_NAME%%`, `%%DESCRIPTION%%`, `%%OG_IMAGE%%` and `%%LANG%%` markers of the
embedded `index.html` with the instance's branding, HTML-escaped. The manifest
hashes that template, and the instance serves it unchanged as plain text at
`/.well-known/castleparcel-client/index.html`.

The template loads one script and one stylesheet, each with an `integrity`
attribute (Subresource Integrity, SHA-384), so the browser runs and applies
them only if their bytes match. The client is built as a single chunk because
a chunk loaded later through `import()` cannot be pinned this way: when a
`modulepreload` fails its integrity check, the later `import()` fetches the same
URL again and runs whatever comes back. `scripts/build-client.mjs` stops the
build if a script or stylesheet turns up that the page does not load.

Fonts and images that the stylesheet loads carry no integrity attribute, and
neither does the service worker `sw-download.js`, which browsers never check
that way. All of them are in the manifest.

## Checking an instance

From a checkout of this repository, with Node 20 or newer:

```sh
node scripts/verify-client.mjs https://share.yourdomain.tld castleparcel-client.json
```

The second argument is a file or a URL, such as the release asset
`https://github.com/junkerderprovinz/featherdrop/releases/download/vX.Y.Z/castleparcel-client.json`.
The script

1. checks that the manifest's root matches its file list,
2. fetches every listed file from the instance and compares its SHA-256,
3. fetches the template, compares its hash, and checks that the page at `/` is
   that template with only escaped text where the markers were,
4. compares the root the instance reports with the release, which catches a
   file the release does not have.

It exits with 0 when everything matches, 1 on a mismatch, which it names, and
2 when it could not run.

To look inside an image without starting it:

```sh
docker run --rm junkerderprovinz/featherdrop:latest -client-manifest
```

A running server also logs the root when it starts:

```
client: root 057624ab..., 182 files, manifest at /.well-known/castleparcel-client.json
```

## Rebuilding a release yourself

The client builds to the same bytes on any machine, so you need not trust the
release's manifest either:

```sh
git checkout vX.Y.Z
nvm use            # the Node version in .nvmrc
npm ci
npm run build:spa
node scripts/client-manifest.mjs --out mine.json
```

`mine.json` has to match the release's `castleparcel-client.json`. The build
depends only on the commit: `npm ci` installs exactly what `package-lock.json`
names, `.nvmrc` and the Dockerfile name the same Node version, Vite names every
asset by a hash of its content, nothing in the output records a time or a
path, and `server-go/webroot` is rebuilt from nothing. The `Reproducible client`
workflow builds every change twice on Linux, Windows and macOS, the second time
from another directory with an empty npm cache and another time zone, and
requires all six builds to agree. The image smoke test in `go.yml` runs
`verify-client.mjs` against the image with the manifest of a native build.
