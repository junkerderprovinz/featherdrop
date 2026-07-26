# CLAUDE.md — featherdrop

Repo guide for AI agents and contributors. Keep this tight and accurate to THIS repo.

## What it is

featherdrop is a self-hosted, login-free, zero-knowledge file sharer (a private
WeTransfer). A **Go backend** (`server-go/`) serves a **Vite + React + Mantine SPA**
as embedded static assets alongside the JSON/file API. All zero-knowledge crypto
lives in the **browser (TypeScript)** — the server never sees plaintext or keys.
Published as a single multi-arch container (amd64 + arm64) to GHCR and Docker Hub.

## Layout

- `src/`, `components/`, `lib/`, `app/`, `theme.ts`, `index.html` — the React/TS SPA
  (client crypto, UI, i18n). `public/` holds static SPA assets.
- `server-go/` — the Go backend. Module `github.com/junkerderprovinz/featherdrop/server-go`,
  Go 1.26. `main.go` + `main_test.go`. Serves the SPA via `//go:embed all:webroot`
  plus the tus upload / download / config API (chi router, tusd, modernc sqlite).
- `server-go/webroot/` — build output (a committed placeholder is overlaid at image
  build time by the real Vite build). `linguist-generated`, do not hand-edit.
- `scripts/build-client.mjs` — copies the Vite `client-dist/` output into
  `server-go/webroot/` (templated `index.html`, hashed assets, `sw-download.js`).
- `test/` — TypeScript logic tests (`*.test.ts`, run via node's test runner + tsx)
  and browser/e2e drivers under `test/browser/` and `test/e2e/`.
- `Dockerfile` — 3-stage: node builds the SPA → Go builds the static binary
  embedding the webroot → `gcr.io/distroless/static-debian12` runtime.
- `.github/workflows/` — `build.yml` (publish), `go.yml` (Go backend CI),
  `lint.yml` (ESLint + tsc + unit tests), `release.yml` (GitHub Release on tag).
- `.github/release-notes/<tag>.md` — full changelog used as the release body.
- Version lives in `package.json` (`"version"`). Currently 3-digit SemVer.

## Build / test / lint commands (real — read from package.json / workflows)

Frontend (repo root):
- `npm install` — deps. `postinstall` copies a libsodium ESM wrapper the browser
  bundle needs (upstream packaging bug workaround); do not skip it for a real build.
- `npm run dev` — Vite dev server (http://localhost:5173).
- `npm run build:client` — `vite build` → `client-dist/`.
- `npm run build:webroot` — `node scripts/build-client.mjs` → `server-go/webroot/`.
- `npm run build:spa` — `build:client` + `build:webroot` (what the image does).
- `npm run lint` — `eslint src components lib app --max-warnings 0` (flat config in
  `eslint.config.js`; ESLint 10 dropped `.eslintrc` + `--ext`).
- `npx tsc --noEmit` — TypeScript typecheck (the **TS 7 native** compiler).

  TypeScript is installed side-by-side (per the official TS 7 migration): the
  `typescript` dependency is aliased to `@typescript/typescript6` (the TS 6 JS API
  that `typescript-eslint` still needs — TS 7 dropped the classic compiler API from
  its main entry), while `@typescript/native` is the real `typescript@7` and owns
  the `tsc` binary. So `npx tsc` runs TS 7; ESLint parses via TS 6. `tsc6` is the
  TS 6 binary if ever needed.
- `npm test` — logic tests: `node --import tsx --test "test/**/*.test.ts"`.
- `npm run test:browser` — Playwright browser round-trips.

Backend (`server-go/`):
- `gofmt -l .` — must be empty (CI fails on any unformatted file).
- `go vet ./...`, `go test ./... -count=1`.
- `govulncheck ./...` — CI gate; fails on a known CVE in a dep or the stdlib.
- `go run .` — serve on http://localhost:3000, data under `./data`.

Image:
- `docker build -t featherdrop:local .` — full multi-stage build.
- `just` recipes wrap all of the above; run `just --list`.

## Runtime / config

Distroless runtime — **no shell**. The healthcheck is the binary probing itself
(`/featherdrop -healthcheck` → GET `/api/healthcheck`). Env: `DATA_DIR` (bulk blobs
+ in-progress tus uploads, default `/data`), `CONFIG_DIR` (SQLite metadata DB,
default `/config`), `PORT` (default 3000). Volumes `/data` and `/config`.

## CI gates

- `lint.yml` — ESLint (`--max-warnings 0`), `tsc --noEmit`, unit tests. On push + PR.
- `go.yml` — gofmt clean, `go vet`, `go test`, `govulncheck`, native boot smoke,
  amd64 Docker boot smoke (`featherdrop-go:smoke`), and a real-Chromium e2e crypto
  round-trip against the Go server. On push + PR. Never pushes to a registry.
- `build.yml` — on push to `main` (+ manual). Builds amd64 **and** arm64 images
  locally (`featherdrop:smoke-amd64`, `featherdrop:smoke-arm64`), boots **both**
  arches and requires them to serve `/` before anything is pushed, then multi-arch
  `build-push` to GHCR (`ghcr.io/junkerderprovinz/featherdrop`) with SBOM +
  provenance attestations, plus the Docker Hub mirror. A non-blocking **Trivy**
  CVE scan (HIGH/CRITICAL, unfixed ignored) uploads SARIF to the Security tab;
  it reports only and never fails the build.
- `release.yml` — on a `vX.Y.Z` tag: creates a GitHub Release from
  `.github/release-notes/<tag>.md` (or auto-generated if absent).

Always check that Build + Lint + Go are green after a push; fix red. Run
`gofmt`/ESLint/`tsc` locally before pushing.

## Release procedure

- 3-digit SemVer. Bump `package.json` `version`. Add `.github/release-notes/vX.Y.Z.md`
  (the full changelog is the release body — no link lists).
- Tag `vX.Y.Z`; the GitHub Release title is the version only (no repo-name heading).
- **Never tag or cut a release without explicit approval.** Do not re-tag a
  published version. Pushing `main` re-runs `build.yml` and relabels `:latest`.

## Repo-specific gotchas

- Zero-knowledge means server never has keys — keep all crypto in the browser TS.
- 26 UI languages via `react-i18next`. New keys go into **all** locale files in
  the same change (parity is enforced by `test/locales.test.ts`).
- `server-go/webroot/` is generated; the committed copy is a placeholder that the
  image build overwrites with the real Vite output.
- distroless has no shell — never assume `sh`/`curl`/`wget` in the runtime image;
  the self-probe healthcheck is the pattern for liveness.
- The old Next.js server has been retired (as of v6.0.0); the Go backend is the
  only server. Ignore any lingering Next references.

## Conventions

German for chat/vault, English for the repo. No AI attribution in commits or code.
Keep the README current with any user-facing change.
