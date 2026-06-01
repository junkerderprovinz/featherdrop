<h1 align="center">featherdrop</h1>

<p align="center">
  <img src="https://raw.githubusercontent.com/junkerderprovinz/featherdrop/main/.github/assets/featherdrop-banner.png" alt="featherdrop" width="100%">
</p>

<p align="center">
  <a href="https://github.com/junkerderprovinz/featherdrop/actions/workflows/build.yml"><img src="https://img.shields.io/github/actions/workflow/status/junkerderprovinz/featherdrop/build.yml?branch=main&label=Build&style=for-the-badge&logo=githubactions&logoColor=white" alt="Build" height="36"></a>&nbsp;
  <a href="https://github.com/junkerderprovinz/featherdrop/actions/workflows/lint.yml"><img src="https://img.shields.io/github/actions/workflow/status/junkerderprovinz/featherdrop/lint.yml?branch=main&label=Lint&style=for-the-badge&logo=githubactions&logoColor=white" alt="Lint" height="36"></a>&nbsp;
  <a href="https://github.com/junkerderprovinz/featherdrop/pkgs/container/featherdrop"><img src="https://img.shields.io/badge/Image-ghcr.io-1d99f3?style=for-the-badge&logo=docker&logoColor=white" alt="Image" height="36"></a>&nbsp;
  <a href="https://github.com/junkerderprovinz/featherdrop/pkgs/container/featherdrop"><img src="https://img.shields.io/badge/Arch-amd64%20%7C%20arm64-success?style=for-the-badge&logo=linux&logoColor=white" alt="Arch" height="36"></a>&nbsp;
  <a href="https://nextjs.org"><img src="https://img.shields.io/badge/Next.js-000000?style=for-the-badge&logo=nextdotjs&logoColor=white" alt="Next.js" height="36"></a>&nbsp;
  <a href="https://mantine.dev"><img src="https://img.shields.io/badge/Mantine-339af0?style=for-the-badge&logo=mantine&logoColor=white" alt="Mantine" height="36"></a>&nbsp;
  <a href="https://unraid.net"><img src="https://img.shields.io/badge/Unraid-Template-f15a2c?style=for-the-badge&logo=unraid&logoColor=white" alt="Unraid" height="36"></a>&nbsp;
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-yellow?style=for-the-badge&logo=opensourceinitiative&logoColor=white" alt="License" height="36"></a>&nbsp;
  <a href="https://buymeacoffee.com/junkerderprovinz"><img src="https://img.shields.io/badge/Buy%20me%20a%20coffee-FFDD00?style=for-the-badge&logo=buymeacoffee&logoColor=black" alt="Buy me a coffee" height="36"></a>
</p>

<br>

<p align="center">
featherdrop is your own self-hosted drop zone — fling a file in, get a link out,
watch it self-destruct on schedule. No accounts, no clouds, no nonsense.
</p>

<br>

## Table of Contents

