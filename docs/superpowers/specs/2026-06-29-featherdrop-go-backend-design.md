# featherdrop Go backend (split architecture) — design

**Goal:** replace the Next.js/Node server with a **single static Go binary** that
serves the existing React/TS client as static assets + a small JSON/file API.
The browser **zero-knowledge crypto + UI stay in TypeScript** (they must — they
run in the browser); only the SERVER moves to Go. Benefits: tiny scratch/alpine
image, low RAM, first-class streaming + HTTP Range, **no `better-sqlite3` native
addon pain**, reproducible builds, tusd (the reference tus server is Go).

## Architecture
- **Client:** the current `app/`/`components/`/`lib/` React app, built to **static
  assets** (Next `output: "export"`, or a Vite SPA build). All ZK crypto, OPFS,
  service worker, tus-js-client, Mantine, i18n stay as-is. No server runtime.
- **Server (Go):** `net/http` + a light router (chi). One binary that:
  - serves the static client (embedded via `embed.FS` or from a dir),
  - exposes the API (below),
  - runs the tus upload endpoint via **tusd** (`github.com/tus/tusd` as a library,
    filestore → `DATA_DIR`),
  - owns SQLite via **modernc.org/sqlite** (pure Go, CGO-free → static build, no
    addon), same schema/file as today (drop-in on the existing `/config` DB),
  - runs the cleanup goroutine (expiry sweep + abandoned-tus-tmp sweep).

## API contract (match today's, so the client barely changes)
- `POST /files…` (tus) — resumable upload to `DATA_DIR`. Pre-create/`PreUploadCreateCallback`
  enforces `UPLOAD_PASSWORD` (constant-time) + `MAX_FILE_SIZE`.
- `POST /api/finalize` — body = the existing FinalizeRequest (slug or server mints
  it, format, key_verifier, manage hash, expiry, maxDownloads, wrapped key/salt…);
  enforces `UPLOAD_PASSWORD`; writes the row; returns `{slug, manageToken}`.
- `GET /api/d/{slug}` — serves the opaque blob; **HTTP Range natively**; key-verifier
  header gate; `registerDownload` (atomic, burn/limit); `?preview=1` no-count path
  (unlimited-only) for the seekable streaming preview. nosniff + octet-stream.
- `GET|DELETE /api/m/{slug}` — manage/delete via `x-fd-manage-token` (hash compare);
  uniform 404; deletes blob + row.
- `GET /api/config` (or a templated bootstrap) — branding (APP_NAME/APP_LOGO/
  ACCENT_COLOR), BASE_URL, uploadProtected, defaults — booleans/strings only, no
  secrets.
- `GET /api/d/{slug}/meta` — small JSON (format, size, hasPassword, downloadsLeft,
  expiry, mime, name?) the SPA needs to render the download page (replaces the
  current SSR prop-passing).

## SSR replacement (the main thing Next gave us)
Today `/d/[slug]` + `/m/[slug]` SSR-read the DB to pass props + emit per-share OG
meta. In the split:
- **Go templates a tiny HTML shell** for `/d/{slug}` + `/m/{slug}`: it injects the
  per-share **Open Graph/Twitter meta** (generic, never the filename — same as
  today) + the SPA bundle. The SPA then fetches `/api/d/{slug}/meta` and renders.
- **i18n:** today SSR renders translated (Accept-Language). In the SPA, detect
  language client-side (cookie → navigator) and render; the Go shell can set
  `<html lang>` from Accept-Language for first paint. Acceptable: a brief
  client-side hydration of strings (the app is already almost entirely client).

## Data / migration (drop-in)
- SQLite **schema + file unchanged** (modernc reads the same DB). Re-implement the
  additive migrations in Go (format 1/2/3[/4], key_verifier, manage_token_hash,
  max_downloads, enc fields). An existing install's `/config/db.sqlite` + `/data`
  blobs work as-is → **the Go image is a drop-in replacement on the same volumes.**
- Blob format unchanged (client crypto) → all existing shares keep working,
  including the new seekable cf=2 content (the server just serves bytes + Range).

## Docker / CI
- Multi-stage: (1) node builds the static client; (2) `go build` static binary;
  (3) final `scratch`/`alpine` with the binary + embedded assets. Tiny image,
  no Node runtime.
- CI: build client + `go vet`/`go test` + the binary; adapt the boot-smoke
  (curl `/`) + e2e (the e2e drives the browser against the running Go server —
  the upload/download/preview flow is unchanged from the client's view).

## Risks / decisions
- **Big migration on a mature app** → do it incrementally behind a matching API
  contract; keep the TS server until the Go server passes the same e2e, then
  switch the image. Regression risk is the main cost.
- **SSR loss** (OG meta + no-JS render) → handled by the Go HTML shell; the no-JS
  download fallback is minor (the app needs JS for crypto anyway).
- **Two languages** (Go server + TS client) — accepted; the client is unavoidably TS.
- The seekable format (other spec) is **independent** (client crypto) and lands
  first; the Go server just serves its byte ranges.

## Rollout (phased, subagents + reviews)
1. Go skeleton: router + embed static + config + SQLite (modernc) + schema/migrations.
2. tusd integration (upload + UPLOAD_PASSWORD/MAX_FILE_SIZE hooks).
3. finalize + download(+Range,+?preview) + manage routes (mirror tests).
4. SSR-shell (OG meta) + `/api/d/{slug}/meta` + client static-export wiring.
5. Dockerfile (multi-stage) + CI (build/test/boot-smoke/e2e) + drop-in verify on
   a copy of an existing DB/volume.
6. Security review (auth gates, constant-time, no secret leak, path safety) + E2E.
Bundled into the next major after the seekable format. The TS app stays shippable
until the Go server is proven green.
