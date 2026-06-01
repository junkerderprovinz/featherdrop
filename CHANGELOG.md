# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [2.8.2] — 2026-06-01

### Changed

- **i18n polish for the download-limit strings.** The "downloads left" string is
  phrased count-neutral so it reads correctly for any count in every language
  (avoiding i18next CLDR plural pitfalls where missing `_few`/`_many` forms fell
  back to English), and `settings.limitDownloads` / `settings.maxDownloads` /
  `download.downloadsLeft` are now properly translated across all 26 locales
  (24 were English placeholders).

## [2.8.1] — 2026-06-01

### Security

- **Inline preview restricted to inert types.** The preview (`?inline=1`, added
  in v2.8.0) echoed the uploader-controlled content type with an `inline`
  disposition, which could render attacker-supplied HTML/SVG on the app's origin.
  Inline is now allowlisted server-side to PNG/JPEG/GIF/WebP/PDF
  (`lib/preview.ts`, enforced in `app/api/d/[slug]/route.ts`) and sent with
  `X-Content-Type-Options: nosniff`; everything else downloads as an attachment.

## [2.8.0] — 2026-06-01

### Added

- **Inline image/PDF preview** on the download page (`components/DownloadView.tsx`).
  The download route serves `?inline=1` with `Content-Disposition: inline` and
  **without** counting a download (`app/api/d/[slug]/route.ts`); the reveal POST
  returns the MIME type. Preview is shown only for unlimited, password-less
  shares, so it can never bypass a download limit.

## [2.7.0] — 2026-06-01

### Added

- **Download limit / burn-after-download.** Cap how many times a share can be
  downloaded; the file and its row are deleted atomically once the limit is
  reached. Logic in `lib/downloads.ts` (TDD) + `server/db.ts` `registerDownload`
  (atomic count/delete), schema column `max_downloads`, wired through
  `app/api/finalize`, `app/api/d/[slug]`, `components/SettingsPanel.tsx`,
  `app/page.tsx`, and `components/DownloadView.tsx` (shows remaining downloads).
  Encrypted shares verify the key before counting, so a bogus request can't
  exhaust the limit. Unlimited shares are unchanged.

## [2.6.0] — 2026-06-01

### Added

- **Custom branding for self-hosters** — `APP_NAME` (wordmark + tab title),
  `APP_LOGO` (logo image URL replacing the feather), and `ACCENT_COLOR` (hex
  driving buttons/ring/accents). Logic in `lib/branding.ts` (TDD), shared via
  `components/BrandingProvider.tsx`, wired through `app/layout.tsx`, `theme.ts`,
  `components/Logo.tsx`, `app/page.tsx`, `components/DownloadView.tsx`; exposed in
  the Unraid template and README. Each value falls back to the default
  featherdrop branding when unset or invalid.

## [2.5.3] — 2026-06-01

### Changed

- **Centered header brand** (`app/page.tsx`): the logo + wordmark are centered;
  the light/dark and language controls float top-right.

## [2.5.2] — 2026-06-01

### Changed

- **Reactive edge on the result & download windows** (`app/globals.css`): the
  `.fd-glass` border lights up with a soft gold glow on hover, like the drop zone.
- **Result heading wording**: now "Your link is ready" / "Dein Link ist bereit"
  (`lib/i18n/locales/en.ts`, `lib/i18n/locales/de.ts`).

### Fixed

- **Init-log banner** (`print-banner.sh`): removed the stray separator rule above
  the ASCII banner and added spacing before the title block.

## [2.5.1] — 2026-06-01

### Changed

- **Init-log banner subtitle realigned with the UI copy** (`docker-entrypoint.sh`):
  now "Encrypted at rest, auto-deleted when the link expires".

## [2.5.0] — 2026-06-01

### Added

- **`CONFIG_DIR` — separate database volume.** The SQLite metadata database can
  live on its own volume, apart from the bulk uploads (`lib/config.ts`). Map
  `DATA_DIR` (`/data`) for files and `CONFIG_DIR` (`/config`) for the database;
  the Unraid template now exposes both **Data Directory** and **Config
  Directory** (`templates/featherdrop.xml`).

### Compatibility

- Backward-compatible: `CONFIG_DIR` defaults to `DATA_DIR`, so single-volume
  installs keep working. To migrate to two volumes, move `db.sqlite` into the
  config volume before starting (otherwise a fresh empty DB is created).

## [2.4.1] — 2026-06-01

### Changed

- **Brand wordmark in Bitter.** The "featherdrop" wordmark in the header and on
  the download page is now set in Bitter (a humanist slab serif, SIL OFL), Medium
  500 Italic, self-hosted via `next/font/google` (`app/fonts.ts`, applied in
  `app/page.tsx` and `components/DownloadView.tsx`). No font file is shipped in
  the repo; the rest of the UI keeps its sans-serif.

## [2.3.0] — 2026-06-01

### Added

