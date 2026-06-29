package main

import (
	"io/fs"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/junkerderprovinz/featherdrop/server-go/internal/config"
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
