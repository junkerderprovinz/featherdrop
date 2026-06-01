# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
