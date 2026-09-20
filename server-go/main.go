// Command server-go is the featherdrop server, a zero-knowledge file sharer. It
// serves the React client as embedded static assets plus the tus upload endpoint
// and a small JSON/file API; all encryption happens in the browser.
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

// brandArt is the house ASCII banner printed at startup, a copy of
// .github/assets/banner-raw.txt.
//
//go:embed banner.txt
var brandArt string

func main() {
	// The Dockerfile HEALTHCHECK runs the binary against itself because
	// distroless has no shell or curl. It is handled before any config side
	// effects so the probe never touches the data dirs or the database.
	if len(os.Args) > 1 && os.Args[1] == "-healthcheck" {
		os.Exit(healthcheckMain())
	}

	cfg := config.Load()

	// A misconfigured guardrail variable stops the boot: a clear error beats
	// running with a guessed value.
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

	assets, err := fs.Sub(webroot, "webroot")
	if err != nil {
		log.Fatalf("sub fs: %v", err)
	}

	shell, err := renderShell(assets, cfg)
	if err != nil {
		log.Fatalf("render shell: %v", err)
	}

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

// newRouter wires every route the server serves. It is separate from main so
// tests can run the real routing, rate limits included.
func newRouter(cfg config.Config, db *sql.DB, tusHandler http.Handler, assets fs.FS, shell []byte) chi.Router {
	r := chi.NewRouter()
	r.Get("/healthz", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "text/plain; charset=utf-8")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("ok"))
	})

	// The liveness probe stays outside the rate limits below.
	r.Get("/api/healthcheck", api.HealthcheckHandler())

	// Every page either uploads or serves a secret link, so robots stay out.
	r.Get("/robots.txt", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "text/plain; charset=utf-8")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("User-agent: *\nDisallow: /\n"))
	})

	files := tusHandler
	finalize := api.FinalizeHandler(cfg, db, nil)
	download := api.DownloadHandler(cfg, db, nil)
	meta := api.MetaHandler(db, nil)

	// Only the tus create POST is limited; PATCH and HEAD resumes stay free.
	// Download and meta share one bucket so a slug or verifier guesser cannot
	// double its budget by alternating endpoints.
	if cfg.RateLimit {
		createLimiter := ratelimit.NewLimiter(30, 10, nil)
		finalizeLimiter := ratelimit.NewLimiter(60, 10, nil)
		downloadLimiter := ratelimit.NewLimiter(20, 10, nil)
		files = ratelimit.Middleware(createLimiter, cfg.TrustProxy, http.MethodPost, files)
		finalize = ratelimit.Middleware(finalizeLimiter, cfg.TrustProxy, "", finalize)
		download = ratelimit.Middleware(downloadLimiter, cfg.TrustProxy, "", download)
		meta = ratelimit.Middleware(downloadLimiter, cfg.TrustProxy, "", meta)
	}

	// chi keeps the full request path, which tusd matches against its
	// BasePath "/files/".
	r.Handle("/files", files)
	r.Handle("/files/*", files)

	r.Post("/api/finalize", finalize)
	r.Get("/api/d/{slug}", download)
	r.Get("/api/d/{slug}/meta", meta)
	r.Get("/api/config", api.ConfigHandler(cfg))

	// Without this, an unknown /api path would fall through to the SPA and
	// answer 200 with the HTML shell.
	r.HandleFunc("/api/*", api.NotFoundHandler())

	r.NotFound(spaHandler(assets, shell))
	r.MethodNotAllowed(spaHandler(assets, shell))

	return r
}

// healthcheckMain probes /api/healthcheck on the configured PORT and returns
// the process exit code.
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

// renderShell fills the %%TOKEN%% markers of the embedded index.html with this
// instance's branding and the generic Open Graph metadata.
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

// spaHandler serves files from assets and falls back to the templated shell for
// "/" and for any path that is not a file, so client-side routes load. The raw
// index.html with its markers is never served.
func spaHandler(assets fs.FS, shell []byte) http.HandlerFunc {
	fileServer := http.FileServer(http.FS(assets))
	return func(w http.ResponseWriter, r *http.Request) {
		// A crawled share link would expose the share to anyone searching.
		if strings.HasPrefix(r.URL.Path, "/d/") {
			w.Header().Set("X-Robots-Tag", "noindex, nofollow")
		}
		upath := strings.TrimPrefix(path.Clean("/"+r.URL.Path), "/")
		if upath == "" || upath == "index.html" {
			serveShell(w, shell)
			return
		}
		info, err := fs.Stat(assets, upath)
		// http.FileServer would render a listing for a directory and expose
		// every embedded file name.
		if errors.Is(err, fs.ErrNotExist) || (err == nil && info.IsDir()) {
			serveShell(w, shell)
			return
		}
		fileServer.ServeHTTP(w, r)
	}
}

func serveShell(w http.ResponseWriter, shell []byte) {
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(shell)
}

const (
	bannerName     = "featherdrop"
	bannerSubtitle = "Self-hosted, end-to-end-encrypted file sharing. Drop a file, share a link."
)

// printBanner prints the house ASCII art and the name line to stdout, so Docker
// does not interleave the stderr log into the art.
func printBanner() {
	fmt.Println()
	fmt.Println(strings.TrimRight(brandArt, "\n"))
	fmt.Println()
	fmt.Println("  " + bannerName + " · " + bannerSubtitle)
	fmt.Println()
}

// printReady prints the house ready line, the last output before the server
// blocks in ListenAndServe.
func printReady(scheme, port string) {
	fmt.Printf("  \033[0;32m✓ FEATHERDROP IS READY\033[0m - Open the WebUI now (%s %s)\n", scheme, port)
	fmt.Println()
}
