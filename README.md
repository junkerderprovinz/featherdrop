<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/junkerderprovinz/featherdrop/main/.github/assets/featherdrop-banner-dark.png">
    <img src="https://raw.githubusercontent.com/junkerderprovinz/featherdrop/main/.github/assets/featherdrop-banner.png" alt="featherdrop" width="100%">
  </picture>
</p>

<p align="center">
  <a href="https://github.com/junkerderprovinz/featherdrop/actions/workflows/build.yml"><img src="https://img.shields.io/github/actions/workflow/status/junkerderprovinz/featherdrop/build.yml?branch=main&label=Build&style=for-the-badge&logo=githubactions&logoColor=white" alt="Build" height="36"></a>&nbsp;
  <a href="https://github.com/junkerderprovinz/featherdrop/actions/workflows/lint.yml"><img src="https://img.shields.io/github/actions/workflow/status/junkerderprovinz/featherdrop/lint.yml?branch=main&label=Lint&style=for-the-badge&logo=githubactions&logoColor=white" alt="Lint" height="36"></a>&nbsp;
  <a href="https://hub.docker.com/r/junkerderprovinz/featherdrop"><img src="https://img.shields.io/docker/pulls/junkerderprovinz/featherdrop?style=for-the-badge&logo=docker&logoColor=white&label=Pulls&color=1d99f3" alt="Docker Pulls" height="36"></a>&nbsp;
  <a href="https://hub.docker.com/r/junkerderprovinz/featherdrop"><img src="https://img.shields.io/docker/image-size/junkerderprovinz/featherdrop/latest?style=for-the-badge&logo=docker&logoColor=white&label=Size&color=1d99f3" alt="Image Size" height="36"></a>&nbsp;
  <a href="https://github.com/junkerderprovinz/featherdrop/pkgs/container/featherdrop"><img src="https://img.shields.io/badge/Arch-amd64%20%7C%20arm64-success?style=for-the-badge&logo=linux&logoColor=white" alt="Arch" height="36"></a>&nbsp;
  <a href="https://go.dev"><img src="https://img.shields.io/badge/Go-00ADD8?style=for-the-badge&logo=go&logoColor=white" alt="Go" height="36"></a>&nbsp;
  <a href="https://mantine.dev"><img src="https://img.shields.io/badge/Mantine-339af0?style=for-the-badge&logo=mantine&logoColor=white" alt="Mantine" height="36"></a>&nbsp;
  <a href="https://unraid.net"><img src="https://img.shields.io/badge/Unraid-Template-f15a2c?style=for-the-badge&logo=unraid&logoColor=white" alt="Unraid" height="36"></a>&nbsp;
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-yellow?style=for-the-badge&logo=opensourceinitiative&logoColor=white" alt="License" height="36"></a>
</p>

<br>

<p align="center">
featherdrop is a <b>sleek, feather-light</b>, self-hosted drop zone for your files — think
<b>WeTransfer</b> or <b>Smash</b>, but it runs on your own server with no size paywall. Drop a
file, set how long it lives (plus an optional password or download limit), and share a short
link or QR code. End-to-end encrypted, resumable uploads, one small container. No accounts,
no clouds, no tracking, no nonsense.
</p>

<br>

<p align="center">
  <a href="https://buymeacoffee.com/junkerderprovinz">
    <img src=".github/assets/button-buy-me-a-coffee.svg" alt="Buy me a coffee" width="220">
  </a>
</p>

<br>

## Table of Contents

