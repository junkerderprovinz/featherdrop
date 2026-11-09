// Package clientmanifest hashes the embedded web client, so anyone can compare
// what an instance serves with the files a release build produces.
// scripts/client-manifest.mjs writes the same manifest, byte for byte, for the
// release.
package clientmanifest

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io/fs"
	"net/http"
	"sort"
	"strings"
)

// Path is where the server publishes the manifest of the client it serves.
const Path = "/.well-known/castleparcel-client.json"

// TemplatePath serves the raw index.html. The page at / is that template with
// the instance's branding filled in, and a verifier needs the template to see
// that nothing else changed.
const TemplatePath = "/.well-known/castleparcel-client/index.html"

// Format names the manifest layout and changes whenever the layout or the root
// hash definition does.
const Format = "castleparcel-client/1"

// File is one file of the client and the hex SHA-256 of its bytes.
type File struct {
	Path   string `json:"path"`
	SHA256 string `json:"sha256"`
}

// Manifest lists every client file sorted by path. Root is the SHA-256 of the
// lines "<sha256>  <path>\n" in that order, which is what sha256sum prints, so
// coreutils alone can recompute it.
type Manifest struct {
	Format string `json:"format"`
	Root   string `json:"root"`
	Files  []File `json:"files"`
}

// Build hashes every regular file in fsys.
func Build(fsys fs.FS) (Manifest, error) {
	files := []File{}
	err := fs.WalkDir(fsys, ".", func(name string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() {
			return err
		}
		data, err := fs.ReadFile(fsys, name)
		if err != nil {
			return err
		}
		sum := sha256.Sum256(data)
		files = append(files, File{Path: name, SHA256: hex.EncodeToString(sum[:])})
		return nil
	})
	if err != nil {
		return Manifest{}, err
	}
	// WalkDir sorts per directory, which puts "assets/a.js" before
	// "assets-x/b.js"; the listing needs one byte order over full paths.
	sort.Slice(files, func(i, j int) bool { return files[i].Path < files[j].Path })

	var listing strings.Builder
	for _, f := range files {
		listing.WriteString(f.SHA256 + "  " + f.Path + "\n")
	}
	root := sha256.Sum256([]byte(listing.String()))
	return Manifest{Format: Format, Root: hex.EncodeToString(root[:]), Files: files}, nil
}

// JSON encodes the manifest with two-space indentation and a final newline,
// the layout JSON.stringify(m, null, 2) gives in the release script.
func (m Manifest) JSON() ([]byte, error) {
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	enc.SetIndent("", "  ")
	if err := enc.Encode(m); err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}

// Served is what an instance publishes about the client it embeds: the
// manifest and the raw index.html template it renders the page from.
type Served struct {
	Manifest Manifest
	json     []byte
	template []byte
}

// Load hashes assets and keeps the encoded manifest and the template for the
// handlers.
func Load(assets fs.FS) (Served, error) {
	m, err := Build(assets)
	if err != nil {
		return Served{}, err
	}
	body, err := m.JSON()
	if err != nil {
		return Served{}, err
	}
	template, err := fs.ReadFile(assets, "index.html")
	if err != nil {
		return Served{}, err
	}
	return Served{Manifest: m, json: body, template: template}, nil
}

// JSON returns the encoded manifest.
func (s Served) JSON() []byte { return s.json }

// ManifestHandler serves the manifest. no-cache makes a verifier see the
// current build right after an upgrade.
func (s Served) ManifestHandler() http.HandlerFunc {
	return func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Cache-Control", "no-cache")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write(s.json)
	}
}

// TemplateHandler serves the raw template as plain text, so a browser shows
// it instead of running its scripts against the unfilled markers.
func (s Served) TemplateHandler() http.HandlerFunc {
	return func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "text/plain; charset=utf-8")
		w.Header().Set("Cache-Control", "no-cache")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write(s.template)
	}
}
