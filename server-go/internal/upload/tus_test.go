package upload

import (
	"database/sql"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strconv"
	"testing"

	"github.com/go-chi/chi/v5"

	"github.com/junkerderprovinz/featherdrop/server-go/internal/config"
	"github.com/junkerderprovinz/featherdrop/server-go/internal/store"
)

// newTestRouter builds a chi router mounting the tus handler exactly as main.go
// does, so the tests exercise the real routing for both "/files" and
// "/files/*". db may be nil (no STORAGE_QUOTA configured).
func newTestRouter(t *testing.T, cfg config.Config, db *sql.DB) http.Handler {
	t.Helper()
	h, err := NewHandler(cfg, db)
	if err != nil {
		t.Fatalf("NewHandler: %v", err)
	}
	r := chi.NewRouter()
	r.Handle("/files", h)
	r.Handle("/files/*", h)
	return r
}

func openCfg(t *testing.T) config.Config {
	t.Helper()
	return config.Config{
		TmpDir:          t.TempDir(),
		MaxFileSize:     0,
		UploadProtected: false,
	}
}

func protectedCfg(t *testing.T, secret string) config.Config {
	t.Helper()
	return config.Config{
		TmpDir:          t.TempDir(),
		MaxFileSize:     0,
		UploadProtected: true,
		UploadPassword:  secret,
	}
}

// tusCreate issues a tus create (POST /files). token is attached when non-empty.
func tusCreate(srv http.Handler, token string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(http.MethodPost, "/files", nil)
	req.Header.Set("Tus-Resumable", "1.0.0")
	req.Header.Set("Upload-Length", "11")
	// metadata: filename "hello.txt" base64 = aGVsbG8udHh0
	req.Header.Set("Upload-Metadata", "filename aGVsbG8udHh0")
	if token != "" {
		req.Header.Set(UploadTokenHeader, token)
	}
	rec := httptest.NewRecorder()
	srv.ServeHTTP(rec, req)
	return rec
}

func tusOptions(srv http.Handler) *httptest.ResponseRecorder {
	req := httptest.NewRequest(http.MethodOptions, "/files", nil)
	req.Header.Set("Tus-Resumable", "1.0.0")
	rec := httptest.NewRecorder()
	srv.ServeHTTP(rec, req)
	return rec
}

func TestTus_Open_Create(t *testing.T) {
	srv := newTestRouter(t, openCfg(t), nil)

	rec := tusCreate(srv, "")
	if rec.Code != http.StatusCreated {
		t.Fatalf("POST /files (open) = %d, want 201; body=%q", rec.Code, rec.Body.String())
	}
	if loc := rec.Header().Get("Location"); loc == "" {
		t.Errorf("create response missing Location header")
	}
}

func TestTus_Open_Options(t *testing.T) {
	srv := newTestRouter(t, openCfg(t), nil)

	rec := tusOptions(srv)
	if rec.Code != http.StatusNoContent && rec.Code != http.StatusOK {
		t.Fatalf("OPTIONS /files = %d, want 204 or 200; body=%q", rec.Code, rec.Body.String())
	}
	if rec.Header().Get("Tus-Resumable") == "" && rec.Header().Get("Tus-Version") == "" {
		t.Errorf("OPTIONS response missing Tus-Version/Tus-Resumable headers; headers=%v", rec.Header())
	}
}

func TestTus_Protected_CreateWithoutToken_401(t *testing.T) {
	srv := newTestRouter(t, protectedCfg(t, "s3cret"), nil)

	rec := tusCreate(srv, "")
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("POST /files (protected, no token) = %d, want 401; body=%q", rec.Code, rec.Body.String())
	}
	if got := rec.Body.String(); got != "upload password required\n" {
		t.Errorf("401 body = %q, want %q", got, "upload password required\n")
	}
}

func TestTus_Protected_CreateWithWrongToken_401(t *testing.T) {
	srv := newTestRouter(t, protectedCfg(t, "s3cret"), nil)

	rec := tusCreate(srv, "wrong")
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("POST /files (protected, wrong token) = %d, want 401; body=%q", rec.Code, rec.Body.String())
	}
}

