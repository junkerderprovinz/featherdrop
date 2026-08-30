// Command server-go is the Go backend skeleton for featherdrop, a
// zero-knowledge file sharer. It will replace the Next.js/Node server with a
// single static binary that serves the existing React/TS client as embedded
// static assets plus a small JSON/file API. The browser zero-knowledge crypto
// and UI stay in TypeScript.
//
// Phased rollout (see the design notes):
//  1. (this phase) skeleton: chi router + embedded static + config + SQLite
//     (modernc) + schema/migrations.
//  2. tusd integration (upload + UPLOAD_PASSWORD/MAX_FILE_SIZE hooks).
//  3. finalize + download(+Range,+?preview) + manage routes.
//  4. SSR HTML shell (OG meta) + /api/d/{slug}/meta + client static-export wiring.
//  5. Dockerfile (multi-stage) + CI (build/test/boot-smoke/e2e).
//  6. security review + E2E.
//
// All phases are implemented: this wires the tus upload endpoint, the JSON/file
// API (finalize/download/manage/meta/config), and the SPA static handler (with
// startup branding/OG templating) over the embedded webroot.
package main

import (
	"database/sql"
	"embed"
	"errors"
	"fmt"
	"io/fs"
	"log"
	"net/http"
	"os"
	"path"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/junkerderprovinz/featherdrop/server-go/internal/api"
	"github.com/junkerderprovinz/featherdrop/server-go/internal/config"
	"github.com/junkerderprovinz/featherdrop/server-go/internal/ratelimit"
	"github.com/junkerderprovinz/featherdrop/server-go/internal/static"
	"github.com/junkerderprovinz/featherdrop/server-go/internal/store"
	"github.com/junkerderprovinz/featherdrop/server-go/internal/upload"
)

//go:embed all:webroot
var webroot embed.FS

// brandArt is the shared "Junker der Provinz" house ASCII banner, embedded from
// banner.txt (a copy of .github/assets/banner-raw.txt), printed at startup.
//
//go:embed banner.txt
var brandArt string

func main() {
	// -healthcheck: probe the running server and exit (the Dockerfile
	// HEALTHCHECK runs the binary against itself — distroless has no shell or
	// curl). Handled before any config side effects so the probe never touches
	// the data dirs or the DB.
	if len(os.Args) > 1 && os.Args[1] == "-healthcheck" {
		os.Exit(healthcheckMain())
	}

	cfg := config.Load()

	// Boot-time validation: log every warning (clamped DEFAULT_EXPIRY, ignored
	// BASE_URL, short UPLOAD_PASSWORD), then refuse to start on a fatally
	// misconfigured guardrail variable — a clear error beats limping along with
	// a guessed value.
	warnings, err := cfg.Validate()
	for _, warning := range warnings {
		log.Printf("config: WARNING: %s", warning)
	}
	if err != nil {
		log.Fatalf("config: %v", err)
	}

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
	// wrapped with the optional upload gate (UPLOAD_PASSWORD) and the
	// storage-quota gate; bytes land in cfg.TmpDir for a later finalize phase to
	// move into cfg.UploadsDir.
	tusHandler, err := upload.NewHandler(cfg, db)
	if err != nil {
		log.Fatalf("build tus handler: %v", err)
	}

	r := newRouter(cfg, db, tusHandler, assets, shell)

	addr := ":" + cfg.Port
	log.Printf("featherdrop: data=%s db=%s", cfg.DataDir, cfg.DBPath)
	printBanner()
	printReady("HTTP", cfg.Port)
	if err := http.ListenAndServe(addr, r); err != nil {
		log.Fatalf("listen: %v", err)
	}
}

