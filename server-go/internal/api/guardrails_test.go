package api

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/junkerderprovinz/castleparcel/server-go/internal/store"
)

func TestFinalize_ExpiryCap(t *testing.T) {
	tests := []struct {
		name       string
		maxExpiry  string
		expiry     string
		wantStatus int
	}{
		{"no cap allows never", "", "never", http.StatusOK},
		{"no cap allows 30d", "", "30d", http.StatusOK},
		{"under cap", "7d", "1h", http.StatusOK},
		{"at cap", "7d", "7d", http.StatusOK},
		{"over cap", "7d", "30d", http.StatusBadRequest},
		{"never over finite cap", "7d", "never", http.StatusBadRequest},
		{"never cap allows never", "never", "never", http.StatusOK},
		{"never cap allows 30d", "never", "30d", http.StatusOK},
		{"empty expiry uses (clamped) default", "7d", "", http.StatusOK},
		{"smallest cap rejects the next step", "1h", "6h", http.StatusBadRequest},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			e := newTestEnv(t)
			e.cfg.MaxExpiry = tt.maxExpiry
			id := e.makeTusUpload(t, []byte("capped blob"))

			body := map[string]any{"uploadId": id, "format": 2}
			if tt.expiry != "" {
				body["expiry"] = tt.expiry
			}
			rec := e.finalize(t, nil, body, nil)
			if rec.Code != tt.wantStatus {
				t.Fatalf("status = %d, want %d (body %s)", rec.Code, tt.wantStatus, rec.Body.String())
			}
			if tt.wantStatus == http.StatusBadRequest {
				var eb errorBody
				decodeJSON(t, rec, &eb)
				if eb.Error != "expiry exceeds the server's maximum" {
					t.Fatalf("error = %q, want expiry exceeds the server's maximum", eb.Error)
				}
				if _, err := os.Stat(filepath.Join(e.cfg.TmpDir, id)); err != nil {
					t.Fatalf("upload must survive a cap 400: %v", err)
				}
			}
		})
	}
}

func TestFinalize_QuotaExceeded_507(t *testing.T) {
	e := newTestEnv(t)
	e.cfg.StorageQuota = 150
	e.seedV2(t, make([]byte, 100), nil)
	id := e.makeTusUpload(t, make([]byte, 60))

	rec := e.finalize(t, nil, map[string]any{"uploadId": id, "format": 2}, nil)
	if rec.Code != http.StatusInsufficientStorage {
		t.Fatalf("status = %d, want 507 (body %s)", rec.Code, rec.Body.String())
	}
	var eb errorBody
	decodeJSON(t, rec, &eb)
	if eb.Error != "storage quota exceeded" {
		t.Fatalf("error = %q, want storage quota exceeded", eb.Error)
	}
	if _, err := os.Stat(filepath.Join(e.cfg.TmpDir, id)); err != nil {
		t.Fatalf("upload must survive a quota 507: %v", err)
	}
	if _, err := os.Stat(filepath.Join(e.cfg.UploadsDir, id)); !os.IsNotExist(err) {
		t.Fatalf("blob must not be moved to uploads on a quota 507")
	}
}

func TestFinalize_QuotaWithin_200(t *testing.T) {
	e := newTestEnv(t)
	e.cfg.StorageQuota = 150
	e.seedV2(t, make([]byte, 100), nil)
	id := e.makeTusUpload(t, make([]byte, 50))

	rec := e.finalize(t, nil, map[string]any{"uploadId": id, "format": 2}, nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200 (body %s)", rec.Code, rec.Body.String())
	}
}

func TestFinalize_QuotaUnlimited_200(t *testing.T) {
	e := newTestEnv(t)
	e.cfg.StorageQuota = 0
	e.seedV2(t, make([]byte, 4096), nil)
	id := e.makeTusUpload(t, make([]byte, 4096))

	rec := e.finalize(t, nil, map[string]any{"uploadId": id, "format": 2}, nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200 (body %s)", rec.Code, rec.Body.String())
	}
}

