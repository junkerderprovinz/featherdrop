<!--
Template for the Unraid Community Applications support thread.
Create it at https://forums.unraid.net (Docker Containers board), then point the
template's <Support> at the thread URL. Title format matches the sister apps.
-->

# Title

[Support] junkerderprovinz - featherdrop

# Body

**featherdrop** is a sleek, modern, self-hosted file sharer. Drop a file, set an
expiry (plus an optional password or download limit), and share a short link or
QR code. Files are encrypted at rest, uploads are resumable, and metadata lives
in a single SQLite file — no accounts, no separate database, no tracking.

**Links**
- Source: https://github.com/junkerderprovinz/featherdrop
- Image: `ghcr.io/junkerderprovinz/featherdrop:latest` (amd64 + arm64)
- Changelog: https://github.com/junkerderprovinz/featherdrop/releases

**Features**
- 🔒 Encrypted at rest (age) — filename and type encrypted inside the file
- 🔑 Optional password (end-to-end), or short links via a server `MASTER_KEY`
- ⏳ Expiry 1h–30d or never, plus optional burn-after-N-downloads
- 🖼️ Inline image/PDF preview · savable QR code · clean link previews
- 🌍 26 languages (right-to-left for Arabic/Hebrew) · light/dark
- 🎨 Custom branding — name, logo, accent colour (env vars)
- 📦 One container · resumable uploads (tus) · SQLite (no DB server)
- 🧹 No accounts, no telemetry — your files stay on your server

**Installation**
Search "featherdrop" in Community Applications and click Install. Map the **Data**
directory (uploads) and **Config** directory (database), pick a port, and — behind
a reverse proxy — set `BASE_URL` to your public URL. Apply, then open the WebUI.

**Configuration (key variables)**
- `BASE_URL` — your public URL, so share links use your domain
- `DEFAULT_EXPIRY` — `1h` | `6h` | `1d` | `7d` | `30d` | `never`
- `MAX_FILE_SIZE` — bytes; `0` = unlimited
- `ENCRYPT_UPLOADS` — encrypt new uploads at rest (default `true`)
- `MASTER_KEY` — optional secret → short links for password-less shares
- `APP_NAME` / `APP_LOGO` / `ACCENT_COLOR` — custom branding

**Support**
Reply here, or open an issue: https://github.com/junkerderprovinz/featherdrop/issues

If featherdrop saves you a trip to a third-party host, you can buy me a coffee:
https://buymeacoffee.com/junkerderprovinz
