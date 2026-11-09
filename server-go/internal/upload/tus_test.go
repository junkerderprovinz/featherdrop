package upload

import (
	"bytes"
	"database/sql"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"

	"github.com/junkerderprovinz/featherdrop/server-go/internal/clientip"
	"github.com/junkerderprovinz/featherdrop/server-go/internal/config"
	"github.com/junkerderprovinz/featherdrop/server-go/internal/store"
)

// newTestRouter mounts the tus handler on chi at "/files" and "/files/*" as
// main.go does. db may be nil when no quota is set.
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

// tusCreate sends a tus create, with the upload token when it is non-empty.
func tusCreate(srv http.Handler, token string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(http.MethodPost, "/files", nil)
	req.Header.Set("Tus-Resumable", "1.0.0")
	req.Header.Set("Upload-Length", "11")
	// filename "hello.txt"
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

// quotaEnv opens a real store seeded with one share of storedSize bytes and
// returns it with a config capped at quota.
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

func tusCreateLen(srv http.Handler, length int64) *httptest.ResponseRecorder {
	req := httptest.NewRequest(http.MethodPost, "/files", nil)
	req.Header.Set("Tus-Resumable", "1.0.0")
	req.Header.Set("Upload-Length", strconv.FormatInt(length, 10))
	rec := httptest.NewRecorder()
	srv.ServeHTTP(rec, req)
	return rec
}

func TestTus_Quota_CreateOverQuota_507(t *testing.T) {
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
	cfg, db := quotaEnv(t, 150, 100)
	srv := newTestRouter(t, cfg, db)

	rec := tusCreateLen(srv, 50)
	if rec.Code != http.StatusCreated {
		t.Fatalf("POST /files (within quota) = %d, want 201; body=%q", rec.Code, rec.Body.String())
	}
}

func TestTus_Quota_Unlimited_201(t *testing.T) {
	cfg, db := quotaEnv(t, 0, 1<<40)
	srv := newTestRouter(t, cfg, db)

	rec := tusCreateLen(srv, 1<<40)
	if rec.Code != http.StatusCreated {
		t.Fatalf("POST /files (no quota) = %d, want 201; body=%q", rec.Code, rec.Body.String())
	}
}

func TestTus_LogsOnlyErrors(t *testing.T) {
	cfg := openCfg(t)
	var logs bytes.Buffer
	h, err := newHandler(cfg, nil, &logs)
	if err != nil {
		t.Fatalf("newHandler: %v", err)
	}
	r := chi.NewRouter()
	r.Handle("/files", h)
	r.Handle("/files/*", h)

	create := tusCreate(r, "")
	if create.Code != http.StatusCreated {
		t.Fatalf("create = %d, want 201", create.Code)
	}
	patch := httptest.NewRequest(http.MethodPatch, create.Header().Get("Location"), strings.NewReader("hello world"))
	patch.Header.Set("Tus-Resumable", "1.0.0")
	patch.Header.Set("Upload-Offset", "0")
	patch.Header.Set("Content-Type", "application/offset+octet-stream")
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, patch)
	if rec.Code != http.StatusNoContent {
		t.Fatalf("patch = %d, want 204; body=%q", rec.Code, rec.Body.String())
	}
	if logs.Len() != 0 {
		t.Fatalf("a normal upload logged:\n%s", logs.String())
	}

	// A file where the store expects its directory is a real failure the
	// operator should see.
	if err := os.RemoveAll(cfg.TmpDir); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(cfg.TmpDir, nil, 0o600); err != nil {
		t.Fatal(err)
	}
	if rec := tusCreate(r, ""); rec.Code != http.StatusInternalServerError {
		t.Fatalf("create without a store dir = %d, want 500", rec.Code)
	}
	if !strings.Contains(logs.String(), "InternalServerError") {
		t.Fatalf("the store failure was not logged: %q", logs.String())
	}
}

func limitCfg(t *testing.T, limit int64) config.Config {
	t.Helper()
	return config.Config{TmpDir: t.TempDir(), UploadLimitPerIP: limit}
}

// tusCreateFrom sends a tus create of length bytes from remoteAddr, with any
// extra headers.
func tusCreateFrom(srv http.Handler, remoteAddr string, length int64, header map[string]string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(http.MethodPost, "/files", nil)
	req.RemoteAddr = remoteAddr
	req.Header.Set("Tus-Resumable", "1.0.0")
	req.Header.Set("Upload-Length", strconv.FormatInt(length, 10))
	for k, v := range header {
		req.Header.Set(k, v)
	}
	rec := httptest.NewRecorder()
	srv.ServeHTTP(rec, req)
	return rec
}

