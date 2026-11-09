# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **See what a share holds before you spend a download.** `GET /api/d/{slug}/header` returns only the encrypted names and sizes at the start of a share, never a byte of the files, and does not count as a download. It needs the same key proof as the download. Limited link shares use it to show their file names and sizes right away.
- **The management link is back.** Next to the share link you get a second, private link that deletes the share and its file before it expires. Its secret is created in your browser and travels only in the link's `#` part; the server keeps a hash of it and nothing else. `DELETE /api/m/{slug}` with the token in `x-fd-manage-token` answers `204`, and a wrong token, a missing share or one without a management link all get the same `404`.
- **Upload cap per visitor.** `UPLOAD_LIMIT_PER_IP` limits how many bytes one visitor can upload in 24 hours (413 for a single file over the cap, 429 with `Retry-After` once the budget is used up). IPv6 visitors count per /64. The count stays in memory under an HMAC of the address with a key drawn at every start, so no address is kept or logged. While the cap is on, an upload has to declare its size up front.
- **Trusted proxy list.** `TRUST_PROXY` also takes a comma-separated list of proxy addresses and CIDR ranges. Only a connection from one of them may name the visitor in `X-Forwarded-For`, and entries left of the last trusted proxy, which a client could have forged, are skipped. `true` and `false` work as before.

### Changed

- **A download counts once it has arrived.** A share's download counter goes up, and a one-time share is deleted, only after the whole file was sent. A dropped connection costs nothing and the recipient can try again. While a limited share's last remaining download is running, a second attempt gets `409 download in progress` instead of a second copy.
- The upload server logs errors only, so the container log no longer lists every upload with its id and size.
- The README has a table of all settings.
- **Boot log banner** — new knight artwork (shared across all junkerderprovinz containers), and the name/subtitle + READY line are now each a single combined line, matching the house format.
- Tidied the code comments and log messages.

### Removed

- The modules and tests of the retired Node server: master key mode, server-side encryption, password hashing, manage tokens and the upload gate.

### Security

- **Strict security headers on every response.** A Content-Security-Policy that allows only the app's own scripts and connections, plus `Referrer-Policy: no-referrer`, `Cross-Origin-Opener-Policy: same-origin`, `X-Frame-Options: DENY`, a Permissions-Policy that switches off camera, microphone, location and other unused features, and `X-Content-Type-Options: nosniff`.
- An `APP_LOGO` on another host is allowed for images and nothing else. A value that is neither an http(s) URL, an image `data:` URL nor a path is ignored with a warning at boot.
- The build tools use minimatch 11 and zod 4.6.7, which close two advisories. Neither ships in the image.

## [1.9.0] - 2026-07-15

### Added

- **Paste to upload.** Ctrl/Cmd+V drops clipboard files (screenshots, for example) into the selection. Pasting into text fields is unaffected.
- **Remembered options.** The last-used expiry, download limit and metadata choice are restored per browser. The password is never stored.
- **Photo metadata removal.** EXIF, GPS and IPTC data is stripped from JPEGs in the browser before encryption. On by default with an opt-out switch, and files that can't be parsed pass through untouched.
- **PWA and Android share target.** featherdrop is installable, and "Share → featherdrop" feeds shared files into the upload flow.
- **Operator guardrails.** `MAX_EXPIRY`, `STORAGE_QUOTA` (507 when over quota), `RATE_LIMIT` (per IP, on by default, 429 with `Retry-After`) and `TRUST_PROXY`.
- **Healthcheck.** `GET /api/healthcheck` and a Dockerfile `HEALTHCHECK` (a self-check flag that works in the distroless image).

### Changed

- Share pages opt out of search engines (`robots.txt` and a uniform `X-Robots-Tag: noindex, nofollow` on 200, 401 and 404).
- Boot-time config validation with clear messages naming the variable, plus warnings for a non-absolute `BASE_URL` and a short `UPLOAD_PASSWORD`.
- A shorter README with download buttons at the top, three new screenshots, and only what a first start needs.

### Fixed

- The operator's `DEFAULT_EXPIRY` is used as the starting expiry again.