1. [What is this?](#1-what-is-this)
2. [Screenshots](#2-screenshots)
3. [How it works](#3-how-it-works)
4. [Security & Privacy](#4-security--privacy)
5. [Languages](#5-languages)
6. [Quick Start on Unraid](#6-quick-start-on-unraid)
7. [Configuration](#7-configuration)
8. [Reverse Proxy](#8-reverse-proxy)
9. [Local Development](#9-local-development)
10. [Contributing / License](#10-contributing--license)
11. [Support this project](#11-support-this-project)
<br>

## 1. What is this?

featherdrop is a **sleek, feather-light**, self-hosted file-sharing page for your own
server — your own private **WeTransfer**, minus the accounts, size paywalls, and handing your
files to someone else's cloud. It's a much simpler take inspired by [Pingvin Share](https://github.com/stonith404/pingvin-share).
Where Pingvin ships a full backend, database, and accounts, featherdrop is a
**single container** with **no login** and **no separate database**:

- Open the page → a central **drop zone** is right there.
- Drop a file → a settings panel slides in (**expiry**, optional **password**,
  optional **download limit**), and a progress ring overlays the drop zone while
  it uploads.
- You get a **shareable link** plus a **QR code** you can save as a PNG. The
  recipient downloads it any time until it expires.
- Pasting the link into a chat shows a **clean preview card** — your branding,
  never the file's name.
- A light/dark toggle and a **flag language picker** sit in the header — the UI
  speaks [26 languages](#5-languages) and picks yours from the browser.

**Highlights**

- 🔒 **Zero-knowledge** — files are **end-to-end encrypted in your browser**
  before upload (libsodium XChaCha20-Poly1305); the server only ever stores
  opaque ciphertext and never sees your files, their names, or the key.
- ⏳ **Self-destructing** — expiry from 1 hour to 30 days (or never), plus an
  optional **burn-after-N-downloads**.
- 🖼️ **Inline image/PDF preview** and a savable **QR code** on the share page,
  with **clean link previews** that never leak the file's name.
- 🌍 **26 languages** (right-to-left for Arabic & Hebrew), light/dark, and
  **custom branding** (name, logo, accent colour) via env vars.
- 📦 **One container** — resumable uploads ([tus](https://tus.io)), a single
  SQLite file, separate data/config volumes, multi-arch (amd64 + arm64).
- 🧹 **Private by design** — no accounts, no telemetry, no third-party calls at
  runtime; your files stay on your server.

What it deliberately does **not** have: user accounts, OIDC/LDAP, email, malware
scanning, S3 backends. If you need those, use Pingvin Share — that is the point.

<br>

## 2. Screenshots

<p align="center">
  <img src="https://raw.githubusercontent.com/junkerderprovinz/featherdrop/main/.github/assets/screenshots/home-light.png" alt="featherdrop home — light theme" width="90%">
  <br><em>The home page — drop a file to share it.</em>
</p>

<br>

<p align="center">
  <img src="https://raw.githubusercontent.com/junkerderprovinz/featherdrop/main/.github/assets/screenshots/home-dark.png" alt="featherdrop home — dark theme" width="90%">
  <br><em>Light and dark themes, with a flag language picker.</em>
</p>

<br>

<p align="center">
  <img src="https://raw.githubusercontent.com/junkerderprovinz/featherdrop/main/.github/assets/screenshots/upload.png" alt="Upload with share options" width="90%">
  <br><em>Set an expiry, an optional password, and a download limit before sharing.</em>
</p>

<br>

<p align="center">
  <img src="https://raw.githubusercontent.com/junkerderprovinz/featherdrop/main/.github/assets/screenshots/result.png" alt="Share link ready, with QR code" width="90%">
  <br><em>Your link is ready — copy it or save the QR code.</em>
</p>

<br>

<p align="center">
  <img src="https://raw.githubusercontent.com/junkerderprovinz/featherdrop/main/.github/assets/screenshots/download.png" alt="Recipient download page" width="90%">
  <br><em>What the recipient sees: file info and a download button.</em>
</p>

<br>

## 3. How it works

```
Browser (drop zone, Mantine UI)
   │  resumable upload (tus)
   ▼
featherdrop container (single static Go binary, embedded React/Vite SPA)
   ├─ /files            tus upload endpoint
   ├─ /api/finalize     move file into store, write metadata, mint share slug
   ├─ /d/<slug>         share page (info, password gate, download)
   └─ cleanup job       deletes expired files
   ▼
/data volume (uploads, bulk)        /config volume (metadata, small)
   ├─ uploads/<id>   the files          └─ db.sqlite   (pure-Go SQLite — a file, not a server)
   └─ tmp/<id>       in-progress uploads
```

`/data` (bulk files) and `/config` (the small SQLite database) are **separate
volumes**, so you can keep uploads on array storage and the database on a fast
SSD. `CONFIG_DIR` defaults to `DATA_DIR`, so a single-volume setup still works.

Uploads are **resumable**: a dropped connection on a multi-GB transfer resumes
instead of starting over. Passwords are **scrypt-hashed**, never stored in plain
text, and large downloads **stream natively** (no in-browser buffering).

<br>

## 4. Security & Privacy

featherdrop is built to be **self-hosted**: your files and their metadata live
only on your server, and the app talks to nobody else.

- **No accounts, no tracking.** No sign-up, no analytics, no telemetry, and no
  third-party scripts or fonts pulled at runtime — nothing phones home.
- **Your data stays yours.** Uploads sit on your `/data` volume, metadata in a
  local SQLite file. Nothing is ever sent to a cloud or external service.
- **Zero-knowledge by design** — every file is **end-to-end encrypted in your
  browser** before upload; the filename and type are encrypted *inside* the blob,
  so the server (and any stolen disk or backup) sees only opaque ciphertext, never
  your files or their names ([details below](#zero-knowledge-encryption)).
- **The operator can't read your files either.** The key never reaches the
  server — it lives in the link's `#fragment`, or is derived from your password.
- **Self-destructing.** Every share has an expiry (down to 1 hour), and an
  optional **download limit** burns the file the moment it's reached — shares are
  removed automatically, no manual cleanup needed.
- **Minimal attack surface.** No login to brute-force, no user database to leak;
  share slugs are unguessable, and share pages and link previews never expose the
  file's name.

> Provided under the MIT licence **without warranty** — you run it, you own the
> data and the responsibility. **HTTPS is recommended** (see
> [Reverse Proxy](#8-reverse-proxy)) — the clipboard, streaming downloads, and
> large (>500 MB) uploads need a secure context; smaller uploads work over plain
> HTTP too.

### Zero-knowledge encryption

Every file is **encrypted in your browser before it is uploaded**, with
[libsodium](https://doc.libsodium.org)'s `XChaCha20-Poly1305` streaming AEAD
(64 KiB chunks). The **original filename and content type are encrypted inside
the blob**, so the server only ever stores — and serves back — opaque ciphertext
and its length. It performs no cryptography and never receives the key.

The content key never reaches the server. Where it lives depends on the share type:

| Share type | Where the key lives | Link | What the server can decrypt |
|---|---|---|---|
| **Link** (default) | In the share link's `#fragment` | `…/d/<slug>#k=…` | Nothing — the key never leaves the browser |
| **Password** | Derived from your password (Argon2id); only a wrapped copy is stored | `…/d/<slug>` | Nothing without the password — not even the operator |

Because the link key lives in the URL **fragment** (`#k=…`), it is never sent in
an HTTP request and never appears in server logs or your reverse proxy. **Treat
the whole link as the secret:** anyone who has it can download the file until it
expires, and a link copied without its `#k=…` part can't be decrypted — by
design, since the server never had the key.

Downloads also require **proof of key knowledge**: the browser sends a one-way
SHA-256 *verifier* of the content key (`x-fd-key-verifier` header), so someone
who only saw the slug in a proxy or access log can't burn through a share's
download limit — without the verifier (which reveals nothing about the key),
nothing is counted and nothing is deleted. Shares uploaded before this check
existed keep working unchanged.

Encryption and decryption stream through the Origin Private File System and a
service worker, so multi-GB files are never buffered in memory. Over plain HTTP
(not a secure context) OPFS isn't available, so encryption falls back to memory
with a 500 MB cap — use **HTTPS** for larger files. Inline image/PDF previews are
produced entirely in the browser from the decrypted bytes.

> **Upgrading from v3 or earlier?** Shares created before v4 used at-rest
> encryption (age) and stay readable with their original links until they expire.
> The `MASTER_KEY` / `ENCRYPT_UPLOADS` settings only affect those legacy shares
> and no longer apply to new uploads.

<br>

## 5. Languages

featherdrop's interface ships in **26 languages**. On a visitor's first load the
language is taken from their **browser**; a flag picker beside the light/dark
toggle (in the header *and* on the download page) switches it, and the choice is
remembered. Detection runs on the server, so the page is already translated
before any JavaScript loads. Arabic and Hebrew render **right-to-left**.

> 🇬🇧 English · 🇩🇪 Deutsch · 🇫🇷 Français · 🇪🇸 Español · 🇮🇹 Italiano ·
> 🇵🇹 Português · 🇳🇱 Nederlands · 🇵🇱 Polski · 🇷🇺 Русский · 🇺🇦 Українська ·
> 🇨🇿 Čeština · 🇸🇪 Svenska · 🇩🇰 Dansk · 🇫🇮 Suomi · 🇳🇴 Norsk · 🇹🇷 Türkçe ·
> 🇬🇷 Ελληνικά · 🇭🇺 Magyar · 🇷🇴 Română · 🇯🇵 日本語 · 🇰🇷 한국어 · 🇨🇳 中文 ·
> 🇸🇦 العربية · 🇮🇱 עברית · 🇹🇭 ไทย · 🇻🇳 Tiếng Việt

Each language is a typed file under `lib/i18n/locales/`, with English as the
source of truth. A native-speaker correction is a one-file edit — pull requests
welcome.

<br>

## 6. Quick Start on Unraid

Pull the template into Unraid via the console / SSH:

```bash
mkdir -p /boot/config/plugins/dockerMan/templates-user && \
curl -fsSL -o /boot/config/plugins/dockerMan/templates-user/my-featherdrop.xml \
  https://raw.githubusercontent.com/junkerderprovinz/unraid-apps/main/featherdrop/featherdrop.xml
```

Then **Docker → Add Container → featherdrop** under *User templates*. Map the
**Data Directory** (uploads) and **Config Directory** (the database) to your
appdata, pick a port, hit **Apply**, open the WebUI.

The template filename **must** keep the `my-` prefix (`my-featherdrop.xml`) so
Unraid treats it as a user template.

### Plain Docker (no Unraid)

```bash
docker run -d \
  --name featherdrop \
  --restart unless-stopped \
  -p 3000:3000 \
  -e BASE_URL=https://share.yourdomain.tld \
  -e CONFIG_DIR=/config \
  -v /mnt/user/appdata/featherdrop/data:/data \
  -v /mnt/user/appdata/featherdrop/config:/config \
  junkerderprovinz/featherdrop:latest
```

To keep everything on a single volume instead, drop the `CONFIG_DIR` line and
the `/config` mount and map just `-v …:/data` — the database then lives in
`/data` alongside the uploads.

<br>

## 7. Configuration

| Variable | Default | Description |
|---|---|---|
| `BASE_URL` | *(empty)* | Public URL featherdrop is reached at, so share links use your domain. Empty = use the address the browser is on. |
| `DEFAULT_EXPIRY` | `7d` | Expiry pre-selected in the UI. One of `1h`, `6h`, `1d`, `7d`, `30d`, `never`. |
| `MAX_FILE_SIZE` | `0` | Max upload size in bytes. `0` = unlimited (disk-limited). E.g. `5368709120` = 5 GB. |
| `MAX_EXPIRY` | *(empty)* | Longest expiry a visitor may pick: one of `1h`, `6h`, `1d`, `7d`, `30d`, `never`. Empty = no cap. With a finite cap the UI hides longer options (incl. "never") and the server rejects them; `DEFAULT_EXPIRY` is clamped to the cap. |
| `STORAGE_QUOTA` | `0` | Max total bytes of stored shares. `0` = unlimited. New uploads that would exceed it are rejected (HTTP 507) before any byte lands. |
| `RATE_LIMIT` | `true` | Built-in per-IP rate limiting on uploads, finalize and download/password attempts (429 + `Retry-After`). Set `false` to disable, e.g. behind your own limiter. |
| `TRUST_PROXY` | `false` | Set `true` ONLY behind a reverse proxy: rate limits then key on the first `X-Forwarded-For` address instead of the proxy's. Never enable it on a directly-reachable instance. |
| `UPLOAD_PASSWORD` | *(empty)* | Optional upload lock. Empty = anyone can upload (the default). Set it and **creating** a share requires this password (entered once per browser session); **downloading** an existing share link stays open to everyone. The server checks it constant-time on both write paths and never stores or logs it — only a "this instance is protected" flag reaches the browser, never the password. Send over HTTPS. |
| `MASTER_KEY` | *(empty)* | **Legacy.** Only decrypts pre-v4 server-mode shares until they expire; has no effect on new uploads, which are end-to-end encrypted in the browser (see [Zero-knowledge encryption](#zero-knowledge-encryption)). |
| `ENCRYPT_UPLOADS` | `true` | **Legacy.** Applies to the old at-rest path only; new uploads are always end-to-end encrypted client-side. |
| `PORT` | `3000` | Port the server listens on. |
| `DATA_DIR` | `/data` | Where the uploaded files live (bulk). Map this to a volume. |
| `CONFIG_DIR` | *(= `DATA_DIR`)* | Where the SQLite database lives. Defaults to `DATA_DIR` (single volume). Set it (the Unraid template uses `/config`) to keep the small database on a separate, faster volume. |
| `APP_NAME` | `featherdrop` | Custom app name — replaces the wordmark in the header and the browser-tab title. |
| `APP_LOGO` | *(empty)* | Custom logo (SVG/PNG) replacing the feather: a public image **URL**, or a **`data:` URI** (e.g. `data:image/svg+xml;base64,…` — generate with `base64 -w0 logo.svg`) so you need no hosting or file on disk. Empty = the feather. |
| `ACCENT_COLOR` | `#d4af37` | A 6-digit hex colour for buttons, the upload ring and accents. Invalid values fall back to the gold. |

<br>

## 8. Reverse Proxy

featherdrop speaks plain HTTP on `PORT`; put TLS in front of it (Nginx Proxy
Manager, Caddy, Traefik). Two things matter:

- Set **`BASE_URL`** to your public URL so generated links are correct. Use
  **HTTPS** — for link shares the decryption key lives in the URL fragment, and
  TLS keeps the whole link private in transit. HTTPS is also a *secure context*,
  which the clipboard, streaming downloads, and OPFS (large uploads) require;
  over plain HTTP, uploads fall back to an in-memory path capped at 500 MB.
- Allow **large request bodies** and generous timeouts for big uploads. For
  Nginx / NPM advanced config:

```nginx
client_max_body_size 0;        # no cap here (but a CDN may add one — see below)
proxy_read_timeout 3600s;
proxy_send_timeout 3600s;
proxy_request_buffering off;   # stream uploads straight through
```

Uploads are sent in resumable **64 MiB chunks** (tus), so each request stays
small no matter the file size, and a dropped upload resumes from the last chunk.

**Behind Cloudflare or another CDN:** a proxying CDN enforces its *own*
request-body limit *before* your reverse proxy, so `client_max_body_size 0`
cannot override it. Cloudflare's Free and Pro plans cap a request body at
**100 MB** (Business 200 MB, Enterprise 500 MB) and return **413** above it.
Because featherdrop chunks at 64 MiB, files of any size still upload through
Cloudflare — but if you raise `chunkSize` (in `app/page.tsx`) above the cap, or
front featherdrop with another capped proxy, large uploads will 413.

**Remote-access options** (all keep split-horizon DNS — resolve the host to your
LAN reverse proxy internally and to the public edge externally):

| Setup | Inbound port | Upload size | Trade-off |
|---|---|---|---|
| Direct / port-forward (own Nginx/Caddy/Traefik) | 80/443 open | unlimited | fastest, no third party; exposes your IP, needs a stable inbound path |
| Cloudflare Tunnel (`cloudflared`) | none (outbound) | 100 MB/request | zero-config edge + DDoS/WAF, hides IP; the cap is dodged by the 64 MiB chunking |
| Self-hosted tunnel (e.g. Pangolin + a small VPS) | none (outbound) | unlimited | you own the edge + TLS, any size, built-in auth; costs a VPS to run |

<br>

## 9. Local Development

```bash
npm install
npm run dev          # Vite dev server for the React SPA (http://localhost:5173)
```

Build the static SPA and run it the way the container does — the Go backend
serves the embedded SPA plus the JSON/file API on port 3000:

```bash
npm run build:spa            # build the Vite SPA into server-go/webroot
cd server-go && go run .     # serve on http://localhost:3000, data under ./data
```

Run the test suite (pure-logic assertions, no framework needed):

```bash
npm test
```

Stack: a Go backend (`server-go/`) that serves a Vite + React + Mantine v7 SPA
as embedded static assets alongside the JSON/file API, with `react-i18next` for
the UI languages. The browser keeps all zero-knowledge crypto in TypeScript.
Files live under `DATA_DIR` (default `./data`). The published image is built from
`Dockerfile`; the original Next.js server (`Dockerfile.next`) has been retired.

<br>

## 10. Contributing / License

Issues and pull requests welcome:
<https://github.com/junkerderprovinz/featherdrop/issues>

Licensed under the [MIT License](LICENSE).

<br>

## 11. Support this project

If featherdrop saves you a trip to a third-party file host, consider buying me a coffee:

<p align="center">
  <a href="https://buymeacoffee.com/junkerderprovinz">
    <img src=".github/assets/button-buy-me-a-coffee.svg" alt="Buy me a coffee" width="220">
  </a>
</p>

---

<sub>Part of a family of self-hosted Unraid apps + plugins by <b>junkerderprovinz</b> — see them all at <a href="https://github.com/junkerderprovinz">github.com/junkerderprovinz</a>, or install from <a href="https://unraid.net/community/apps">Community Applications</a>.</sub>
