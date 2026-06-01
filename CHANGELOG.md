# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.0.2] — 2026-06-01

### Changed

- New **featherdrop logo** — a redrawn, more flowing gold feather. It replaces
  the previous mark everywhere it appears: the header, the download page, the
  not-found page, and the `.github/assets/featherdrop-logo.svg` source art.
- README hero reworked to the style guide. The centered `featherdrop` heading
  and the tagline now sit **above** the banner; the banner image itself is
  **logo-only** (the wordmark moved out of the image and into the heading text).
- Regenerated `.github/assets/featherdrop-banner.png` (logo-only, no wordmark)
  and `.github/assets/icon.png` (512×512) from the new logo.

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