func TestDownload_NoIndexHeader(t *testing.T) {
	e := newTestEnv(t)
	slug := e.seedV2(t, []byte("blob"), nil)

	req := httptest.NewRequest(http.MethodGet, "/api/d/"+slug, nil)
	rec := httptest.NewRecorder()
	e.router(nil).ServeHTTP(rec, req)
	if got := rec.Header().Get("X-Robots-Tag"); got != "noindex, nofollow" {
		t.Fatalf("download X-Robots-Tag = %q, want noindex, nofollow", got)
	}

	// The 404 carries it too, so the header does not reveal whether a share
	// exists.
	rec404 := httptest.NewRecorder()
	e.router(nil).ServeHTTP(rec404, httptest.NewRequest(http.MethodGet, "/api/d/nonexistent", nil))
	if got := rec404.Header().Get("X-Robots-Tag"); got != "noindex, nofollow" {
		t.Fatalf("download 404 X-Robots-Tag = %q, want noindex, nofollow", got)
	}
}

func TestMeta_NoIndexHeader(t *testing.T) {
	e := newTestEnv(t)
	slug := e.seedV2(t, []byte("blob"), nil)

	req := httptest.NewRequest(http.MethodGet, "/api/d/"+slug+"/meta", nil)
	rec := httptest.NewRecorder()
	e.metaRouter(nil).ServeHTTP(rec, req)
	if got := rec.Header().Get("X-Robots-Tag"); got != "noindex, nofollow" {
		t.Fatalf("meta X-Robots-Tag = %q, want noindex, nofollow", got)
	}

	rec404 := httptest.NewRecorder()
	e.metaRouter(nil).ServeHTTP(rec404, httptest.NewRequest(http.MethodGet, "/api/d/nonexistent/meta", nil))
	if got := rec404.Header().Get("X-Robots-Tag"); got != "noindex, nofollow" {
		t.Fatalf("meta 404 X-Robots-Tag = %q, want noindex, nofollow", got)
	}
}

func TestHealthcheck_OKTrue(t *testing.T) {
	req := httptest.NewRequest(http.MethodGet, "/api/healthcheck", nil)
	rec := httptest.NewRecorder()
	HealthcheckHandler().ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	if ct := rec.Header().Get("Content-Type"); ct != "application/json" {
		t.Fatalf("Content-Type = %q, want application/json", ct)
	}
	if got := rec.Body.String(); got != `{"ok":true}` {
		t.Fatalf("body = %q, want {\"ok\":true}", got)
	}
}

// makeTrackedTusUpload makes a tus upload and records it as pending, as the
// tus create does.
func (e *testEnv) makeTrackedTusUpload(t *testing.T, content []byte) string {
	t.Helper()
	id := e.makeTusUpload(t, content)
	if err := store.TrackPendingUpload(e.db, store.PendingUpload{ID: id, Size: int64(len(content)), CreatedAt: 1}); err != nil {
		t.Fatal(err)
	}
	return id
}

func TestFinalize_AnUploadInProgressCountsOnce(t *testing.T) {
	e := newTestEnv(t)
	e.cfg.StorageQuota = 150
	e.seedV2(t, make([]byte, 100), nil)
	id := e.makeTrackedTusUpload(t, make([]byte, 50))

	rec := e.finalize(t, nil, map[string]any{"uploadId": id, "format": 2}, nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200 (body %s)", rec.Code, rec.Body.String())
	}
	if used, _ := store.QuotaUsage(e.db, ""); used != 150 {
		t.Errorf("usage after finalize = %d, want 150", used)
	}
	if up, _ := store.GetPendingUpload(e.db, id); up != nil {
		t.Errorf("the share still counts as pending: %+v", up)
	}
}

func TestFinalize_OtherUploadsInProgressCountTowardTheQuota(t *testing.T) {
	e := newTestEnv(t)
	e.cfg.StorageQuota = 150
	e.seedV2(t, make([]byte, 100), nil)
	e.makeTrackedTusUpload(t, make([]byte, 30))
	id := e.makeTrackedTusUpload(t, make([]byte, 30))

	rec := e.finalize(t, nil, map[string]any{"uploadId": id, "format": 2}, nil)
	if rec.Code != http.StatusInsufficientStorage {
		t.Fatalf("status = %d, want 507 (body %s)", rec.Code, rec.Body.String())
	}
}

func TestFinalize_RefusesAnOversizedBody(t *testing.T) {
	e := newTestEnv(t)
	id := e.makeTusUpload(t, []byte("small blob"))

	rec := e.finalize(t, nil, map[string]any{"uploadId": id, "format": 2, "pad": strings.Repeat("x", 1<<20)}, nil)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("finalize with a 1 MiB body = %d, want 400", rec.Code)
	}
}