func TestTus_Protected_CreateWithToken_201(t *testing.T) {
	srv := newTestRouter(t, protectedCfg(t, "s3cret"), nil)

	rec := tusCreate(srv, "s3cret")
	if rec.Code != http.StatusCreated {
		t.Fatalf("POST /files (protected, correct token) = %d, want 201; body=%q", rec.Code, rec.Body.String())
	}
	if loc := rec.Header().Get("Location"); loc == "" {
		t.Errorf("create response missing Location header")
	}
}

func TestTus_Protected_OptionsNoToken_OK(t *testing.T) {
	srv := newTestRouter(t, protectedCfg(t, "s3cret"), nil)

	rec := tusOptions(srv)
	if rec.Code != http.StatusNoContent && rec.Code != http.StatusOK {
		t.Fatalf("OPTIONS /files (protected, no token) = %d, want 204 or 200; body=%q", rec.Code, rec.Body.String())
	}
}

// ---------------------------------------------------------------------------
// STORAGE_QUOTA gate on tus creation
// ---------------------------------------------------------------------------

// quotaEnv opens a real schema-applied store seeded with one share of
// storedSize bytes and returns it with a quota-capped config.
func quotaEnv(t *testing.T, quota, storedSize int64) (config.Config, *sql.DB) {
	t.Helper()
	dir := t.TempDir()
	cfg := config.Config{
		TmpDir:       dir,
		StorageQuota: quota,
	}
	db, err := store.Open(filepath.Join(dir, "db.sqlite"))
	if err != nil {
		t.Fatalf("open store: %v", err)
	}
	t.Cleanup(func() { _ = db.Close() })
	if storedSize > 0 {
		if err := store.CreateFileRecord(db, store.FileRecord{
			ID:     "stored-id",
			Slug:   "storedsl",
			Size:   storedSize,
			Format: 2,
		}); err != nil {
			t.Fatalf("seed record: %v", err)
		}
	}
	return cfg, db
}

// tusCreateLen issues a tus create declaring the given Upload-Length.
func tusCreateLen(srv http.Handler, length int64) *httptest.ResponseRecorder {
	req := httptest.NewRequest(http.MethodPost, "/files", nil)
	req.Header.Set("Tus-Resumable", "1.0.0")
	req.Header.Set("Upload-Length", strconv.FormatInt(length, 10))
	rec := httptest.NewRecorder()
	srv.ServeHTTP(rec, req)
	return rec
}

func TestTus_Quota_CreateOverQuota_507(t *testing.T) {
	// 100 bytes stored of a 150-byte quota: a 51-byte create must be refused
	// with 507 and the uniform JSON error shape, before any byte is accepted.
	cfg, db := quotaEnv(t, 150, 100)
	srv := newTestRouter(t, cfg, db)

	rec := tusCreateLen(srv, 51)
	if rec.Code != http.StatusInsufficientStorage {
		t.Fatalf("POST /files (over quota) = %d, want 507; body=%q", rec.Code, rec.Body.String())
	}
	if ct := rec.Header().Get("Content-Type"); ct != "application/json" {
		t.Errorf("507 Content-Type = %q, want application/json", ct)
	}
	if got := rec.Body.String(); got != `{"error":"storage quota exceeded"}` {
		t.Errorf("507 body = %q, want the uniform JSON error", got)
	}
}

func TestTus_Quota_CreateWithinQuota_201(t *testing.T) {
	// The same setup but a create that still fits (100+50 == 150) is accepted.
	cfg, db := quotaEnv(t, 150, 100)
	srv := newTestRouter(t, cfg, db)

	rec := tusCreateLen(srv, 50)
	if rec.Code != http.StatusCreated {
		t.Fatalf("POST /files (within quota) = %d, want 201; body=%q", rec.Code, rec.Body.String())
	}
}

func TestTus_Quota_Unlimited_201(t *testing.T) {
	// StorageQuota 0 = unlimited: any declared length passes the gate.
	cfg, db := quotaEnv(t, 0, 1<<40)
	srv := newTestRouter(t, cfg, db)

	rec := tusCreateLen(srv, 1<<40)
	if rec.Code != http.StatusCreated {
		t.Fatalf("POST /files (no quota) = %d, want 201; body=%q", rec.Code, rec.Body.String())
	}
}