func TestTus_UploadLimit_OverBudget_429(t *testing.T) {
	srv := newTestRouter(t, limitCfg(t, 20), nil)

	if rec := tusCreateFrom(srv, "203.0.113.7:1000", 11, nil); rec.Code != http.StatusCreated {
		t.Fatalf("first create = %d, want 201", rec.Code)
	}
	rec := tusCreateFrom(srv, "203.0.113.7:1001", 11, nil)
	if rec.Code != http.StatusTooManyRequests {
		t.Fatalf("create past the limit = %d, want 429", rec.Code)
	}
	if rec.Header().Get("Retry-After") == "" {
		t.Error("429 without Retry-After")
	}
	if got := rec.Body.String(); got != `{"error":"upload limit reached"}` {
		t.Errorf("429 body = %q", got)
	}
	if rec := tusCreateFrom(srv, "198.51.100.2:1000", 11, nil); rec.Code != http.StatusCreated {
		t.Errorf("another client = %d, want 201", rec.Code)
	}
}

func TestTus_UploadLimit_LargerThanTheLimit_413(t *testing.T) {
	srv := newTestRouter(t, limitCfg(t, 10), nil)

	rec := tusCreateFrom(srv, "203.0.113.7:1000", 11, nil)
	if rec.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("create over the limit = %d, want 413", rec.Code)
	}
	if got := rec.Body.String(); got != `{"error":"upload larger than the limit"}` {
		t.Errorf("413 body = %q", got)
	}
}

func TestTus_UploadLimit_RefusedCreateCostsNothing(t *testing.T) {
	srv := newTestRouter(t, limitCfg(t, 11), nil)

	bad := tusCreateFrom(srv, "203.0.113.7:1000", 11, map[string]string{"Tus-Resumable": "0.0.1"})
	if bad.Code == http.StatusCreated {
		t.Fatal("tusd accepted an unsupported protocol version")
	}
	if rec := tusCreateFrom(srv, "203.0.113.7:1000", 11, nil); rec.Code != http.StatusCreated {
		t.Errorf("create after a refused one = %d, want 201", rec.Code)
	}
}

func TestTus_UploadLimit_DeferredLength_400(t *testing.T) {
	srv := newTestRouter(t, limitCfg(t, 100), nil)

	req := httptest.NewRequest(http.MethodPost, "/files", nil)
	req.Header.Set("Tus-Resumable", "1.0.0")
	req.Header.Set("Upload-Defer-Length", "1")
	rec := httptest.NewRecorder()
	srv.ServeHTTP(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("deferred-length create = %d, want 400", rec.Code)
	}
}

func TestTus_UploadLimit_CountsTheClientBehindAProxy(t *testing.T) {
	cfg := limitCfg(t, 11)
	proxies, err := clientip.Parse("10.0.0.0/8")
	if err != nil {
		t.Fatal(err)
	}
	cfg.TrustedProxies = proxies
	srv := newTestRouter(t, cfg, nil)

	for _, client := range []string{"203.0.113.7", "198.51.100.2"} {
		rec := tusCreateFrom(srv, "10.0.0.2:1000", 11, map[string]string{"X-Forwarded-For": client})
		if rec.Code != http.StatusCreated {
			t.Errorf("create for %s through the proxy = %d, want 201", client, rec.Code)
		}
	}
}

const requestKey = "cHVibGljcHVibGljcHVibGljcHVibGljcHVibGljcHU"

// requestEnv opens a store holding the request "req", limited by mutate.
func requestEnv(t *testing.T, cfg config.Config, mutate func(*store.RequestRecord)) *sql.DB {
	t.Helper()
	db, err := store.Open(filepath.Join(t.TempDir(), "db.sqlite"))
	if err != nil {
		t.Fatalf("open store: %v", err)
	}
	t.Cleanup(func() { _ = db.Close() })
	rec := store.RequestRecord{
		Slug:             "req",
		PublicKey:        requestKey,
		CollectTokenHash: "aGFzaGhhc2hoYXNoaGFzaGhhc2hoYXNoaGFzaGhhc2g",
		CreatedAt:        1,
	}
	if mutate != nil {
		mutate(&rec)
	}
	if err := store.CreateRequest(db, rec); err != nil {
		t.Fatalf("create request: %v", err)
	}
	return db
}

func forRequest(key string) map[string]string {
	return map[string]string{RequestHeader: "req", RequestKeyHeader: key}
}