### Security

- Audit of the delete, finalize and download paths: constant-time token comparisons, uniform 404s, no unauthenticated route that changes anything. The rate limiter also covers key-verifier guessing.

## [1.8.0] - 2026-07-12

### Added

- **Seekable encryption format (`cf=2`).** Each 64 KiB chunk is encrypted on its own with XChaCha20-Poly1305, so large encrypted videos seek for real: the preview fetches and decrypts only the chunks it needs. New uploads use it automatically, and shares in the sequential format keep working.
- **Startup log banner.** On boot the server prints the shared "Junker der Provinz" ASCII banner and a `FEATHERDROP IS READY` box to stdout, matching the other own-image containers.
- More formats offered for the inline video preview (`.mkv`, `.avi`, `.mpeg`, `.3gp`, `.wmv`, `.flv`, `.ts` and more). Playback depends on the browser's codec support, and undecodable files show a safe, inert player.

### Changed

- **The server is a single static Go binary.** One CGO-free binary (`chi`, `tusd`, pure-Go `modernc.org/sqlite`) replaces the Node and Next.js server and serves the React client as embedded static assets plus the JSON and file API. The result is a ~15 MB `distroless` image with lower RAM use and proper HTTP streaming and Range support. The browser-side crypto and the UI stay in TypeScript.
- **Drop-in upgrade.** The SQLite schema mirrors the old one byte for byte and the blob layout is unchanged, so the same `db.sqlite`, `/config` and `/data` volumes, ports and environment variables keep working. The previous image stays buildable from `Dockerfile.next` for a rollback.
- **Uploads go in 64 MiB chunks**, so they pass through CDNs with a request-body cap (Cloudflare Free and Pro: 100 MB, which answers a single large PATCH with 413) and resume from the last chunk after an interruption.
- **Streamed preview starts faster.** It serves a bounded window per request instead of fetching and decrypting the whole file up front.
- Home page redesigned in a Smash-style layout: the big, centered logo is the upload target (click it or drop files anywhere), and the text moves to the top. The result window, inline preview size, copy buttons and centered windows were reworked to match, and choosing a file cross-fades the feather into the options panel.
- New banner claim, "Big files, zero baggage.", and a description that presents featherdrop as your own private, self-hosted WeTransfer across the README, the repo description and the Unraid template and CA feed card. `.github/assets/gen-banner.mjs` regenerates the banner SVG and PNG, with the claim set in Lato.
- Browser-tab favicon: the transparent gold gradient feather (`public/favicon.svg`) is linked from the app shell and served at `/favicon.svg` as `image/svg+xml`.
- Reverse-proxy docs (README §8): a proxying CDN enforces its own request-body limit before your reverse proxy, so `client_max_body_size 0` can't override Cloudflare's 100 MB. Added a short comparison of remote-access options (direct or port-forward, Cloudflare Tunnel, a self-hosted tunnel such as Pangolin).
- CI builds and boots the image, runs the real zero-knowledge browser round trip (upload, download, preview, multi-file) against the Go server on every change, and runs `govulncheck`.

### Removed

- **The management link.** Shares are removed by their expiry and, if set, the download limit. Management links already handed out stop working.

### Fixed

- The inline preview of large streamed videos works on the first visit to a share link, not only after a reload. It used to give up before the service worker controlled the page.

### Security

- **The key verifier covers seekable shares.** For `cf=2` shares the browser stores `base64url(SHA-256(content key))` in a nullable `key_verifier` column, and `GET /api/d/<slug>` must present it in `x-fd-key-verifier` (compared constant-time) before anything is counted or served. A missing or wrong verifier is a 401 with no side effects. Both download paths send the header, and shares without a stored verifier download as before.
- Every auth gate is enforced on the server and in constant time. A full adversarial audit found no blocking issues.
- Pinned the Go toolchain to `go1.26.5`, which carries the standard-library fix for GO-2026-5856 (an Encrypted Client Hello privacy leak in `crypto/tls`).

## [1.7.0] - 2026-06-29

### Added

