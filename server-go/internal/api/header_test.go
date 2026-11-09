package api

import (
	"bytes"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"testing"

	"github.com/junkerderprovinz/castleparcel/server-go/internal/store"
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
	meta := []byte("encrypted names and sizes")
	v4 := v4Blob(1064, 4096+16)
	for i := 5; i < len(v4); i++ {
		v4[i] = byte(i)
	}
	tests := []struct {
		name   string
		format int64
		blob   []byte
		header int
	}{
		{"format 2", 2, blobWithHeader(meta, []byte("content that stays behind the counted download")), 1 + len(meta)},
		{"format 3", 3, blobWithHeader(meta, []byte("content that stays behind the counted download")), 1 + len(meta)},
		{"format 4", 4, v4, 5 + 1064},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			e := newTestEnv(t)
			v := goodVerifier
			slug := e.seedV2(t, tt.blob, func(r *store.FileRecord) {
				r.Format = tt.format
				r.KeyVerifier = &v
				one := int64(1)
				r.MaxDownloads = &one
			})

			rec := getHeader(e.router(nil), slug, v)
			if rec.Code != http.StatusOK {
				t.Fatalf("status = %d, want 200 (body %s)", rec.Code, rec.Body.String())
			}
			want := tt.blob[:tt.header]
			if !bytes.Equal(rec.Body.Bytes(), want) {
				t.Fatalf("body is %d bytes, want only the %d header bytes", rec.Body.Len(), len(want))
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

func v4WithVersion(version byte) []byte {
	b := v4Blob(1064, 4112)
	b[0] = version
	return b
}

func format4(r *store.FileRecord) { r.Format = 4 }

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
		{"format 4 with another version", v4WithVersion(0x01), format4},
		{"format 4 header too short", v4Blob(1063, 4112), format4},
		{"format 4 header too long", v4Blob(16<<20+1, 0), format4},
		{"format 4 header past the blob", v4Blob(1064, 4112)[:1000], format4},
		{"format 4 content too short", v4Blob(1064, 4111), format4},
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