// newRouter wires every route exactly as the server serves them. Extracted from
// main so tests can exercise the REAL routing (rate-limit wrapping, catch-all
// precedence, header behaviour) against an httptest server.
func newRouter(cfg config.Config, db *sql.DB, tusHandler http.Handler, assets fs.FS, shell []byte) chi.Router {
	r := chi.NewRouter()
	r.Get("/healthz", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "text/plain; charset=utf-8")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("ok"))
	})

	// Liveness probe for the Docker HEALTHCHECK (via -healthcheck) + monitors.
	// Registered OUTSIDE the rate-limit wrapping below and before the /api/*
	// catch-all: no auth, no limit, always {"ok":true}.
	r.Get("/api/healthcheck", api.HealthcheckHandler())

	// The whole instance is private by nature (every page either uploads or
	// serves a secret link), so robots are told to keep out entirely.
	r.Get("/robots.txt", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "text/plain; charset=utf-8")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("User-agent: *\nDisallow: /\n"))
	})

	// JSON/file API handlers.
	//   POST   /api/finalize    publish a completed tus upload -> {slug}
	//   GET    /api/d/{slug}     download the ciphertext (Range/?preview, burn)
	files := tusHandler
	finalize := api.FinalizeHandler(cfg, db, nil)
	download := api.DownloadHandler(cfg, db, nil)
	meta := api.MetaHandler(db, nil)

	// RATE_LIMIT (default on): per-client-IP token buckets over the abusable
	// endpoints. Upload creations 30/min (burst 10) — only the tus create POST;
	// PATCH/HEAD resumes stay unthrottled. Finalize 60/min (burst 10). The
	// download-meta + key-verifier surface shares ONE 20/min (burst 10) bucket,
	// so a slug/verifier guesser cannot double its budget by alternating
	// endpoints. /api/config, /healthz and /api/healthcheck stay unlimited.
	if cfg.RateLimit {
		createLimiter := ratelimit.NewLimiter(30, 10, nil)
		finalizeLimiter := ratelimit.NewLimiter(60, 10, nil)
		downloadLimiter := ratelimit.NewLimiter(20, 10, nil)
		files = ratelimit.Middleware(createLimiter, cfg.TrustProxy, http.MethodPost, files)
		finalize = ratelimit.Middleware(finalizeLimiter, cfg.TrustProxy, "", finalize)
		download = ratelimit.Middleware(downloadLimiter, cfg.TrustProxy, "", download)
		meta = ratelimit.Middleware(downloadLimiter, cfg.TrustProxy, "", meta)
	}

	// Mount the tus handler so both "/files" (create/OPTIONS) and "/files/*"
	// (PATCH/HEAD/DELETE on a specific upload) reach it. chi preserves the full
	// request path for the sub-handler, which tusd matches against its BasePath
	// "/files/".
	r.Handle("/files", files)
	r.Handle("/files/*", files)

	// JSON/file API. Registered BEFORE the SPA catch-all so these exact routes
	// win over the static fallback.
	r.Post("/api/finalize", finalize)
	r.Get("/api/d/{slug}", download)
	r.Get("/api/d/{slug}/meta", meta)

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

	return r
}

// healthcheckMain implements the -healthcheck self-flag: GET the running
// server's /api/healthcheck on the configured PORT and exit 0 (healthy) or 1.
// The Dockerfile HEALTHCHECK invokes the binary this way because the distroless
// runtime ships no shell, wget or curl.
func healthcheckMain() int {
	port := os.Getenv("PORT")
	if port == "" {
		port = "3000"
	}
	client := &http.Client{Timeout: 5 * time.Second}
	resp, err := client.Get("http://127.0.0.1:" + port + "/api/healthcheck")
	if err != nil {
		fmt.Fprintf(os.Stderr, "healthcheck: %v\n", err)
		return 1
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		fmt.Fprintf(os.Stderr, "healthcheck: status %d, want 200\n", resp.StatusCode)
		return 1
	}
	return 0
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
		// Share pages must never land in a search index: a crawled /d/<slug>
		// link would expose the share to anyone searching. The meta/download
		// APIs set the same header (see internal/api/respond.go setNoIndex).
		if strings.HasPrefix(r.URL.Path, "/d/") {
			w.Header().Set("X-Robots-Tag", "noindex, nofollow")
		}
		upath := strings.TrimPrefix(path.Clean("/"+r.URL.Path), "/")
		if upath == "" || upath == "index.html" {
			// Root or an explicit index.html request: serve the templated shell.
			serveShell(w, shell)
			return
		}
		info, err := fs.Stat(assets, upath)
		if errors.Is(err, fs.ErrNotExist) || (err == nil && info.IsDir()) {
			// Unknown path, OR a directory request (e.g. "/assets/"): serve the SPA
			// shell rather than fall through to http.FileServer. The latter renders
			// an auto-generated directory LISTING for an existing dir, needlessly
			// exposing every embedded asset filename — so directories get the shell
			// (client routing) and never a listing.
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

// ---------------------------------------------------------------------------
// startup banners — the shared "Junker der Provinz" house format, matching the
// other own-image containers. Printed via fmt to STDOUT so Docker/Unraid never
// interleaves the stderr log line into the ASCII art.
// ---------------------------------------------------------------------------

const (
	bannerName     = "featherdrop"
	bannerSubtitle = "Self-hosted, end-to-end-encrypted file sharing. Drop a file, share a link."
)

// printBanner prints the brand ASCII art, then a clean name + subtitle line
// (mirrors the house print-banner.sh used by all own-image images: name and
// subtitle joined onto ONE line, house look, no rules).
func printBanner() {
	fmt.Println()
	fmt.Println(strings.TrimRight(brandArt, "\n"))
	fmt.Println()
	fmt.Println("  " + bannerName + " · " + bannerSubtitle)
	fmt.Println()
}

// printReady prints the loud "<APP> IS READY" line just before the server
// listens, in the shared house one-line format (matches
// jdownloader/krusader/matrix/handbrake/bombvault). The banner + this line
// are always the LAST thing this process prints before it blocks on
// ListenAndServe.
func printReady(scheme, port string) {
	fmt.Printf("  \033[0;32m✓ FEATHERDROP IS READY\033[0m - Open the WebUI now (%s %s)\n", scheme, port)
	fmt.Println()
}
