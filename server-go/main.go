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

	"github.com/junkerderprovinz/featherdrop/server-go/internal/config"
	"github.com/junkerderprovinz/featherdrop/server-go/internal/store"
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

	r := chi.NewRouter()
	r.Get("/healthz", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "text/plain; charset=utf-8")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("ok"))
	})

	// Catch-all static handler with SPA fallback to index.html.
	r.NotFound(spaHandler(assets))
	r.MethodNotAllowed(spaHandler(assets))

	addr := ":" + cfg.Port
	log.Printf("featherdrop go server listening on %s (data=%s db=%s)", addr, cfg.DataDir, cfg.DBPath)
	if err := http.ListenAndServe(addr, r); err != nil {
		log.Fatalf("listen: %v", err)
	}
}

// spaHandler serves files from assets, falling back to index.html for paths
// that don't resolve to a file (so client-side routes load the SPA shell).
func spaHandler(assets fs.FS) http.HandlerFunc {
	fileServer := http.FileServer(http.FS(assets))
	return func(w http.ResponseWriter, r *http.Request) {
		upath := strings.TrimPrefix(path.Clean("/"+r.URL.Path), "/")
		if upath == "" {
			upath = "index.html"
		}
		if _, err := fs.Stat(assets, upath); errors.Is(err, fs.ErrNotExist) {
			// Unknown path: serve the SPA shell so client routing can take over.
			serveIndex(w, r, assets)
			return
		}
		fileServer.ServeHTTP(w, r)
	}
}

// serveIndex writes the embedded index.html as the SPA fallback response.
func serveIndex(w http.ResponseWriter, _ *http.Request, assets fs.FS) {
	data, err := fs.ReadFile(assets, "index.html")
	if err != nil {
		http.Error(w, "not found", http.StatusNotFound)
		return
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(data)
}