- **Confetti on a finished upload.** When an upload reaches 100% and the share
  link appears, a short gold/violet confetti burst celebrates it
  (`components/ResultPanel.tsx`, `canvas-confetti`, lazily loaded; disabled for
  reduced-motion users).

### Changed

- **One consistent floating-glass design.** The result panel and the download
  page now use the same frosted `.fd-glass` surface as the drop zone
  (`components/ResultPanel.tsx`, `components/DownloadView.tsx`).
- **Logo returns to the start.** Clicking the logo resets the upload on the home
  page and links home from a download page (`app/page.tsx`,
  `components/DownloadView.tsx`).
- **Clearer, more professional copy.** Headline, subtitle, drop zone, result and
  download wording rewritten to state plainly what featherdrop does (encrypted
  at rest, auto-deleted on expiry, no account). English + German refreshed
  (`lib/i18n/locales/en.ts`, `lib/i18n/locales/de.ts`).

## [2.2.0] — 2026-06-01

### Added

- **Server encryption mode → short links.** A third at-rest mode beside
  *password* and *link*. When `MASTER_KEY` is set, a password-less upload wraps
  its per-file age key with the master key and stores it, instead of returning
  the key in the share URL — so the link is just `…/d/aB3xK`, no `#fragment`.
  The recipient opens the short link and the server decrypts with its master
  key; no credential needed (`lib/encmode.ts`, `app/api/finalize`, `app/api/d`).
- **`MASTER_KEY` config.** New optional env var (masked Unraid template field).
  Generate with `openssl rand -base64 32`. It lives only in the container
  environment, never in `/data`, so a stolen data backup stays unreadable. Keep
  it secret and back it up — losing it makes password-less files unrecoverable.
  Empty = the existing long `#key` links.
- **Template dropdowns.** `ENCRYPT_UPLOADS` (`true | false`) and
  `DEFAULT_EXPIRY` (`7d | 1h | 6h | 1d | 30d | never`) are now pick-lists in the
  Unraid template instead of free-text fields.

### Compatibility

- Fully backward-compatible. With `MASTER_KEY` unset, behaviour is identical to
  v2.1.x (long `#fragment` links). The mode is recorded per file, so existing
  files keep the mode they were created with.

## [2.1.3] — 2026-06-01

### Added

- **Browser-tab favicon.** The gold feather now shows in the browser tab
  (`app/icon.svg`, served automatically by Next.js), centered to read cleanly
  at 16×16.

## [2.1.2] — 2026-06-01

### Fixed

- **Copy-link button did nothing on plain-HTTP LAN access.** The browser's
  Clipboard API is only available in a secure context (HTTPS / localhost), so on
  `http://<lan-ip>:3000` it was unavailable and the copy silently failed. Copying
  now falls back to a legacy method that works without HTTPS (`lib/clipboard.ts`),
  and shows a hint if even that is blocked. The link input also selects on focus.

### Changed

- **Accent colour now matches the logo.** The primary colour is the feather's
  gold (`#d4af37`) instead of violet — buttons, the upload progress ring and the
  copy button all echo the brand.

## [2.1.1] — 2026-06-01

### Fixed

- **Init-log banner ran into the separator line.** The shared ASCII banner file
  has no trailing newline, so `print-banner.sh` printed the `─────` rule fused
  onto the banner's last line. It now adds a newline after the banner. Also
  aligned the banner subtitle with the UI wording ("encrypted, auto-expiring").

## [2.1.0] — 2026-06-01

### Changed

- **Refined, modern UI.** The home page is now a **floating frosted-glass
  window** over a soft gold/violet ambient background, with the feather mark
  crowning the drop zone and a larger logo + wordmark in the header. The drop
  zone is a recessed glass well that lights up gold on hover.
- Reworked the hero copy: the subtitle now reads *"Encrypted, and gone when it
  expires."* (localised in all 26 languages), and the redundant footer line was
  removed.

## [2.0.1] — 2026-06-01

### Fixed

- **Uploads failed with "finalize 409" / "Freigabe konnte nicht abgeschlossen
  werden" for every non-empty file.** The completeness check trusted the tus
  sidecar's `offset`, which `@tus/file-store` leaves frozen at `0` (it tracks
  progress via the live file size, not the sidecar). Finalize now judges
  completeness from the actual on-disk byte count against the declared upload
  length (`lib/upload.ts`, covered by tests). Sharing works again.

## [2.0.0] — 2026-06-01

A major release: every uploaded file is now **encrypted at rest**, and the
interface speaks **26 languages**.

### Added

- **At-rest encryption (default on).** Every upload is encrypted on the server
  with [age](https://age-encryption.org) (Filippo Valsorda's audited,
  streaming, authenticated format) to a fresh per-file key. The original
  filename and type are encrypted **inside** the file, so a stolen disk or
  backup reveals neither contents nor names. Two modes, chosen automatically:
  - **Password shares** — the per-file key is wrapped with your password (age
    scrypt) and only the wrapped blob is stored. Without the password the file
    is unreadable, even to the server operator.
  - **Link shares (no password)** — the key rides in the share-link
    `#fragment` (`…/d/<slug>#k=…`) and **never reaches the server**. Anyone with
    the full link can download; the database alone cannot decrypt the file.