func TestTus_Protected_UploadToARequestNeedsNoPassword(t *testing.T) {
	cfg := protectedCfg(t, "s3cret")
	srv := newTestRouter(t, cfg, requestEnv(t, cfg, nil))

	rec := tusCreateFrom(srv, "203.0.113.7:1000", 11, forRequest(requestKey))
	if rec.Code != http.StatusCreated {
		t.Fatalf("create for a request = %d, want 201; body=%q", rec.Code, rec.Body.String())
	}
	req := httptest.NewRequest(http.MethodPatch, rec.Header().Get("Location"), strings.NewReader("hello world"))
	req.Header.Set("Tus-Resumable", "1.0.0")
	req.Header.Set("Upload-Offset", "0")
	req.Header.Set("Content-Type", "application/offset+octet-stream")
	for k, v := range forRequest(requestKey) {
		req.Header.Set(k, v)
	}
	patch := httptest.NewRecorder()
	srv.ServeHTTP(patch, req)
	if patch.Code != http.StatusNoContent {
		t.Fatalf("patch for a request = %d, want 204; body=%q", patch.Code, patch.Body.String())
	}
}

func TestTus_RequestUploadWithAWrongKeyIsRefused(t *testing.T) {
	cfg := protectedCfg(t, "s3cret")
	srv := newTestRouter(t, cfg, requestEnv(t, cfg, nil))

	for name, h := range map[string]map[string]string{
		"wrong key":       forRequest("d3JvbmdrZXl3cm9uZ2tleXdyb25na2V5d3JvbmdrZXk"),
		"no key":          {RequestHeader: "req"},
		"unknown request": {RequestHeader: "nosuch", RequestKeyHeader: requestKey},
	} {
		if rec := tusCreateFrom(srv, "203.0.113.7:1000", 11, h); rec.Code != http.StatusNotFound {
			t.Errorf("%s: create = %d, want 404", name, rec.Code)
		}
	}
	entries, _ := os.ReadDir(cfg.TmpDir)
	if len(entries) != 0 {
		t.Errorf("%d files written for refused creates", len(entries))
	}
}

func TestTus_RequestUploadKeepsToTheRequestsLimits(t *testing.T) {
	cfg := openCfg(t)
	max := int64(100)
	srv := newTestRouter(t, cfg, requestEnv(t, cfg, func(r *store.RequestRecord) { r.MaxSize = &max }))
	if rec := tusCreateFrom(srv, "203.0.113.7:1000", 101, forRequest(requestKey)); rec.Code != http.StatusRequestEntityTooLarge {
		t.Errorf("over the size cap = %d, want 413", rec.Code)
	}
	if rec := tusCreateFrom(srv, "203.0.113.7:1000", 100, forRequest(requestKey)); rec.Code != http.StatusCreated {
		t.Errorf("at the size cap = %d, want 201", rec.Code)
	}

	full := openCfg(t)
	one := int64(1)
	db := requestEnv(t, full, func(r *store.RequestRecord) { r.MaxUploads = &one })
	if _, err := store.AddRequestUpload(db, "req", store.RequestUpload{ID: "a", FileID: "f", Size: 1, SealedKey: []byte{1}}); err != nil {
		t.Fatal(err)
	}
	fullSrv := newTestRouter(t, full, db)
	if rec := tusCreateFrom(fullSrv, "203.0.113.7:1000", 11, forRequest(requestKey)); rec.Code != http.StatusGone {
		t.Errorf("full request = %d, want 410", rec.Code)
	}

	gone := openCfg(t)
	past := int64(1)
	goneSrv := newTestRouter(t, gone, requestEnv(t, gone, func(r *store.RequestRecord) { r.ExpiresAt = &past }))
	if rec := tusCreateFrom(goneSrv, "203.0.113.7:1000", 11, forRequest(requestKey)); rec.Code != http.StatusNotFound {
		t.Errorf("expired request = %d, want 404", rec.Code)
	}
}

func TestTus_RequestUploadCountsTowardsTheClientLimit(t *testing.T) {
	cfg := limitCfg(t, 20)
	srv := newTestRouter(t, cfg, requestEnv(t, cfg, nil))
	if rec := tusCreateFrom(srv, "203.0.113.7:1000", 11, forRequest(requestKey)); rec.Code != http.StatusCreated {
		t.Fatalf("first create = %d, want 201", rec.Code)
	}
	if rec := tusCreateFrom(srv, "203.0.113.7:1001", 11, forRequest(requestKey)); rec.Code != http.StatusTooManyRequests {
		t.Errorf("create past the client limit = %d, want 429", rec.Code)
	}
}