- **Multi-file shares.** Several files upload as one end-to-end encrypted bundle under a single link, and the recipient gets them back individually (no zip), with Download all and, in Chromium over HTTPS, Save to folder.
- **Preview before download** for images (including SVG rendered safely through `<img>`), video, audio, text and code, and PDF. Decryption happens in the browser and never costs a download. Large videos stream through the service worker, other kinds are size-capped, and only inert types render.
- **Optional upload protection.** `UPLOAD_PASSWORD` restricts who can create shares, checked on the server in constant time before anything is stored. Download links stay open. Also in the Unraid template (advanced).
- **Management link per share** (`/m/<slug>#t=…`) to delete a share before it expires. The server stores only a hash of the token.
- **Key verifier for zero-knowledge downloads.** Limited or password-protected shares require a matching `x-fd-key-verifier` header (`base64url(SHA-256(key))`, compared constant-time) before a download is counted or the file is burned. Shares created before 1.7.0 have no verifier and behave as before.
- **Insecure-context notice.** Over plain HTTP a banner explains that large uploads fall back to memory and streamed downloads are off.

### Changed

- New house banner with the feather and the wordmark. The README no longer has a separate top heading.
- Single-file shares and links created by earlier versions keep working unchanged.

### Fixed

- **Large downloads failed in the published image.** The standalone image didn't ship `public/`, so `/sw-download.js` returned 404 and every download over 50 MB failed after it had already counted against a limited share. `public/` now ships.
- **Drag and drop crashed Chrome and Edge** with `RESULT_CODE_KILLED_BAD_MESSAGE`, triggered by Chromium's `webkitGetAsEntry()` directory walk. Dropped files are now read straight from the drop event.
- Chromium marked downloads as failed because the streamed response declared the ciphertext length as the plaintext `Content-Length`. No length is sent when it isn't known exactly.
- Abandoned tus uploads that never finished are swept after 24 hours.
- When deleting an expired blob fails, the database row is kept so the next sweep retries instead of leaving the blob behind.
- The `fd_key` cookie is marked `Secure` when the request came in over HTTPS.

## [1.6.0] - 2026-06-10

### Added

- **Zero-knowledge (end-to-end) encryption.** The browser encrypts every file with `XChaCha20-Poly1305` (libsodium `crypto_secretstream`, 64 KiB chunks) before upload. In link mode the key lives only in the URL `#fragment`. In password mode it is wrapped with an Argon2id-derived key. Filename and content type are encrypted inside the blob.
- **Any file size.** Encryption streams through OPFS and uploads resume with tus. Downloads decrypt and stream to disk through a service worker. Without OPFS or streaming (including any plain-HTTP page, where `navigator.storage` is missing) the browser encrypts in memory for files up to 500 MB, and larger files get a clear message.
- **Client-side inline preview.** Images and PDFs are decrypted in the browser and rendered from a `blob:` URL. The server serves no inline route, and only raster images and PDF are shown.
- New client modules (`lib/e2e/crypto.ts`, `blob-layout.ts`, `opfs-scratch.ts`, `stream-download.ts` with `public/sw-download.js`, `pipeline.ts`), each unit-tested in Node with libsodium, and a CI end-to-end test that drives a real browser through the full encrypt, upload, decrypt, download round trip.

### Changed

- **Breaking change to the crypto model.** The server stores and serves opaque ciphertext, enforces expiry and the download limit, and does no cryptography. No key or password appears in any request.
- Shares created before 1.6.0 keep working until they expire. The data model handles both formats and the migration is additive, so nothing needs to be done on upgrade. Ports, the `/data` volume and the configuration stay the same.
- A zero-knowledge link only decrypts if the whole URL, including the part after `#`, is copied.
- Privacy copy in the app, README and template now makes the zero-knowledge claim.

### Removed

- **Server master-key mode.** New shares use link mode or password mode.

## [1.5.0] - 2026-06-09

### Changed

