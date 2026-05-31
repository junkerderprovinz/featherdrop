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

<p align="center">
A clean, login-free, self-hosted file sharer. Open the page, drop a file,
set an expiry, share the link — no account, no heavyweight stack.
</p>

<br>

## Table of Contents

1. [What is this?](#1-what-is-this)
2. [How it works](#2-how-it-works)
3. [Quick Start on Unraid](#3-quick-start-on-unraid)
4. [Configuration](#4-configuration)
5. [Reverse Proxy](#5-reverse-proxy)
6. [Local Development](#6-local-development)
7. [Contributing / License](#7-contributing--license)

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
/data volume
   ├─ uploads/<id>      the files
   └─ db.sqlite         metadata (better-sqlite3 — a file, not a server)
```

Uploads are **resumable**: a dropped connection on a multi-GB transfer resumes
instead of starting over. Passwords are **scrypt-hashed**, never stored in plain
text, and large downloads **stream natively** (no in-browser buffering).

<br>

## 3. Quick Start on Unraid

Pull the template into Unraid via the console / SSH:

```bash
mkdir -p /boot/config/plugins/dockerMan/templates-user && \
curl -fsSL -o /boot/config/plugins/dockerMan/templates-user/my-featherdrop.xml \
  https://raw.githubusercontent.com/junkerderprovinz/featherdrop/main/templates/featherdrop.xml
```

Then **Docker → Add Container → featherdrop** under *User templates*. Map the
**Data Directory** to your appdata, pick a port, hit **Apply**, open the WebUI.

### Plain Docker (no Unraid)

```bash
docker run -d \
  --name featherdrop \
  --restart unless-stopped \
  -p 3000:3000 \
  -e BASE_URL=https://share.yourdomain.tld \
  -v /mnt/user/appdata/featherdrop:/data \
  ghcr.io/junkerderprovinz/featherdrop:latest
```

<br>

## 4. Configuration

| Variable | Default | Description |
|---|---|---|
| `BASE_URL` | *(empty)* | Public URL featherdrop is reached at, so share links use your domain. Empty = use the address the browser is on. |
| `DEFAULT_EXPIRY` | `7d` | Expiry pre-selected in the UI. One of `1h`, `6h`, `1d`, `7d`, `30d`, `never`. |
| `MAX_FILE_SIZE` | `0` | Max upload size in bytes. `0` = unlimited (disk-limited). E.g. `5368709120` = 5 GB. |
| `PORT` | `3000` | Port the server listens on. |
| `DATA_DIR` | `/data` | Where files + the SQLite database live. Map this to a volume. |

<br>

## 5. Reverse Proxy

featherdrop speaks plain HTTP on `PORT`; put TLS in front of it (Nginx Proxy
Manager, Caddy, Traefik). Two things matter:

- Set **`BASE_URL`** to your public URL so generated links are correct.
- Allow **large request bodies** and generous timeouts for big uploads. For
  Nginx / NPM advanced config:

```nginx
client_max_body_size 0;        # no body-size cap (uploads are chunked anyway)
proxy_read_timeout 3600s;
proxy_send_timeout 3600s;
proxy_request_buffering off;   # stream uploads straight through
```

<br>

## 6. Local Development

```bash
npm install
npm run dev          # http://localhost:3000, data written to ./data
```

Build a production bundle and run it the way the container does:

```bash
npm run build
npm run start
```

Stack: Next.js (App Router) + Mantine v7, a small custom Node server
(`custom-server.ts`) that mounts the tus handler beside Next, `better-sqlite3`
for metadata. Files live under `DATA_DIR` (default `./data` in dev).

<br>

## 7. Contributing / License

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
