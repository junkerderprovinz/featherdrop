package static

import (
	"bytes"
	"compress/gzip"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"testing/fstest"
)

var script = []byte(strings.Repeat("console.log('castle');\n", 400))

func testAssets(t *testing.T) *Assets {
	t.Helper()
	a, err := NewAssets(fstest.MapFS{
		"assets/index-abc123.js": {Data: script},
		"icon-512.png":           {Data: []byte("\x89PNG\r\n\x1a\nnot really a png")},
		"manifest.webmanifest":   {Data: []byte(`{"name":"CastleParcel","icons":[]}`)},
	})
	if err != nil {
		t.Fatalf("NewAssets: %v", err)
	}
	return a
}

func serve(a *Assets, method, path string, header map[string]string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(method, path, nil)
	for k, v := range header {
		req.Header.Set(k, v)
	}
	rec := httptest.NewRecorder()
	a.ServeHTTP(rec, req)
	return rec
}

func gunzip(t *testing.T, b []byte) []byte {
	t.Helper()
	zr, err := gzip.NewReader(bytes.NewReader(b))
	if err != nil {
		t.Fatalf("gzip reader: %v", err)
	}
	out, err := io.ReadAll(zr)
	if err != nil {
		t.Fatalf("gunzip: %v", err)
	}
	return out
}

func TestAssets_GzipsAScriptForABrowserThatAcceptsIt(t *testing.T) {
	rec := serve(testAssets(t), http.MethodGet, "/assets/index-abc123.js", map[string]string{"Accept-Encoding": "gzip, deflate, br"})
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	if got := rec.Header().Get("Content-Encoding"); got != "gzip" {
		t.Fatalf("Content-Encoding = %q, want gzip", got)
	}
	if got := rec.Header().Get("Vary"); got != "Accept-Encoding" {
		t.Errorf("Vary = %q, want Accept-Encoding", got)
	}
	if got := rec.Header().Get("Content-Type"); !strings.HasPrefix(got, "text/javascript") {
		t.Errorf("Content-Type = %q, want text/javascript", got)
	}
	if rec.Body.Len() >= len(script) {
		t.Errorf("gzipped body is %d bytes, the script %d", rec.Body.Len(), len(script))
	}
	if !bytes.Equal(gunzip(t, rec.Body.Bytes()), script) {
		t.Error("the gzipped body does not unpack to the script")
	}
}

func TestAssets_ServesThePlainScriptWithoutGzipInAcceptEncoding(t *testing.T) {
	for _, accept := range []string{"", "br", "gzip;q=0", "identity"} {
		rec := serve(testAssets(t), http.MethodGet, "/assets/index-abc123.js", map[string]string{"Accept-Encoding": accept})
		if got := rec.Header().Get("Content-Encoding"); got != "" {
			t.Errorf("Accept-Encoding %q: Content-Encoding = %q, want none", accept, got)
		}
		if !bytes.Equal(rec.Body.Bytes(), script) {
			t.Errorf("Accept-Encoding %q: body is not the script", accept)
		}
		if got := rec.Header().Get("Vary"); got != "Accept-Encoding" {
			t.Errorf("Accept-Encoding %q: Vary = %q, want Accept-Encoding", accept, got)
		}
	}
}

func TestAssets_RangeRequestsGetThePlainBytes(t *testing.T) {
	rec := serve(testAssets(t), http.MethodGet, "/assets/index-abc123.js", map[string]string{"Accept-Encoding": "gzip", "Range": "bytes=0-9"})
	if rec.Code != http.StatusPartialContent {
		t.Fatalf("status = %d, want 206", rec.Code)
	}
	if got := rec.Header().Get("Content-Encoding"); got != "" {
		t.Errorf("Content-Encoding = %q, want none", got)
	}
	if !bytes.Equal(rec.Body.Bytes(), script[:10]) {
		t.Errorf("body = %q, want the first ten bytes", rec.Body.Bytes())
	}
}

func TestAssets_HeadAnswersWithoutABody(t *testing.T) {
	rec := serve(testAssets(t), http.MethodHead, "/assets/index-abc123.js", map[string]string{"Accept-Encoding": "gzip"})
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	if rec.Body.Len() != 0 {
		t.Errorf("HEAD sent %d body bytes", rec.Body.Len())
	}
	if rec.Header().Get("Content-Length") == "" {
		t.Error("HEAD has no Content-Length")
	}
}

func TestAssets_LeavesImagesUncompressed(t *testing.T) {
	rec := serve(testAssets(t), http.MethodGet, "/icon-512.png", map[string]string{"Accept-Encoding": "gzip"})
	if got := rec.Header().Get("Content-Encoding"); got != "" {
		t.Errorf("Content-Encoding = %q, want none", got)
	}
}

func TestAssets_GzipsTheWebManifest(t *testing.T) {
	big, err := NewAssets(fstest.MapFS{"manifest.webmanifest": {Data: []byte(`{"name":"CastleParcel","icons":[` + strings.Repeat(`{"src":"/icon-512.png"},`, 40) + `{}]}`)}})
	if err != nil {
		t.Fatalf("NewAssets: %v", err)
	}
	rec := serve(big, http.MethodGet, "/manifest.webmanifest", map[string]string{"Accept-Encoding": "gzip"})
	if got := rec.Header().Get("Content-Encoding"); got != "gzip" {
		t.Errorf("Content-Encoding = %q, want gzip", got)
	}
	if got := rec.Header().Get("Content-Type"); got != "application/manifest+json" {
		t.Errorf("Content-Type = %q, want application/manifest+json", got)
	}
}

func TestAssets_KeepsAFileThatGzipWouldNotShrink(t *testing.T) {
	rec := serve(testAssets(t), http.MethodGet, "/manifest.webmanifest", map[string]string{"Accept-Encoding": "gzip"})
	if got := rec.Header().Get("Content-Encoding"); got != "" {
		t.Errorf("Content-Encoding = %q, want none for a file gzip makes larger", got)
	}
}

func TestAssets_HashedAssetsAreCachedForAYear(t *testing.T) {
	a := testAssets(t)
	if got := serve(a, http.MethodGet, "/assets/index-abc123.js", nil).Header().Get("Cache-Control"); got != "public, max-age=31536000, immutable" {
		t.Errorf("assets/ Cache-Control = %q", got)
	}
	if got := serve(a, http.MethodGet, "/icon-512.png", nil).Header().Get("Cache-Control"); got != "" {
		t.Errorf("icon Cache-Control = %q, want none outside assets/", got)
	}
}
