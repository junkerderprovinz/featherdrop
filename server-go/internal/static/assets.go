package static

import (
	"bytes"
	"compress/gzip"
	"io/fs"
	"mime"
	"net/http"
	"path"
	"strconv"
	"strings"
)

// The main script carries the Rive runtime, its WebAssembly and the animation, a few
// megabytes that gzip to well under half. The server may run without a proxy that
// compresses, so it gzips text assets once at startup.
var compressible = map[string]bool{
	".css": true, ".html": true, ".js": true, ".json": true, ".mjs": true,
	".svg": true, ".txt": true, ".wasm": true, ".webmanifest": true,
}

// Assets serves the embedded client files, gzipped for browsers that accept it.
// Files under assets/ carry a content hash in their name and are cached for a year.
type Assets struct {
	files   http.Handler
	types   map[string]string
	gzipped map[string][]byte
}

// NewAssets reads every file of fsys and keeps a gzipped copy of each text file
// that gzip makes smaller.
func NewAssets(fsys fs.FS) (*Assets, error) {
	a := &Assets{
		files:   http.FileServer(http.FS(fsys)),
		types:   map[string]string{},
		gzipped: map[string][]byte{},
	}
	err := fs.WalkDir(fsys, ".", func(name string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() {
			return err
		}
		data, err := fs.ReadFile(fsys, name)
		if err != nil {
			return err
		}
		a.types[name] = contentType(name, data)
		if !compressible[path.Ext(name)] {
			return nil
		}
		var buf bytes.Buffer
		zw, _ := gzip.NewWriterLevel(&buf, gzip.BestCompression)
		if _, err := zw.Write(data); err != nil {
			return err
		}
		if err := zw.Close(); err != nil {
			return err
		}
		if buf.Len() < len(data) {
			a.gzipped[name] = buf.Bytes()
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	return a, nil
}

func (a *Assets) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	name := strings.TrimPrefix(path.Clean("/"+r.URL.Path), "/")
	ctype, known := a.types[name]
	if !known {
		http.NotFound(w, r)
		return
	}
	h := w.Header()
	h.Set("Content-Type", ctype)
	if strings.HasPrefix(name, "assets/") {
		h.Set("Cache-Control", "public, max-age=31536000, immutable")
	}
	gz, ok := a.gzipped[name]
	if !ok {
		a.files.ServeHTTP(w, r)
		return
	}
	h.Add("Vary", "Accept-Encoding")
	if r.Header.Get("Range") != "" || !acceptsGzip(r.Header.Get("Accept-Encoding")) {
		a.files.ServeHTTP(w, r)
		return
	}
	h.Set("Content-Encoding", "gzip")
	h.Set("Content-Length", strconv.Itoa(len(gz)))
	w.WriteHeader(http.StatusOK)
	if r.Method != http.MethodHead {
		_, _ = w.Write(gz)
	}
}

// Has reports whether name, a slash-separated path without a leading slash, is a file.
func (a *Assets) Has(name string) bool {
	_, ok := a.types[name]
	return ok
}

func contentType(name string, data []byte) string {
	if path.Ext(name) == ".webmanifest" {
		return "application/manifest+json"
	}
	if t := mime.TypeByExtension(path.Ext(name)); t != "" {
		return t
	}
	return http.DetectContentType(data)
}

// acceptsGzip reports whether an Accept-Encoding header lists gzip with a weight above zero.
func acceptsGzip(header string) bool {
	for _, part := range strings.Split(header, ",") {
		coding, params, _ := strings.Cut(part, ";")
		if !strings.EqualFold(strings.TrimSpace(coding), "gzip") {
			continue
		}
		q, found := strings.CutPrefix(strings.TrimSpace(params), "q=")
		if !found {
			return true
		}
		weight, err := strconv.ParseFloat(q, 64)
		return err == nil && weight > 0
	}
	return false
}
