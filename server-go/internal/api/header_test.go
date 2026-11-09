package api

import (
	"bytes"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"testing"

	"github.com/junkerderprovinz/featherdrop/server-go/internal/store"
)

// blobWithHeader lays out [varint(len(meta))][meta][content] for a meta under
// 128 bytes.
func blobWithHeader(meta, content []byte) []byte {
	out := append([]byte{byte(len(meta))}, meta...)
	return append(out, content...)
}

func getHeader(h http.Handler, slug, verifier string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(http.MethodGet, "/api/d/"+slug+"/header", nil)
	if verifier != "" {
		req.Header.Set(keyVerifierHeader, verifier)
	}
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return rec
}

func TestHeader_ServesOnlyTheEncryptedMetadata(t *testing.T) {
	for _, format := range []int64{2, 3} {
		t.Run("format "+strconv.FormatInt(format, 10), func(t *testing.T) {
			e := newTestEnv(t)
			meta := []byte("encrypted names and sizes")
			blob := blobWithHeader(meta, []byte("content that stays behind the counted download"))
			v := goodVerifier
			slug := e.seedV2(t, blob, func(r *store.FileRecord) {
				r.Format = format
				r.KeyVerifier = &v
				one := int64(1)
				r.MaxDownloads = &one
			})

			rec := getHeader(e.router(nil), slug, v)
			if rec.Code != http.StatusOK {
				t.Fatalf("status = %d, want 200 (body %s)", rec.Code, rec.Body.String())
			}
			want := blob[:1+len(meta)]
			if !bytes.Equal(rec.Body.Bytes(), want) {
				t.Fatalf("body = %q, want only the header %q", rec.Body.Bytes(), want)
			}
			if cl := rec.Header().Get("Content-Length"); cl != strconv.Itoa(len(want)) {
				t.Fatalf("Content-Length = %q, want %d", cl, len(want))
			}
			if rec.Header().Get("Cache-Control") != "private, no-store" {
				t.Fatalf("Cache-Control = %q", rec.Header().Get("Cache-Control"))
			}
			if rec.Header().Get("X-Robots-Tag") != "noindex, nofollow" {
				t.Fatalf("missing X-Robots-Tag")
			}
			row, _ := store.GetFileBySlug(e.db, slug)
			if row == nil || row.DownloadCount != 0 {
				t.Fatalf("reading the header must not count or burn, row = %+v", row)
			}
		})
	}
}

func TestHeader_KeyVerifierRequired(t *testing.T) {
	tests := []struct {
		name     string
		verifier string
	}{
		{"missing", ""},
		{"wrong", "wrongwrongwrongwrongwrongwrongwrongwrongwro"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			e := newTestEnv(t)
			v := goodVerifier
			slug := e.seedV2(t, blobWithHeader([]byte("meta"), []byte("content")),
				func(r *store.FileRecord) { r.KeyVerifier = &v })

			rec := getHeader(e.router(nil), slug, tt.verifier)
			if rec.Code != http.StatusUnauthorized {
				t.Fatalf("status = %d, want 401", rec.Code)
			}
		})
	}
}

func TestHeader_NotFound(t *testing.T) {
	past := int64(1000)
	tests := []struct {
		name   string
		blob   []byte
		mutate func(*store.FileRecord)
	}{
		{"expired", blobWithHeader([]byte("m"), nil), func(r *store.FileRecord) { r.ExpiresAt = &past }},
		{"format 1", blobWithHeader([]byte("m"), nil), func(r *store.FileRecord) { r.Format = 1 }},
		{"unknown format", blobWithHeader([]byte("m"), nil), func(r *store.FileRecord) { r.Format = 9 }},
		{"length past the blob", []byte{40, 'm', 'e', 't', 'a'}, nil},
		{"truncated length", []byte{0x80}, nil},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			e := newTestEnv(t)
			slug := e.seedV2(t, tt.blob, tt.mutate)
			rec := getHeader(e.router(fixedNow(2000)), slug, "")
			if rec.Code != http.StatusNotFound {
				t.Fatalf("status = %d, want 404 (body %s)", rec.Code, rec.Body.String())
			}
		})
	}

	t.Run("unknown slug", func(t *testing.T) {
		e := newTestEnv(t)
		if rec := getHeader(e.router(nil), "nonexistent", ""); rec.Code != http.StatusNotFound {
			t.Fatalf("status = %d, want 404", rec.Code)
		}
	})

	t.Run("missing blob", func(t *testing.T) {
		e := newTestEnv(t)
		slug := e.seedV2(t, blobWithHeader([]byte("m"), nil), nil)
		row, _ := store.GetFileBySlug(e.db, slug)
		if err := os.Remove(filepath.Join(e.cfg.UploadsDir, row.ID)); err != nil {
			t.Fatal(err)
		}
		if rec := getHeader(e.router(nil), slug, ""); rec.Code != http.StatusNotFound {
			t.Fatalf("status = %d, want 404", rec.Code)
		}
	})
}
