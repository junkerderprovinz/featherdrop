package main

import (
	"encoding/json"
	"io/fs"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"

	"github.com/junkerderprovinz/featherdrop/server-go/internal/config"
	"github.com/junkerderprovinz/featherdrop/server-go/internal/store"
	"github.com/junkerderprovinz/featherdrop/server-go/internal/upload"
)

// webrootSub returns the embedded webroot subtree the server serves from.
func webrootSub(t *testing.T) fs.FS {
	t.Helper()
	sub, err := fs.Sub(webroot, "webroot")
	if err != nil {
		t.Fatalf("sub fs: %v", err)
	}
	return sub
}

func TestRenderShell_DefaultBranding(t *testing.T) {
	assets := webrootSub(t)
	shell, err := renderShell(assets, config.Config{}) // empty branding -> defaults
	if err != nil {
		t.Fatalf("renderShell: %v", err)
	}
	html := string(shell)

	if strings.Contains(html, "%%") {
		t.Fatalf("served shell still contains a leftover token:\n%s", html)
	}
	if !strings.Contains(html, "<title>featherdrop</title>") {
		t.Fatalf("default appName not in <title>:\n%s", html)
	}
	if !strings.Contains(html, `<div id="root"></div>`) {
		t.Fatalf("SPA mount <div id=\"root\"> missing:\n%s", html)
	}
	if !strings.Contains(html, `<html lang="en">`) {
		t.Fatalf("default lang missing:\n%s", html)
	}
	if !strings.Contains(html, `name="viewport"`) {
		t.Fatalf("viewport meta missing:\n%s", html)
	}
}

func TestRenderShell_CustomAppName(t *testing.T) {
	assets := webrootSub(t)
	shell, err := renderShell(assets, config.Config{AppName: "Acme Files"})
	if err != nil {
		t.Fatalf("renderShell: %v", err)
	}
	html := string(shell)
	if !strings.Contains(html, "<title>Acme Files</title>") {
		t.Fatalf("custom appName not reflected in <title>:\n%s", html)
	}
	if strings.Contains(html, "%%") {
		t.Fatalf("leftover token with custom branding:\n%s", html)
	}
}

// newFullRouter builds the COMPLETE production router (newRouter) over a temp
// data dir + real SQLite store, so tests exercise the same wiring main serves:
// route precedence, rate-limit wrapping, and header behaviour.
func newFullRouter(t *testing.T, mutate func(*config.Config)) http.Handler {
	t.Helper()
	dataDir := t.TempDir()
	cfg := config.Config{
		DataDir:       dataDir,
		ConfigDir:     dataDir,
		UploadsDir:    filepath.Join(dataDir, "uploads"),
		TmpDir:        filepath.Join(dataDir, "tmp"),
		DBPath:        filepath.Join(dataDir, "db.sqlite"),
		DefaultExpiry: "7d",
	}
	if mutate != nil {
		mutate(&cfg)
	}
	if err := cfg.EnsureDataDirs(); err != nil {
		t.Fatalf("ensure data dirs: %v", err)
	}
	db, err := store.Open(cfg.DBPath)
	if err != nil {
		t.Fatalf("open store: %v", err)
	}
	t.Cleanup(func() { _ = db.Close() })

	assets := webrootSub(t)
	shell, err := renderShell(assets, cfg)
	if err != nil {
		t.Fatalf("renderShell: %v", err)
	}
	tusHandler, err := upload.NewHandler(cfg, db)
	if err != nil {
		t.Fatalf("build tus handler: %v", err)
	}
	return newRouter(cfg, db, tusHandler, assets, shell)
}

// get sends a GET through the router and returns the recorder.
func get(h http.Handler, path string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(http.MethodGet, path, nil)
	req.RemoteAddr = "192.0.2.1:1234"
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return rec
}