- **Sansation is the UI typeface**, self-hosted through `@fontsource/sansation` with no runtime call to Google. The wordmark stays in Bitter.
- **Refreshed hero copy.** A lighter tagline, "Share your files securely and privately", over a single line, "Encrypted · auto-deleted · no tracking · no account · no bullshit", in all 26 languages.
- The download page matches the home page: the brand sits centered at the top and links home, and the share card carries just the logo. The home page has a larger logo and more space below the header.
- **Reworked upload options panel** (`components/SettingsPanel.tsx`): expiry has an on/off toggle like the download limit, the order is expiry, download limit, password, and the divider above the upload button is gone.
- "Download options" (`settings.title`) replaces "Share options" in all 26 languages. German expiry labels read "7 Tagen" and "30 Tagen" (dative).
- Darker top on the gold feather mark (lightest stop `#E0B53A` instead of `#F6D981`), so the medallion stays visible on light backgrounds. Applied to the in-app logo, the favicon, the README banner, the CA icon and the link-preview cards.
- **About 58% smaller image** through Next `output: "standalone"`: only the trace-pruned server and about 24 MB of `node_modules` ship, and the image drops from about 203 MB to 85 MB compressed. The custom server hands Next the pre-resolved config through `__NEXT_PRIVATE_STANDALONE_CONFIG`, and better-sqlite3's native addon is copied in explicitly. Nothing changes on upgrade.
- The image push is gated on a boot smoke test: CI runs the image and requires it to serve `/` on `amd64` and `arm64` before publishing `:latest`.
- README: a new "Security & Privacy" section, the canonical badge row with the official Buy Me a Coffee button under the description, a numbered `## 11. Support this project` section, a `## Screenshots` section, and richer copy covering every key feature. A CA support-thread template ships as `.github/SUPPORT_THREAD.md` and `.github/SUPPORT_THREAD.html` with its own button SVGs.
- "Feather-light" wording in the short description across the repo description, README, Unraid template and templates-repo card.
- Unraid template: `BASE_URL` pre-fills `https://featherdrop.yourdomain.tld` as a placeholder, and `APP_LOGO` is documented as taking a public image URL or a `data:` URI.

### Fixed

