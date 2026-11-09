package clientmanifest

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"net/http"
	"net/http/httptest"
	"os"
	"testing"
	"testing/fstest"
)

func TestBuild_MatchesGoldenManifest(t *testing.T) {
	m, err := Build(os.DirFS("testdata/webroot"))
	if err != nil {
		t.Fatalf("Build: %v", err)
	}
	got, err := m.JSON()
	if err != nil {
		t.Fatalf("JSON: %v", err)
	}
	want, err := os.ReadFile("testdata/manifest.json")
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(got, want) {
		t.Fatalf("manifest differs from testdata/manifest.json\ngot:\n%s\nwant:\n%s", got, want)
	}
}

func TestBuild_RootIsTheHashOfTheSha256sumListing(t *testing.T) {
	fsys := fstest.MapFS{
		"b.js":       {Data: []byte("b")},
		"a/index.js": {Data: []byte("a")},
	}
	m, err := Build(fsys)
	if err != nil {
		t.Fatalf("Build: %v", err)
	}
	listing := hexSum("a") + "  a/index.js\n" + hexSum("b") + "  b.js\n"
	if want := hexSum(listing); m.Root != want {
		t.Fatalf("root = %s, want %s", m.Root, want)
	}
}

func TestBuild_SortsPathsByBytes(t *testing.T) {
	fsys := fstest.MapFS{
		"index.html":    {Data: []byte("x")},
		"Z.js":          {Data: []byte("x")},
		"assets/a.js":   {Data: []byte("x")},
		"assets-x/b.js": {Data: []byte("x")},
	}
	m, err := Build(fsys)
	if err != nil {
		t.Fatalf("Build: %v", err)
	}
	want := []string{"Z.js", "assets-x/b.js", "assets/a.js", "index.html"}
	if len(m.Files) != len(want) {
		t.Fatalf("got %d files, want %d", len(m.Files), len(want))
	}
	for i, f := range m.Files {
		if f.Path != want[i] {
			t.Fatalf("files[%d] = %s, want %s", i, f.Path, want[i])
		}
	}
}

func TestBuild_ChangedByteChangesRoot(t *testing.T) {
	a, _ := Build(fstest.MapFS{"app.js": {Data: []byte("good")}})
	b, _ := Build(fstest.MapFS{"app.js": {Data: []byte("evil")}})
	if a.Root == b.Root {
		t.Fatal("different file contents gave the same root")
	}
}

func TestServed_ManifestHandlerServesTheGoldenJSON(t *testing.T) {
	s, err := Load(os.DirFS("testdata/webroot"))
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	rec := httptest.NewRecorder()
	s.ManifestHandler().ServeHTTP(rec, httptest.NewRequest(http.MethodGet, Path, nil))

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	if ct := rec.Header().Get("Content-Type"); ct != "application/json" {
		t.Fatalf("Content-Type = %q, want application/json", ct)
	}
	if cc := rec.Header().Get("Cache-Control"); cc != "no-cache" {
		t.Fatalf("Cache-Control = %q, want no-cache", cc)
	}
	want, _ := os.ReadFile("testdata/manifest.json")
	if !bytes.Equal(rec.Body.Bytes(), want) {
		t.Fatalf("body = %s, want %s", rec.Body.Bytes(), want)
	}
}

func TestServed_TemplateHandlerServesTheRawIndexAsText(t *testing.T) {
	s, err := Load(os.DirFS("testdata/webroot"))
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	rec := httptest.NewRecorder()
	s.TemplateHandler().ServeHTTP(rec, httptest.NewRequest(http.MethodGet, TemplatePath, nil))

	if ct := rec.Header().Get("Content-Type"); ct != "text/plain; charset=utf-8" {
		t.Fatalf("Content-Type = %q, want text/plain so no browser runs the template", ct)
	}
	want, _ := os.ReadFile("testdata/webroot/index.html")
	if !bytes.Equal(rec.Body.Bytes(), want) {
		t.Fatalf("body = %q, want the raw template %q", rec.Body.Bytes(), want)
	}
	if sum := hexSum(rec.Body.String()); sum != s.Manifest.Files[2].SHA256 {
		t.Fatalf("template hash %s is not the manifest's index.html entry", sum)
	}
}

func hexSum(s string) string {
	sum := sha256.Sum256([]byte(s))
	return hex.EncodeToString(sum[:])
}