func TestRouter_Healthcheck(t *testing.T) {
	h := newFullRouter(t, nil)

	rec := get(h, "/api/healthcheck")
	if rec.Code != http.StatusOK {
		t.Fatalf("/api/healthcheck status = %d, want 200", rec.Code)
	}
	var body struct {
		OK bool `json:"ok"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil || !body.OK {
		t.Fatalf("/api/healthcheck body = %q, want {\"ok\":true} (err %v)", rec.Body.String(), err)
	}
}

func TestRouter_HealthcheckNeverRateLimited(t *testing.T) {
	// Even with RATE_LIMIT active, the liveness probe must answer every poll —
	// far past any bucket's burst.
	h := newFullRouter(t, func(c *config.Config) { c.RateLimit = true })

	for i := 0; i < 100; i++ {
		if rec := get(h, "/api/healthcheck"); rec.Code != http.StatusOK {
			t.Fatalf("poll %d status = %d, want 200 (healthcheck must not be limited)", i+1, rec.Code)
		}
	}
}

func TestRouter_RobotsTxt(t *testing.T) {
	h := newFullRouter(t, nil)

	rec := get(h, "/robots.txt")
	if rec.Code != http.StatusOK {
		t.Fatalf("/robots.txt status = %d, want 200", rec.Code)
	}
	if ct := rec.Header().Get("Content-Type"); !strings.HasPrefix(ct, "text/plain") {
		t.Fatalf("/robots.txt Content-Type = %q, want text/plain", ct)
	}
	if got := rec.Body.String(); got != "User-agent: *\nDisallow: /\n" {
		t.Fatalf("/robots.txt body = %q, want the full disallow", got)
	}
}

func TestRouter_SharePageNoIndex(t *testing.T) {
	h := newFullRouter(t, nil)

	// The /d/<slug> SPA shell must carry the noindex header…
	rec := get(h, "/d/some-slug")
	if rec.Code != http.StatusOK {
		t.Fatalf("/d/some-slug status = %d, want 200 (SPA shell)", rec.Code)
	}
	if got := rec.Header().Get("X-Robots-Tag"); got != "noindex, nofollow" {
		t.Fatalf("/d/<slug> X-Robots-Tag = %q, want noindex, nofollow", got)
	}
	// …and so must the meta/download APIs (uniform 404s here — no share seeded).
	for _, path := range []string{"/api/d/some-slug", "/api/d/some-slug/meta"} {
		rec := get(h, path)
		if got := rec.Header().Get("X-Robots-Tag"); got != "noindex, nofollow" {
			t.Fatalf("%s X-Robots-Tag = %q, want noindex, nofollow", path, got)
		}
	}
	// The landing page is NOT noindex-tagged (robots.txt already disallows;
	// the header is scoped to share-facing responses per the v6.1 contract).
	if got := get(h, "/").Header().Get("X-Robots-Tag"); got != "" {
		t.Fatalf("/ X-Robots-Tag = %q, want unset", got)
	}
}

func TestRouter_DownloadRateLimited(t *testing.T) {
	// With RATE_LIMIT on, the download/meta bucket (20/min, burst 10) kicks in
	// after 10 rapid requests from one IP and answers 429 + Retry-After with
	// the uniform JSON error body.
	h := newFullRouter(t, func(c *config.Config) { c.RateLimit = true })

	last := http.StatusOK
	var lastRec *httptest.ResponseRecorder
	for i := 0; i < 11; i++ {
		lastRec = get(h, "/api/d/nonexistent")
		last = lastRec.Code
	}
	if last != http.StatusTooManyRequests {
		t.Fatalf("request 11 status = %d, want 429", last)
	}
	if ra := lastRec.Header().Get("Retry-After"); ra == "" {
		t.Fatalf("429 must carry Retry-After")
	}
	if got := lastRec.Body.String(); got != `{"error":"too many requests"}` {
		t.Fatalf("429 body = %q, want the uniform JSON error", got)
	}
}

func TestRouter_RateLimitDisabled(t *testing.T) {
	// RATE_LIMIT=false: no bucket ever fires (every response is the uniform 404).
	h := newFullRouter(t, func(c *config.Config) { c.RateLimit = false })

	for i := 0; i < 50; i++ {
		if rec := get(h, "/api/d/nonexistent"); rec.Code != http.StatusNotFound {
			t.Fatalf("request %d status = %d, want 404 (limiter must be off)", i+1, rec.Code)
		}
	}
}

func TestSPAHandler_ServesTemplatedRoot(t *testing.T) {
	assets := webrootSub(t)
	shell, err := renderShell(assets, config.Config{AppName: "Acme Files"})
	if err != nil {
		t.Fatalf("renderShell: %v", err)
	}
	h := spaHandler(assets, shell)

	for _, path := range []string{"/", "/index.html", "/d/some-slug"} {
		rec := httptest.NewRecorder()
		req := httptest.NewRequest(http.MethodGet, path, nil)
		h.ServeHTTP(rec, req)
		if rec.Code != http.StatusOK {
			t.Fatalf("%s status = %d, want 200", path, rec.Code)
		}
		if ct := rec.Header().Get("Content-Type"); !strings.HasPrefix(ct, "text/html") {
			t.Fatalf("%s Content-Type = %q, want text/html", path, ct)
		}
		body := rec.Body.String()
		if !strings.Contains(body, "<title>Acme Files</title>") {
			t.Fatalf("%s did not serve the templated shell:\n%s", path, body)
		}
		if strings.Contains(body, "%%") {
			t.Fatalf("%s served HTML with leftover tokens", path)
		}
	}
}