- **Light/dark toggle needed two clicks** for the first switch. It now uses Mantine's computed color scheme, so the first click always flips what's shown.
- **Image and PDF preview never appeared.** A missing MIME type in the database now falls back to the type inferred from the filename on client and server (`lib/mime.ts`). Behind some reverse proxies the cookie didn't reach the preview request, so the link key is also accepted as `?k=` on the `?inline=1` path for unlimited shares, never for counted downloads. The preview frame keeps a minimum height when loading fails.
- **`BASE_URL` applies to generated share links** (#1). It is resolved on the server and passed to the client through `ServerConfigProvider`, falling back to the browser origin only when unset.
- Lint CI is green again: the obsolete `XML Template Lint` job is gone, since the Unraid template lives in the central [templates repo](https://github.com/junkerderprovinz/unraid-docker-templates).
- The language flag and light/dark toggle sit in the same place on every page, pinned to the top-right corner of the viewport.

## [1.4.0] - 2026-06-02

### Added

- **`CONFIG_DIR` for a separate database volume** (`lib/config.ts`). Map `DATA_DIR` (`/data`) for files and `CONFIG_DIR` (`/config`) for the database. The Unraid template exposes both as Data Directory and Config Directory.
- **Custom branding.** `APP_NAME` (wordmark and tab title), `APP_LOGO` (logo image URL replacing the feather) and `ACCENT_COLOR` (hex for buttons, ring and accents), each falling back to the default when unset or invalid (`lib/branding.ts`, `components/BrandingProvider.tsx`).
- **Download limit and burn after download.** The file and its row are deleted atomically once the limit is reached (`lib/downloads.ts`, `registerDownload`, column `max_downloads`). Encrypted shares verify the key before counting, so a bogus request can't use up the limit.
- **Inline image and PDF preview** on the download page through `?inline=1`, which never counts as a download. Shown only for unlimited, password-less shares.
- **Save the QR code as a PNG** (4×, client-side, no extra dependency).
- **Link previews (Open Graph and Twitter cards).** A branded 1200×630 card that never reveals the file's name.

### Changed

- **New logo**: a gold medallion with the feather carved out as negative space (`components/Logo.tsx`). The favicon, README banner and Unraid template icon match it, and `APP_LOGO` still overrides it.
- The ambient aurora drifts slowly (34s) and holds still for reduced motion.
- Centered header brand, with the light/dark and language controls floating top right (`app/page.tsx`).
- The result and download windows glow along their gold border on hover, like the drop zone (`app/globals.css`).
- The result heading reads "Your link is ready" / "Dein Link ist bereit".
- Init-log banner subtitle reads "Encrypted at rest, auto-deleted when the link expires" (`docker-entrypoint.sh`). The stray separator above the ASCII banner is gone, with spacing before the title block (`print-banner.sh`).
- Download-limit strings are phrased count-neutral and, with the new "Save QR code" label, translated into all 26 languages.
- Backward compatible, no migration needed. `CONFIG_DIR` defaults to `DATA_DIR`. To move to two volumes, move `db.sqlite` into the config volume before starting, or a fresh empty database is created.

### Security

- **Inline preview restricted to inert types.** The server allowlists PNG, JPEG, GIF, WebP and PDF (`lib/preview.ts`) and sends `X-Content-Type-Options: nosniff`. Everything else downloads as an attachment.

## [1.3.0] - 2026-06-01

### Added

- **Confetti on a finished upload.** A short gold and violet burst when the share link appears (`components/ResultPanel.tsx`, `canvas-confetti`, lazily loaded, off for reduced motion).

### Changed

- **One floating-glass design.** The result panel and the download page use the same frosted `.fd-glass` surface as the drop zone.
- **The logo returns to the start.** Clicking it resets the upload on the home page and links home from a download page.
- **Clearer copy.** Headline, subtitle, drop zone, result and download wording state plainly what featherdrop does (encrypted at rest, deleted on expiry, no account). English and German refreshed.
- **Wordmark in Bitter.** Medium 500 Italic, self-hosted through `next/font/google` (`app/fonts.ts`), with no font file in the repo. The rest of the UI keeps its sans-serif.

## [1.2.0] - 2026-06-01

### Added

- **Server encryption mode for short links.** A third at-rest mode beside password and link: with `MASTER_KEY` set, a password-less upload wraps its per-file age key with the master key and stores it, so the link is just `…/d/aB3xK` (`lib/encmode.ts`).
- **`MASTER_KEY`.** Optional, masked in the Unraid template. Generate it with `openssl rand -base64 32`. It lives only in the container environment, never in `/data`. Keep it secret and back it up, because losing it makes password-less files unrecoverable. Empty keeps the long `#key` links.
- **Template dropdowns** for `ENCRYPT_UPLOADS` (`true | false`) and `DEFAULT_EXPIRY` (`7d | 1h | 6h | 1d | 30d | never`).
- **Browser-tab favicon** (`app/icon.svg`), centered to read cleanly at 16×16.

### Changed

- **Floating frosted-glass UI** over a soft gold and violet background, with the feather crowning the drop zone and a larger logo and wordmark in the header. The drop zone is a recessed glass well that lights up gold on hover.
- **Accent colour matches the logo**: gold `#d4af37` instead of violet for buttons, the progress ring and the copy button.
- The subtitle reads "Encrypted, and gone when it expires." in all 26 languages, and the redundant footer line is gone.
- With `MASTER_KEY` unset, password-less shares keep their long `#fragment` links. The mode is recorded per file.

### Fixed

- **Copy-link did nothing over plain HTTP.** Copying falls back to a method that works without a secure context (`lib/clipboard.ts`), shows a hint if even that is blocked, and the link input selects on focus.
- **Init-log banner ran into the separator line.** `print-banner.sh` adds a newline after the banner, and the subtitle matches the UI wording ("encrypted, auto-expiring").

## [1.1.0] - 2026-06-01

### Added

- **At-rest encryption, on by default.** Every upload is encrypted on the server with [age](https://age-encryption.org) to a fresh per-file key, with the filename and type inside the file. Two modes, chosen automatically:
  - **Password shares**: the per-file key is wrapped with your password (age scrypt). Without it the file is unreadable, even to the operator.
  - **Link shares**: the key rides in the share link's `#fragment` (`…/d/<slug>#k=…`) and never reaches the server.
- **26-language UI**, detected from the browser (cookie, then `Accept-Language`, then English) and resolved on the server, with a flag switcher in the header and on the download page and right-to-left support for Arabic and Hebrew.
- **`ENCRYPT_UPLOADS`** (default `true`) to store new uploads as plaintext if needed.
- A unit-test suite (`npm test`, 50+ assertions) and a CI test job.

### Changed

- The download flow authorizes with the password or link key, then streams the decrypted file. The real filename is revealed only after that.
- Upload finalize judges completeness from the actual bytes on disk against the declared length (`lib/upload.ts`).
- Translations live in typed per-language files (`lib/i18n/locales/<code>.ts`) with English as the source, and a parity test keeps every key present.
- Backward compatible: the schema migrates in place, and files uploaded before 1.1.0 keep working as unencrypted blobs.

### Security

- Fixed a password-gate bypass on the plaintext download path: the download cookie is verified in constant time against a token derived from the password hash.

## [1.0.0] - 2026-06-01

### Added

- Initial release of **featherdrop**, a clean, login-free, self-hosted file sharer built as a single Next.js and Mantine container.
- One-page upload: a central drop zone, a settings panel (expiry and optional password) on the right, and an upload-progress overlay on the drop zone. Light/dark toggle.
- **Resumable uploads** through tus (`@tus/server`, `tus-js-client`).
- Per-share **expiry** (1h / 6h / 1d / 7d / 30d / never) and an optional **password** (scrypt-hashed, never stored in plain text). The download cookie is derived from the server-only hash, so it can't be forged from the public link.
- Share page with a copyable link and a QR code, plus a native streaming download.
- Files on a local volume and metadata in a single SQLite file (`better-sqlite3`). No database server, no accounts.
- Background cleanup of expired files and their metadata.
- Gold **featherdrop logo**, a flowing feather with a light to metallic to deep gold gradient, as an inline SVG in the header, the download page and the not-found page (source art in `.github/assets/featherdrop-logo.svg`).
- `.github/assets/icon.png` (512×512) as the Unraid template icon, and a white `#ffffff` 1600×500 README banner with the feather centered and no text. The README hero follows the canonical order: centered `<h1>`, tagline, banner, badge row, description.
- `scripts/render-assets.mjs` renders the banner and icon from the logo SVG (with `@resvg/resvg-js` installed on demand).
- Unraid Community Applications template, multi-arch image (`ghcr.io/junkerderprovinz/featherdrop`, amd64 and arm64), ASCII init-log banner, CI (ESLint, typecheck, XML template lint) and a release workflow. CI opts JavaScript actions into Node 24 (`FORCE_JAVASCRIPT_ACTIONS_TO_NODE24`).

[1.9.0]: https://github.com/junkerderprovinz/featherdrop/compare/v1.8.0...v1.9.0
[1.8.0]: https://github.com/junkerderprovinz/featherdrop/compare/v1.7.0...v1.8.0
[1.7.0]: https://github.com/junkerderprovinz/featherdrop/compare/v1.6.0...v1.7.0
[1.6.0]: https://github.com/junkerderprovinz/featherdrop/compare/v1.5.0...v1.6.0
[1.5.0]: https://github.com/junkerderprovinz/featherdrop/compare/v1.4.0...v1.5.0
[1.4.0]: https://github.com/junkerderprovinz/featherdrop/compare/v1.3.0...v1.4.0
[1.3.0]: https://github.com/junkerderprovinz/featherdrop/compare/v1.2.0...v1.3.0
[1.2.0]: https://github.com/junkerderprovinz/featherdrop/compare/v1.1.0...v1.2.0
[1.1.0]: https://github.com/junkerderprovinz/featherdrop/compare/v1.0.0...v1.1.0
[1.0.0]: https://github.com/junkerderprovinz/featherdrop/releases/tag/v1.0.0