- **Multi-language UI (26 languages)** — English, German, French, Spanish,
  Italian, Portuguese, Dutch, Polish, Russian, Ukrainian, Czech, Swedish,
  Danish, Finnish, Norwegian, Turkish, Greek, Hungarian, Romanian, Japanese,
  Korean, Chinese, Arabic, Hebrew, Thai and Vietnamese. The language is
  **detected from the browser** on first visit (cookie → `Accept-Language` →
  English fallback) and resolved **on the server**, so the page renders
  translated even without JavaScript.
- **Flag language switcher** beside the light/dark toggle, in the header and on
  the download page, so both uploader and recipient can change language. The
  choice persists in a cookie.
- **Right-to-left support** for Arabic and Hebrew via Mantine's
  `DirectionProvider` (the whole UI mirrors, not just text).
- **`ENCRYPT_UPLOADS`** environment variable (default `true`) to opt out of
  encryption for new uploads if ever needed.
- A unit-test suite (`npm test`, 50+ assertions) and a CI test job covering the
  encryption round-trip, tamper/wrong-key rejection, the download-token gate,
  language detection, and the schema migration.

### Changed

- The download flow now authorizes (password or link key) and then streams the
  **decrypted** file natively; the share page reveals the real filename only
  after the key/password is supplied.
- Translations live in typed per-language files (`lib/i18n/locales/<code>.ts`)
  with English as the source of truth; a compile-time type plus a runtime parity
  test guarantee no key is ever missing or empty. Native-speaker corrections are
  a one-file edit.

### Security

- Fixed a password-gate bypass on the legacy plaintext download path: the
  download cookie is now verified (constant-time) against an unforgeable,
  password-hash-derived token rather than merely required to be present.

### Migration

- **Backward compatible.** The schema migrates in place (additive columns) and
  files uploaded before v2.0.0 keep working as unencrypted blobs. Only uploads
  made **after** the update are encrypted — existing shares are not rewritten.

## [1.0.3] — 2026-06-01

### Changed

- Banner now follows the house style guide exactly: a **white `#ffffff`
  1600×500 card with the gold feather centered and no text**, replacing the
  transparent emblem crop that shipped in 1.0.2.
- README hero reordered to the canonical style-guide sequence: centered `<h1>`
  → tagline (a featherdrop-specific exception) → banner → badge row →
  description. The full description moved back **below** the badges.

## [1.0.2] — 2026-06-01

### Changed

- New **featherdrop logo** — a redrawn, more flowing gold feather. It replaces
  the previous mark everywhere it appears: the header, the download page, the
  not-found page, and the `.github/assets/featherdrop-logo.svg` source art.
- Regenerated `.github/assets/featherdrop-banner.png` and
  `.github/assets/icon.png` (512×512) from the new logo.

### Added

- `scripts/render-assets.mjs` — a manual asset renderer that produces the banner
  and icon from `featherdrop-logo.svg`, centering the feather via its real
  bounding box. Uses `@resvg/resvg-js` (installed on demand, not a dependency).

### Maintenance

- CI workflows now opt JS-based actions into Node 24
  (`FORCE_JAVASCRIPT_ACTIONS_TO_NODE24`) ahead of GitHub's forced switch on
  2026-06-16, clearing the Node 20 deprecation warning on the checkout and
  Docker actions.

## [1.0.1] — 2026-06-01

### Added

- Gold **featherdrop logo** (a feather with a light→metallic→deep gold gradient)
  as an inline SVG component, replacing the placeholder feather icon in the
  header, download page, and not-found page. Source art at
  `.github/assets/featherdrop-logo.svg`.
- `.github/assets/icon.png` (512×512) rendered from the logo, used as the Unraid
  Community Applications template icon.

## [1.0.0] — 2026-05-31

### Added

- Initial release of **featherdrop** — a clean, login-free, self-hosted file
  sharer built as a single Next.js + Mantine container.
- One-pager upload: a central drop zone; selecting a file reveals a settings
  panel (expiry + optional password) on the right, with an upload-progress
  overlay shown directly on the drop zone. Light/dark toggle.
- **Resumable uploads** via tus (`@tus/server` + `tus-js-client`) — large files
  survive connection drops.
- Per-share **expiry** (1h / 6h / 1d / 7d / 30d / never) and optional
  **password** protection (scrypt-hashed; never stored in plain text). The
  download permission cookie is derived from the server-only password hash, so
  it cannot be forged from the public link.
- Share page with a copyable link and a QR code; native streaming download.
- Local-volume storage for files; metadata in a single SQLite file
  (`better-sqlite3`) — no separate database server, no accounts.
- Background cleanup job that removes expired files and their metadata.
- Unraid Community Applications template, multi-arch image
  (`ghcr.io/junkerderprovinz/featherdrop`, amd64 + arm64), ASCII init-log
  banner, CI (ESLint + typecheck + XML template lint) and release workflow.