1. [What is this?](#1-what-is-this)
2. [How it works](#2-how-it-works)
3. [Encryption](#3-encryption)
4. [Languages](#4-languages)
5. [Quick Start on Unraid](#5-quick-start-on-unraid)
6. [Configuration](#6-configuration)
7. [Reverse Proxy](#7-reverse-proxy)
8. [Local Development](#8-local-development)
9. [Contributing / License](#9-contributing--license)

<br>

## 1. What is this?

featherdrop is a small, good-looking file-sharing page for your own server —
a much simpler take inspired by [Pingvin Share](https://github.com/stonith404/pingvin-share).
Where Pingvin ships a full backend, database, and accounts, featherdrop is a
**single container** with **no login** and **no separate database**:

- Open the page → a central **drop zone** is right there.
- Drop a file → a settings panel slides in (**expiry** + optional **password**),
  and a progress ring overlays the drop zone while it uploads.
- You get a **shareable link** (and a QR code). The recipient downloads it any
  time until it expires.
- A light/dark toggle and a **flag language picker** sit in the header — the UI
  speaks [26 languages](#4-languages) and picks yours from the browser.

What it deliberately does **not** have: user accounts, OIDC/LDAP, email, malware
scanning, S3 backends. If you need those, use Pingvin Share — that is the point.

<br>

## 2. How it works

```
Browser (drop zone, Mantine UI)
   │  resumable upload (tus)
   ▼
featherdrop container (Next.js + small custom Node server)
   ├─ /files            tus upload endpoint
   ├─ /api/finalize     move file into store, write metadata, mint share slug
   ├─ /d/<slug>         share page (info, password gate, download)
   └─ cleanup job       deletes expired files
   ▼
/data volume (uploads, bulk)        /config volume (metadata, small)
   ├─ uploads/<id>   the files          └─ db.sqlite   (better-sqlite3 — a file, not a server)
   └─ tmp/<id>       in-progress uploads
```

`/data` (bulk files) and `/config` (the small SQLite database) are **separate
volumes**, so you can keep uploads on array storage and the database on a fast
SSD. `CONFIG_DIR` defaults to `DATA_DIR`, so a single-volume setup still works.

Uploads are **resumable**: a dropped connection on a multi-GB transfer resumes
instead of starting over. Passwords are **scrypt-hashed**, never stored in plain
text, and large downloads **stream natively** (no in-browser buffering).

<br>

## 3. Encryption

Every uploaded file is **encrypted at rest** by default, using
[age](https://age-encryption.org) — a modern, audited, streaming authenticated
encryption format. Each file gets its own key, and the **original filename and
type are encrypted inside the file**, so a stolen disk or backup reveals neither
the contents nor the names.

How the per-file key is protected depends on whether you set a password, and on
whether you've configured a master key:

| Share type | Where the key lives | Link | What the server can decrypt |
|---|---|---|---|
| **Password** | Wrapped with your password (age scrypt) | `…/d/<slug>` | Nothing without the password — not even the operator |
| **Server** (no password, `MASTER_KEY` set) | Wrapped with the server master key | `…/d/<slug>` — **short** | The file (it holds the master key); a stolen *data* backup alone cannot |
| **Link** (no password, no master key) | In the share link's `#fragment` | `…/d/<slug>#k=…` — long | Nothing from the database alone; the key never reaches the server |

**Short links.** By default a password-less share carries its key in the URL
`#fragment`, which makes the link long but means the server can never decrypt it.
If you'd rather have **short links** (`…/d/aB3xK`), set a **`MASTER_KEY`** (see
[Configuration](#6-configuration)): password-less files are then wrapped with it
and stored. The trade-off: the running server *can* decrypt those files — but a
stolen `/data` backup still can't, because the master key lives only in the
container environment, not in the volume. Keep it secret and **back it up** —
losing it makes password-less files unrecoverable. Password shares are
unaffected and stay end-to-end.

Because the key in a link share lives in the URL **fragment**, it is never sent
in an HTTP request and never appears in server logs or your reverse proxy. Treat
the full link as the secret: anyone who has it can download the file until it
expires.

Encryption streams (age's 64 KiB authenticated chunks), so multi-GB files are
never buffered in memory. Set `ENCRYPT_UPLOADS=false` to store new uploads as
plaintext if you ever need to; files keep the mode they were stored with.

<br>

## 4. Languages

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

## 5. Quick Start on Unraid

Pull the template into Unraid via the console / SSH:

```bash
mkdir -p /boot/config/plugins/dockerMan/templates-user && \
curl -fsSL -o /boot/config/plugins/dockerMan/templates-user/my-featherdrop.xml \
  https://raw.githubusercontent.com/junkerderprovinz/featherdrop/main/templates/featherdrop.xml
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
  ghcr.io/junkerderprovinz/featherdrop:latest
```

To keep everything on a single volume instead, drop the `CONFIG_DIR` line and
the `/config` mount and map just `-v …:/data` — the database then lives in
`/data` alongside the uploads.

<br>

## 6. Configuration

| Variable | Default | Description |
|---|---|---|
| `BASE_URL` | *(empty)* | Public URL featherdrop is reached at, so share links use your domain. Empty = use the address the browser is on. |
| `DEFAULT_EXPIRY` | `7d` | Expiry pre-selected in the UI. One of `1h`, `6h`, `1d`, `7d`, `30d`, `never`. |
| `MAX_FILE_SIZE` | `0` | Max upload size in bytes. `0` = unlimited (disk-limited). E.g. `5368709120` = 5 GB. |
| `ENCRYPT_UPLOADS` | `true` | Encrypt new uploads at rest with age (see [Encryption](#3-encryption)). Set `false` to store plaintext. Existing files keep their stored mode. |
| `MASTER_KEY` | *(empty)* | Optional secret that gives **short links** for password-less shares (see [Encryption](#3-encryption)). Generate with `openssl rand -base64 32`. Keep it secret, back it up; losing it makes password-less files unrecoverable. Empty = long `#key` links. |
| `PORT` | `3000` | Port the server listens on. |
| `DATA_DIR` | `/data` | Where the uploaded files live (bulk). Map this to a volume. |
| `CONFIG_DIR` | *(= `DATA_DIR`)* | Where the SQLite database lives. Defaults to `DATA_DIR` (single volume). Set it (the Unraid template uses `/config`) to keep the small database on a separate, faster volume. |
| `APP_NAME` | `featherdrop` | Custom app name — replaces the wordmark in the header and the browser-tab title. |
| `APP_LOGO` | *(empty)* | URL of a custom logo (SVG/PNG) to replace the feather. Public URL, or mount your own and serve it (e.g. `/config/logo.svg`). Empty = the feather. |
| `ACCENT_COLOR` | `#d4af37` | A 6-digit hex colour for buttons, the upload ring and accents. Invalid values fall back to the gold. |

<br>

## 7. Reverse Proxy

featherdrop speaks plain HTTP on `PORT`; put TLS in front of it (Nginx Proxy
Manager, Caddy, Traefik). Two things matter:

- Set **`BASE_URL`** to your public URL so generated links are correct. Use
  **HTTPS** — for link shares the decryption key lives in the URL fragment, and
  TLS keeps the whole link private in transit.
- Allow **large request bodies** and generous timeouts for big uploads. For
  Nginx / NPM advanced config:

```nginx
client_max_body_size 0;        # no body-size cap (uploads are chunked anyway)
proxy_read_timeout 3600s;
proxy_send_timeout 3600s;
proxy_request_buffering off;   # stream uploads straight through
```

<br>

## 8. Local Development

```bash
npm install
npm run dev          # http://localhost:3000, data written to ./data
```

Build a production bundle and run it the way the container does:

```bash
npm run build
npm run start
```

Run the test suite (pure-logic assertions, no framework needed):

```bash
npm test
```

Stack: Next.js (App Router) + Mantine v7, a small custom Node server
(`custom-server.ts`) that mounts the tus handler beside Next, `better-sqlite3`
for metadata, and `react-i18next` for the UI languages. Files live under
`DATA_DIR` (default `./data` in dev).

<br>

## 9. Contributing / License

Issues and pull requests welcome:
<https://github.com/junkerderprovinz/featherdrop/issues>

Licensed under the [MIT License](LICENSE).

<br>

## Support this project

If featherdrop saves you a trip to a third-party file host, consider buying me a coffee:

<p align="center">
  <a href="https://buymeacoffee.com/junkerderprovinz">
    <img src=".github/assets/button-buy-me-a-coffee.svg" alt="Buy me a coffee" width="220">
  </a>
</p>
