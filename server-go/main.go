// Command server-go is the Go backend skeleton for featherdrop, a
// zero-knowledge file sharer. It will replace the Next.js/Node server with a
// single static binary that serves the existing React/TS client as embedded
// static assets plus a small JSON/file API. The browser zero-knowledge crypto
// and UI stay in TypeScript.
//
// Phased rollout (see docs/superpowers/specs/2026-06-29-featherdrop-go-backend-design.md):
//  1. (this phase) skeleton: chi router + embedded static + config + SQLite
//     (modernc) + schema/migrations.
//  2. tusd integration (upload + UPLOAD_PASSWORD/MAX_FILE_SIZE hooks).
//  3. finalize + download(+Range,+?preview) + manage routes.
//  4. SSR HTML shell (OG meta) + /api/d/{slug}/meta + client static-export wiring.
//  5. Dockerfile (multi-stage) + CI (build/test/boot-smoke/e2e).
//  6. security review + E2E.
//
// This file intentionally implements only the skeleton: a health check and a
// SPA-fallback static handler over the embedded webroot.
package main

import (
	"embed"
	"errors"
	"io/fs"
	"log"
	"net/http"
	"path"
	"strings"

	"github.com/go-chi/chi/v5"

	"github.com/junkerderprovinz/featherdrop/server-go/internal/api"
	"github.com/junkerderprovinz/featherdrop/server-go/internal/config"
	"github.com/junkerderprovinz/featherdrop/server-go/internal/static"
	"github.com/junkerderprovinz/featherdrop/server-go/internal/store"
	"github.com/junkerderprovinz/featherdrop/server-go/internal/upload"
)

//go:embed all:webroot
var webroot embed.FS

func main() {
	cfg := config.Load()

	if err := cfg.EnsureDataDirs(); err != nil {
		log.Fatalf("ensure data dirs: %v", err)
	}

	db, err := store.Open(cfg.DBPath)
	if err != nil {
		log.Fatalf("open store: %v", err)
	}
	defer db.Close()

	// webroot is embedded with the "webroot/" prefix; serve from its subtree.
	assets, err := fs.Sub(webroot, "webroot")
	if err != nil {
		log.Fatalf("sub fs: %v", err)
	}

	// Render the SPA HTML shell ONCE at startup: read the embedded placeholder
	// index.html and replace its %%TOKEN%% markers with this instance's resolved
	// branding + the fixed, generic OG metadata. This templated HTML is served
	// for "/" and every SPA-fallback route; other static assets are served
	// verbatim from the embed.
	shell, err := renderShell(assets, cfg)
	if err != nil {
		log.Fatalf("render shell: %v", err)
	}

	// Resumable upload endpoint (tus protocol). The returned handler is already
	// wrapped with the optional upload gate (UPLOAD_PASSWORD); bytes land in
	// cfg.TmpDir for a later finalize phase to move into cfg.UploadsDir.
	tusHandler, err := upload.NewHandler(cfg)
	if err != nil {
		log.Fatalf("build tus handler: %v", err)
	}

	r := chi.NewRouter()
	r.Get("/healthz", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "text/plain; charset=utf-8")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("ok"))
	})

	// Mount the tus handler so both "/files" (create/OPTIONS) and "/files/*"
	// (PATCH/HEAD/DELETE on a specific upload) reach it. chi preserves the full
	// request path for the sub-handler, which tusd matches against its BasePath
	// "/files/".
	r.Handle("/files", tusHandler)
	r.Handle("/files/*", tusHandler)

	// JSON/file API. Registered BEFORE the SPA catch-all so these exact routes
	// win over the static fallback.
	//   POST   /api/finalize   publish a completed tus upload -> {slug, manageToken}
	//   GET    /api/d/{slug}    download the ciphertext (Range/?preview, burn)
	//   GET    /api/m/{slug}    share status for the uploader
	//   DELETE /api/m/{slug}    revoke the share early
	r.Post("/api/finalize", api.FinalizeHandler(cfg, db, nil))
	r.Get("/api/d/{slug}", api.DownloadHandler(cfg, db, nil))
	r.Get("/api/d/{slug}/meta", api.MetaHandler(db, nil))
	manage := api.ManageHandler(cfg, db, nil)
	r.Get("/api/m/{slug}", manage)
	r.Delete("/api/m/{slug}", manage)

	// Client-visible runtime configuration for the static SPA (non-secret only).
	r.Get("/api/config", api.ConfigHandler(cfg))

	// Catch-all for any unmatched /api path: a JSON 404 (all real API routes are
	// registered above and win). Without this, GET /api/foo would fall through to
	// the SPA fallback and return the HTML shell with 200; under /api a client or
	// crawler should get an application/json 404 instead.
	r.HandleFunc("/api/*", api.NotFoundHandler())

	// Catch-all static handler with SPA fallback to the templated HTML shell.
	r.NotFound(spaHandler(assets, shell))
	r.MethodNotAllowed(spaHandler(assets, shell))

	addr := ":" + cfg.Port
	log.Printf("featherdrop go server listening on %s (data=%s db=%s)", addr, cfg.DataDir, cfg.DBPath)
	if err := http.ListenAndServe(addr, r); err != nil {
		log.Fatalf("listen: %v", err)
	}
}

// renderShell reads the embedded webroot/index.html placeholder and substitutes
// its %%TOKEN%% markers with this instance's resolved branding and the fixed,
// generic Open-Graph metadata, returning the templated HTML served for "/" and
// the SPA fallback. Run once at startup.
func renderShell(assets fs.FS, cfg config.Config) ([]byte, error) {
	raw, err := fs.ReadFile(assets, "index.html")
	if err != nil {
		return nil, err
	}
	html := static.RenderShell(string(raw), static.ShellTokens{
		AppName:     cfg.Branding().AppName,
		Description: static.Description,
		OGImage:     static.DefaultOGImage,
		Lang:        static.DefaultLang,
		BaseURL:     cfg.BaseURL,
	})
	return []byte(html), nil
}

// spaHandler serves files from assets, falling back to the templated HTML shell
// for "/" and for paths that don't resolve to a file (so client-side routes load
// the SPA shell). The raw embedded index.html is never served directly — only its
// startup-templated form (shell) goes out, so the branding/OG markers are always
// substituted.
func spaHandler(assets fs.FS, shell []byte) http.HandlerFunc {
	fileServer := http.FileServer(http.FS(assets))
	return func(w http.ResponseWriter, r *http.Request) {
		upath := strings.TrimPrefix(path.Clean("/"+r.URL.Path), "/")
		if upath == "" || upath == "index.html" {
			// Root or an explicit index.html request: serve the templated shell.
			serveShell(w, shell)
			return
		}
		if _, err := fs.Stat(assets, upath); errors.Is(err, fs.ErrNotExist) {
			// Unknown path: serve the SPA shell so client routing can take over.
			serveShell(w, shell)
			return
		}
		fileServer.ServeHTTP(w, r)
	}
}

// serveShell writes the pre-templated HTML shell as the SPA response.
func serveShell(w http.ResponseWriter, shell []byte) {
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(shell)
}
