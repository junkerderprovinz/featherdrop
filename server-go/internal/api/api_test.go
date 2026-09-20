package api

import (
	"bytes"
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/tus/tusd/v2/pkg/filestore"
	tushandler "github.com/tus/tusd/v2/pkg/handler"

	"github.com/junkerderprovinz/featherdrop/server-go/internal/config"
	"github.com/junkerderprovinz/featherdrop/server-go/internal/share"
	"github.com/junkerderprovinz/featherdrop/server-go/internal/store"
	"github.com/junkerderprovinz/featherdrop/server-go/internal/upload"
)

type testEnv struct {
	cfg config.Config
	db  *sql.DB
}

// newTestEnv builds a temp data dir and a real SQLite store with the schema
// applied.
func newTestEnv(t *testing.T) *testEnv {
	t.Helper()
	dataDir := t.TempDir()
	cfg := config.Config{
		DataDir:       dataDir,
		ConfigDir:     dataDir,
		UploadsDir:    filepath.Join(dataDir, "uploads"),
		TmpDir:        filepath.Join(dataDir, "tmp"),
		DBPath:        filepath.Join(dataDir, "db.sqlite"),
		DefaultExpiry: "7d",
	}
	if err := cfg.EnsureDataDirs(); err != nil {
		t.Fatalf("ensure data dirs: %v", err)
	}
	db, err := store.Open(cfg.DBPath)
	if err != nil {
		t.Fatalf("open store: %v", err)
	}
	t.Cleanup(func() { db.Close() })
	return &testEnv{cfg: cfg, db: db}
}

func fixedNow(ms int64) func() time.Time {
	return func() time.Time { return time.UnixMilli(ms) }
}

// makeTusUpload creates a real tusd filestore upload in cfg.TmpDir, bytes and
// .info sidecar, and returns its id.
func (e *testEnv) makeTusUpload(t *testing.T, content []byte) string {
	t.Helper()
	fs := filestore.New(e.cfg.TmpDir)
	up, err := fs.NewUpload(context.Background(), tushandler.FileInfo{
		Size: int64(len(content)),
		MetaData: tushandler.MetaData{
			"filename": "test.bin",
			"filetype": "application/octet-stream",
		},
	})
	if err != nil {
		t.Fatalf("new upload: %v", err)
	}
	if _, err := up.WriteChunk(context.Background(), 0, bytes.NewReader(content)); err != nil {
		t.Fatalf("write chunk: %v", err)
	}
	info, err := up.GetInfo(context.Background())
	if err != nil {
		t.Fatalf("get info: %v", err)
	}
	return info.ID
}

// router mounts the handlers on chi as main.go does, so URL params resolve.
func (e *testEnv) router(now func() time.Time) http.Handler {
	r := chi.NewRouter()
	r.Post("/api/finalize", FinalizeHandler(e.cfg, e.db, now))
	r.Get("/api/d/{slug}", DownloadHandler(e.cfg, e.db, now))
	return r
}

func (e *testEnv) finalize(t *testing.T, now func() time.Time, body map[string]any, headers map[string]string) *httptest.ResponseRecorder {
	t.Helper()
	raw, _ := json.Marshal(body)
	req := httptest.NewRequest(http.MethodPost, "/api/finalize", bytes.NewReader(raw))
	req.Header.Set("Content-Type", "application/json")
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	rec := httptest.NewRecorder()
	e.router(now).ServeHTTP(rec, req)
	return rec
}

// goodVerifier is a well-formed 43-character unpadded base64url key verifier.
const goodVerifier = "Zmh6rfhivXdsj8GLjp-OIAiXFIVu4jOzkCpZHQ1fKSU"

// deref returns the pointed-to value, or -1 for a nil pointer.
func deref(p *int64) int64 {
	if p == nil {
		return -1
	}
	return *p
}

func decodeJSON(t *testing.T, rec *httptest.ResponseRecorder, v any) {
	t.Helper()
	if err := json.Unmarshal(rec.Body.Bytes(), v); err != nil {
		t.Fatalf("decode JSON %q: %v", rec.Body.String(), err)
	}
}

func TestFinalize_GatedNoToken_401(t *testing.T) {
	e := newTestEnv(t)
	e.cfg.UploadProtected = true
	e.cfg.UploadPassword = "s3cret"
	id := e.makeTusUpload(t, []byte("encrypted blob"))

	rec := e.finalize(t, nil, map[string]any{"uploadId": id, "format": 2}, nil)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401", rec.Code)
	}
	var body errorBody
	decodeJSON(t, rec, &body)
	if body.Error != "upload password required" {
		t.Fatalf("error = %q, want %q", body.Error, "upload password required")
	}
	if _, err := os.Stat(filepath.Join(e.cfg.TmpDir, id)); err != nil {
		t.Fatalf("upload must survive a gated 401: %v", err)
	}
}

func TestFinalize_GatedWithToken_200(t *testing.T) {
	e := newTestEnv(t)
	e.cfg.UploadProtected = true
	e.cfg.UploadPassword = "s3cret"
	id := e.makeTusUpload(t, []byte("encrypted blob"))

	rec := e.finalize(t, nil, map[string]any{"uploadId": id, "format": 2},
		map[string]string{upload.UploadTokenHeader: "s3cret"})
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200 (body %s)", rec.Code, rec.Body.String())
	}
}

func TestFinalize_InvalidJSON_400(t *testing.T) {
	e := newTestEnv(t)
	req := httptest.NewRequest(http.MethodPost, "/api/finalize", strings.NewReader("{not json"))
	rec := httptest.NewRecorder()
	e.router(nil).ServeHTTP(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", rec.Code)
	}
	var body errorBody
	decodeJSON(t, rec, &body)
	if body.Error != "invalid JSON" {
		t.Fatalf("error = %q, want invalid JSON", body.Error)
	}
}

func TestFinalize_BadUploadId_400(t *testing.T) {
	e := newTestEnv(t)
	for _, bad := range []string{"", "../escape", "has/slash", "has..dots"} {
		rec := e.finalize(t, nil, map[string]any{"uploadId": bad, "format": 2}, nil)
		if rec.Code != http.StatusBadRequest {
			t.Fatalf("uploadId %q: status = %d, want 400", bad, rec.Code)
		}
		var body errorBody
		decodeJSON(t, rec, &body)
		if body.Error != "invalid uploadId" {
			t.Fatalf("uploadId %q: error = %q, want invalid uploadId", bad, body.Error)
		}
	}
}

func TestFinalize_BadExpiry_400(t *testing.T) {
	e := newTestEnv(t)
	id := e.makeTusUpload(t, []byte("blob"))
	rec := e.finalize(t, nil, map[string]any{"uploadId": id, "format": 2, "expiry": "99y"}, nil)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", rec.Code)
	}
	var body errorBody
	decodeJSON(t, rec, &body)
	if body.Error != "invalid expiry" {
		t.Fatalf("error = %q, want invalid expiry", body.Error)
	}
	if _, err := os.Stat(filepath.Join(e.cfg.TmpDir, id)); err != nil {
		t.Fatalf("upload must survive a 400: %v", err)
	}
}

func TestFinalize_BadKeyVerifier_400(t *testing.T) {
	e := newTestEnv(t)
	id := e.makeTusUpload(t, []byte("blob"))
	rec := e.finalize(t, nil, map[string]any{"uploadId": id, "format": 2, "keyVerifier": "too-short"}, nil)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", rec.Code)
	}
	var body errorBody
	decodeJSON(t, rec, &body)
	if body.Error != "invalid keyVerifier" {
		t.Fatalf("error = %q, want invalid keyVerifier", body.Error)
	}
}

func TestFinalize_UnsupportedFormat_400(t *testing.T) {
	e := newTestEnv(t)
	for _, body := range []map[string]any{
		{"uploadId": e.makeTusUpload(t, []byte("blob"))},
		{"uploadId": e.makeTusUpload(t, []byte("blob")), "format": 1},
	} {
		rec := e.finalize(t, nil, body, nil)
		if rec.Code != http.StatusBadRequest {
			t.Fatalf("body %v: status = %d, want 400", body, rec.Code)
		}
		var eb errorBody
		decodeJSON(t, rec, &eb)
		if eb.Error != "unsupported format (this server is zero-knowledge only)" {
			t.Fatalf("error = %q", eb.Error)
		}
	}
}

func TestFinalize_KeyVerifierExplicitNull_400(t *testing.T) {
	e := newTestEnv(t)
	id := e.makeTusUpload(t, []byte("blob"))
	rec := e.finalize(t, nil, map[string]any{"uploadId": id, "format": 2, "keyVerifier": nil}, nil)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400 (explicit null keyVerifier)", rec.Code)
	}
	var body errorBody
	decodeJSON(t, rec, &body)
	if body.Error != "invalid keyVerifier" {
		t.Fatalf("error = %q, want invalid keyVerifier", body.Error)
	}
	if _, err := os.Stat(filepath.Join(e.cfg.TmpDir, id)); err != nil {
		t.Fatalf("upload must survive a 400: %v", err)
	}
}

func TestFinalize_KeyVerifierAbsent_200_NoVerifierShare(t *testing.T) {
	e := newTestEnv(t)
	id := e.makeTusUpload(t, []byte("blob"))
	rec := e.finalize(t, nil, map[string]any{"uploadId": id, "format": 2}, nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200 (body %s)", rec.Code, rec.Body.String())
	}
	var resp finalizeResponse
	decodeJSON(t, rec, &resp)
	row, _ := store.GetFileBySlug(e.db, resp.Slug)
	if row == nil || row.KeyVerifier != nil {
		t.Fatalf("absent keyVerifier must store NULL, got %+v", row)
	}
}

func TestFinalize_UploadNotFound_404(t *testing.T) {
	e := newTestEnv(t)
	rec := e.finalize(t, nil, map[string]any{"uploadId": "nonexistent-id", "format": 2}, nil)
	if rec.Code != http.StatusNotFound {
		t.Fatalf("status = %d, want 404", rec.Code)
	}
	var body errorBody
	decodeJSON(t, rec, &body)
	if body.Error != "upload not found" {
		t.Fatalf("error = %q, want upload not found", body.Error)
	}
}

func TestFinalize_Incomplete_409(t *testing.T) {
	e := newTestEnv(t)
	// Declares 100 bytes and writes 10.
	fs := filestore.New(e.cfg.TmpDir)
	up, err := fs.NewUpload(context.Background(), tushandler.FileInfo{Size: 100})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := up.WriteChunk(context.Background(), 0, bytes.NewReader([]byte("0123456789"))); err != nil {
		t.Fatal(err)
	}
	info, _ := up.GetInfo(context.Background())

	rec := e.finalize(t, nil, map[string]any{"uploadId": info.ID, "format": 2}, nil)
	if rec.Code != http.StatusConflict {
		t.Fatalf("status = %d, want 409 (body %s)", rec.Code, rec.Body.String())
	}
	var body errorBody
	decodeJSON(t, rec, &body)
	if body.Error != "upload not complete" {
		t.Fatalf("error = %q, want upload not complete", body.Error)
	}
}

func TestFinalize_Format2Happy(t *testing.T) {
	e := newTestEnv(t)
	content := []byte("fake encrypted content for link mode")
	id := e.makeTusUpload(t, content)

	now := fixedNow(1_000_000_000_000)
	rec := e.finalize(t, now, map[string]any{"uploadId": id, "format": 2, "keyVerifier": goodVerifier}, nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200 (body %s)", rec.Code, rec.Body.String())
	}
	var resp finalizeResponse
	decodeJSON(t, rec, &resp)
	if resp.Slug == "" {
		t.Fatalf("response missing slug: %+v", resp)
	}
	var raw map[string]any
	decodeJSON(t, rec, &raw)
	if _, ok := raw["manageToken"]; ok {
		t.Fatalf("response must not include manageToken: %s", rec.Body.String())
	}

	storedPath := filepath.Join(e.cfg.UploadsDir, id)
	if _, err := os.Stat(storedPath); err != nil {
		t.Fatalf("blob must exist in uploads: %v", err)
	}
	if _, err := os.Stat(filepath.Join(e.cfg.TmpDir, id)); !os.IsNotExist(err) {
		t.Fatalf("blob must not remain in tmp")
	}
	if _, err := os.Stat(filepath.Join(e.cfg.TmpDir, id+".info")); !os.IsNotExist(err) {
		t.Fatalf("sidecar must be removed")
	}

	row, err := store.GetFileBySlug(e.db, resp.Slug)
	if err != nil || row == nil {
		t.Fatalf("row must exist: %v", err)
	}
	if row.Format != 2 {
		t.Fatalf("format = %d, want 2", row.Format)
	}
	if row.Size != int64(len(content)) {
		t.Fatalf("size = %d, want %d", row.Size, len(content))
	}
	if row.OriginalName != "" || row.Mime != nil || row.PasswordHash != nil {
		t.Fatalf("ZK row must not store name/mime/password")
	}
	if row.WrappedKey != nil || row.KDFSalt != nil {
		t.Fatalf("link mode: wrapped_key/kdf_salt must be null")
	}
	if row.KeyVerifier == nil || *row.KeyVerifier != goodVerifier {
		t.Fatalf("key_verifier mismatch: %v", row.KeyVerifier)
	}
	if row.ManageTokenHash != nil {
		t.Fatalf("manage_token_hash must be NULL, got %q", *row.ManageTokenHash)
	}
	wantExp := int64(1_000_000_000_000) + 7*24*60*60*1000
	if row.ExpiresAt == nil || *row.ExpiresAt != wantExp {
		t.Fatalf("expires_at = %v, want %d", row.ExpiresAt, wantExp)
	}
}

func TestFinalize_PasswordMode_DecodesBlobs(t *testing.T) {
	e := newTestEnv(t)
	id := e.makeTusUpload(t, []byte("encrypted content for password mode"))

	rawWrapped := bytes.Repeat([]byte{0xab}, 48)
	rawSalt := bytes.Repeat([]byte{0xcd}, 16)
	rec := e.finalize(t, nil, map[string]any{
		"uploadId":   id,
		"format":     2,
		"wrappedKey": base64.StdEncoding.EncodeToString(rawWrapped),
		"kdfSalt":    base64.StdEncoding.EncodeToString(rawSalt),
	}, nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200 (body %s)", rec.Code, rec.Body.String())
	}
	var resp finalizeResponse
	decodeJSON(t, rec, &resp)
	row, _ := store.GetFileBySlug(e.db, resp.Slug)
	if !bytes.Equal(row.WrappedKey, rawWrapped) {
		t.Fatalf("wrapped_key bytes mismatch")
	}
	if !bytes.Equal(row.KDFSalt, rawSalt) {
		t.Fatalf("kdf_salt bytes mismatch")
	}
}

func TestFinalize_Format3_NeverExpiry_Limited(t *testing.T) {
	e := newTestEnv(t)
	id := e.makeTusUpload(t, []byte("multi-file manifest blob"))
	limit := 3
	rec := e.finalize(t, nil, map[string]any{
		"uploadId": id, "format": 3, "expiry": "never", "maxDownloads": limit,
	}, nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200 (body %s)", rec.Code, rec.Body.String())
	}
	var resp finalizeResponse
	decodeJSON(t, rec, &resp)
	row, _ := store.GetFileBySlug(e.db, resp.Slug)
	if row.Format != 3 {
		t.Fatalf("format = %d, want 3", row.Format)
	}
	if row.ExpiresAt != nil {
		t.Fatalf("never expiry must store NULL, got %v", *row.ExpiresAt)
	}
	if row.MaxDownloads == nil || *row.MaxDownloads != 3 {
		t.Fatalf("max_downloads = %v, want 3", row.MaxDownloads)
	}
}

// seedV2 inserts a format 2 share row, writes its blob to uploads and returns
// the slug.
func (e *testEnv) seedV2(t *testing.T, content []byte, mutate func(*store.FileRecord)) string {
	t.Helper()
	id := fmt.Sprintf("seed-%d-%d", time.Now().UnixNano(), len(content))
	slug := share.NewSlug()
	rec := store.FileRecord{
		ID:        id,
		Slug:      slug,
		Size:      int64(len(content)),
		CreatedAt: time.Now().UnixMilli(),
		Format:    2,
	}
	if mutate != nil {
		mutate(&rec)
	}
	if err := os.WriteFile(filepath.Join(e.cfg.UploadsDir, id), content, 0o644); err != nil {
		t.Fatalf("write blob: %v", err)
	}
	if err := store.CreateFileRecord(e.db, rec); err != nil {
		t.Fatalf("create record: %v", err)
	}
	return slug
}

func TestDownload_UnknownSlug_404(t *testing.T) {
	e := newTestEnv(t)
	req := httptest.NewRequest(http.MethodGet, "/api/d/nonexistent", nil)
	rec := httptest.NewRecorder()
	e.router(nil).ServeHTTP(rec, req)
	if rec.Code != http.StatusNotFound {
		t.Fatalf("status = %d, want 404", rec.Code)
	}
	var body errorBody
	decodeJSON(t, rec, &body)
	if body.Error != "not found" {
		t.Fatalf("error = %q, want not found", body.Error)
	}
}

func TestDownload_Expired_404(t *testing.T) {
	e := newTestEnv(t)
	past := int64(1000)
	slug := e.seedV2(t, []byte("blob"), func(r *store.FileRecord) { r.ExpiresAt = &past })
	req := httptest.NewRequest(http.MethodGet, "/api/d/"+slug, nil)
	rec := httptest.NewRecorder()
	e.router(fixedNow(2000)).ServeHTTP(rec, req)
	if rec.Code != http.StatusNotFound {
		t.Fatalf("status = %d, want 404", rec.Code)
	}
}

func TestDownload_MissingBlob_404(t *testing.T) {
	e := newTestEnv(t)
	slug := e.seedV2(t, []byte("blob"), nil)
	row, _ := store.GetFileBySlug(e.db, slug)
	if err := os.Remove(filepath.Join(e.cfg.UploadsDir, row.ID)); err != nil {
		t.Fatal(err)
	}
	req := httptest.NewRequest(http.MethodGet, "/api/d/"+slug, nil)
	rec := httptest.NewRecorder()
	e.router(nil).ServeHTTP(rec, req)
	if rec.Code != http.StatusNotFound {
		t.Fatalf("status = %d, want 404", rec.Code)
	}
}

func TestDownload_Format1_404_NotServedOrBurned(t *testing.T) {
	e := newTestEnv(t)
	content := []byte("legacy age ciphertext that must not be served")
	one := int64(1)
	slug := e.seedV2(t, content, func(r *store.FileRecord) {
		r.Format = 1
		r.MaxDownloads = &one // would burn if wrongly counted
	})
	req := httptest.NewRequest(http.MethodGet, "/api/d/"+slug, nil)
	rec := httptest.NewRecorder()
	e.router(nil).ServeHTTP(rec, req)
	if rec.Code != http.StatusNotFound {
		t.Fatalf("status = %d, want 404 (format-1 not served via ZK path)", rec.Code)
	}
	if rec.Body.Len() > 0 && bytes.Equal(rec.Body.Bytes(), content) {
		t.Fatalf("format-1 ciphertext must not be streamed")
	}
	row, _ := store.GetFileBySlug(e.db, slug)
	if row == nil {
		t.Fatalf("format-1 row must not be burned by a download attempt")
	}
	if row.DownloadCount != 0 {
		t.Fatalf("format-1 download_count = %d, want 0 (never counted)", row.DownloadCount)
	}
}

func TestDownload_MissingKeyVerifier_401(t *testing.T) {
	e := newTestEnv(t)
	v := goodVerifier
	slug := e.seedV2(t, []byte("blob"), func(r *store.FileRecord) { r.KeyVerifier = &v })
	req := httptest.NewRequest(http.MethodGet, "/api/d/"+slug, nil)
	rec := httptest.NewRecorder()
	e.router(nil).ServeHTTP(rec, req)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401", rec.Code)
	}
	var body errorBody
	decodeJSON(t, rec, &body)
	if body.Error != "unauthorized" {
		t.Fatalf("error = %q, want unauthorized", body.Error)
	}
}

func TestDownload_WrongKeyVerifier_401(t *testing.T) {
	e := newTestEnv(t)
	v := goodVerifier
	slug := e.seedV2(t, []byte("blob"), func(r *store.FileRecord) { r.KeyVerifier = &v })
	req := httptest.NewRequest(http.MethodGet, "/api/d/"+slug, nil)
	req.Header.Set(keyVerifierHeader, "wrongwrongwrongwrongwrongwrongwrongwrongwro") // 43 chars
	rec := httptest.NewRecorder()
	e.router(nil).ServeHTTP(rec, req)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401", rec.Code)
	}
}

func TestDownload_Counted_200(t *testing.T) {
	e := newTestEnv(t)
	content := []byte("the encrypted ciphertext payload")
	v := goodVerifier
	slug := e.seedV2(t, content, func(r *store.FileRecord) { r.KeyVerifier = &v })

	req := httptest.NewRequest(http.MethodGet, "/api/d/"+slug, nil)
	req.Header.Set(keyVerifierHeader, v)
	rec := httptest.NewRecorder()
	e.router(nil).ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	if ct := rec.Header().Get("Content-Type"); ct != "application/octet-stream" {
		t.Fatalf("Content-Type = %q", ct)
	}
	if cd := rec.Header().Get("Content-Disposition"); cd != `attachment; filename="download"` {
		t.Fatalf("Content-Disposition = %q", cd)
	}
	if rec.Header().Get("X-Content-Type-Options") != "nosniff" {
		t.Fatalf("missing nosniff")
	}
	if rec.Header().Get("Cache-Control") != "private, no-store" {
		t.Fatalf("Cache-Control = %q", rec.Header().Get("Cache-Control"))
	}
	if cl := rec.Header().Get("Content-Length"); cl != strconv.Itoa(len(content)) {
		t.Fatalf("Content-Length = %q, want %d", cl, len(content))
	}
	if !bytes.Equal(rec.Body.Bytes(), content) {
		t.Fatalf("body mismatch")
	}
	row, _ := store.GetFileBySlug(e.db, slug)
	if row.DownloadCount != 1 {
		t.Fatalf("download_count = %d, want 1", row.DownloadCount)
	}
}

func TestDownload_NoVerifierShare_200(t *testing.T) {
	e := newTestEnv(t)
	content := []byte("legacy no-verifier ciphertext")
	slug := e.seedV2(t, content, nil)
	req := httptest.NewRequest(http.MethodGet, "/api/d/"+slug, nil)
	rec := httptest.NewRecorder()
	e.router(nil).ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	if !bytes.Equal(rec.Body.Bytes(), content) {
		t.Fatalf("body mismatch")
	}
}

func TestDownload_BurnDeletesBlob(t *testing.T) {
	e := newTestEnv(t)
	content := []byte("burn me after one download")
	one := int64(1)
	slug := e.seedV2(t, content, func(r *store.FileRecord) { r.MaxDownloads = &one })
	row, _ := store.GetFileBySlug(e.db, slug)
	blobPath := filepath.Join(e.cfg.UploadsDir, row.ID)

	req := httptest.NewRequest(http.MethodGet, "/api/d/"+slug, nil)
	rec := httptest.NewRecorder()
	e.router(nil).ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	if !bytes.Equal(rec.Body.Bytes(), content) {
		t.Fatalf("body mismatch")
	}
	if _, err := os.Stat(blobPath); !os.IsNotExist(err) {
		t.Fatalf("blob must be burned from disk")
	}
	if r, _ := store.GetFileBySlug(e.db, slug); r != nil {
		t.Fatalf("row must be deleted after burn")
	}

	rec2 := httptest.NewRecorder()
	e.router(nil).ServeHTTP(rec2, httptest.NewRequest(http.MethodGet, "/api/d/"+slug, nil))
	if rec2.Code != http.StatusNotFound {
		t.Fatalf("second download status = %d, want 404", rec2.Code)
	}
}

func TestDownload_Preview_Range_206(t *testing.T) {
	e := newTestEnv(t)
	content := []byte("0123456789ABCDEFGHIJ")
	slug := e.seedV2(t, content, nil)

	req := httptest.NewRequest(http.MethodGet, "/api/d/"+slug+"?preview=1", nil)
	req.Header.Set("Range", "bytes=5-9")
	rec := httptest.NewRecorder()
	e.router(nil).ServeHTTP(rec, req)
	if rec.Code != http.StatusPartialContent {
		t.Fatalf("status = %d, want 206", rec.Code)
	}
	if cr := rec.Header().Get("Content-Range"); cr != "bytes 5-9/20" {
		t.Fatalf("Content-Range = %q, want bytes 5-9/20", cr)
	}
	if cl := rec.Header().Get("Content-Length"); cl != "5" {
		t.Fatalf("Content-Length = %q, want 5", cl)
	}
	if rec.Header().Get("Accept-Ranges") != "bytes" {
		t.Fatalf("missing Accept-Ranges")
	}
	if got := rec.Body.String(); got != "56789" {
		t.Fatalf("body = %q, want 56789", got)
	}
	row, _ := store.GetFileBySlug(e.db, slug)
	if row.DownloadCount != 0 {
		t.Fatalf("preview must not count, download_count = %d", row.DownloadCount)
	}
}

func TestDownload_Preview_SuffixRange_206(t *testing.T) {
	e := newTestEnv(t)
	content := []byte("0123456789ABCDEFGHIJ")
	slug := e.seedV2(t, content, nil)

	req := httptest.NewRequest(http.MethodGet, "/api/d/"+slug+"?preview=1", nil)
	req.Header.Set("Range", "bytes=-4")
	rec := httptest.NewRecorder()
	e.router(nil).ServeHTTP(rec, req)
	if rec.Code != http.StatusPartialContent {
		t.Fatalf("status = %d, want 206", rec.Code)
	}
	if cr := rec.Header().Get("Content-Range"); cr != "bytes 16-19/20" {
		t.Fatalf("Content-Range = %q, want bytes 16-19/20", cr)
	}
	if got := rec.Body.String(); got != "GHIJ" {
		t.Fatalf("body = %q, want GHIJ", got)
	}
}

func TestDownload_Preview_Unsatisfiable_416(t *testing.T) {
	e := newTestEnv(t)
	content := []byte("0123456789")
	slug := e.seedV2(t, content, nil)

	req := httptest.NewRequest(http.MethodGet, "/api/d/"+slug+"?preview=1", nil)
	req.Header.Set("Range", "bytes=50-99")
	rec := httptest.NewRecorder()
	e.router(nil).ServeHTTP(rec, req)
	if rec.Code != http.StatusRequestedRangeNotSatisfiable {
		t.Fatalf("status = %d, want 416", rec.Code)
	}
	if cr := rec.Header().Get("Content-Range"); cr != "bytes */10" {
		t.Fatalf("Content-Range = %q, want bytes */10", cr)
	}
}

func TestDownload_Preview_WholeWhenNoRange_200(t *testing.T) {
	e := newTestEnv(t)
	content := []byte("whole preview body")
	slug := e.seedV2(t, content, nil)

	req := httptest.NewRequest(http.MethodGet, "/api/d/"+slug+"?preview=1", nil)
	rec := httptest.NewRecorder()
	e.router(nil).ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	if cl := rec.Header().Get("Content-Length"); cl != strconv.Itoa(len(content)) {
		t.Fatalf("Content-Length = %q", cl)
	}
	if !bytes.Equal(rec.Body.Bytes(), content) {
		t.Fatalf("body mismatch")
	}
}

func TestDownload_Preview_LimitedShare_404(t *testing.T) {
	e := newTestEnv(t)
	five := int64(5)
	slug := e.seedV2(t, []byte("limited"), func(r *store.FileRecord) { r.MaxDownloads = &five })

	req := httptest.NewRequest(http.MethodGet, "/api/d/"+slug+"?preview=1", nil)
	rec := httptest.NewRecorder()
	e.router(nil).ServeHTTP(rec, req)
	if rec.Code != http.StatusNotFound {
		t.Fatalf("status = %d, want 404", rec.Code)
	}
	row, _ := store.GetFileBySlug(e.db, slug)
	if row.DownloadCount != 0 {
		t.Fatalf("download_count = %d, want 0", row.DownloadCount)
	}
}

func TestDownload_Preview_RequiresVerifier_401(t *testing.T) {
	e := newTestEnv(t)
	v := goodVerifier
	slug := e.seedV2(t, []byte("blob"), func(r *store.FileRecord) { r.KeyVerifier = &v })
	req := httptest.NewRequest(http.MethodGet, "/api/d/"+slug+"?preview=1", nil)
	rec := httptest.NewRecorder()
	e.router(nil).ServeHTTP(rec, req)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401 (preview still requires the verifier)", rec.Code)
	}
}

func TestEndToEnd_UploadFinalizeDownloadDelete(t *testing.T) {
	e := newTestEnv(t)

	tusHandler, err := upload.NewHandler(e.cfg, e.db)
	if err != nil {
		t.Fatal(err)
	}
	srv := httptest.NewServer(tusHandler)
	defer srv.Close()

	content := []byte("end-to-end encrypted ciphertext blob")
	keyBytes := []byte("a-32-byte-content-key-aaaaaaaaaa")
	sum := sha256.Sum256(keyBytes)
	verifier := base64.RawURLEncoding.EncodeToString(sum[:])

	createReq, _ := http.NewRequest(http.MethodPost, srv.URL+"/files", nil)
	createReq.Header.Set("Tus-Resumable", "1.0.0")
	createReq.Header.Set("Upload-Length", strconv.Itoa(len(content)))
	createResp, err := http.DefaultClient.Do(createReq)
	if err != nil {
		t.Fatal(err)
	}
	loc := createResp.Header.Get("Location")
	createResp.Body.Close()
	if createResp.StatusCode != http.StatusCreated {
		t.Fatalf("tus create status = %d", createResp.StatusCode)
	}

	patchReq, _ := http.NewRequest(http.MethodPatch, loc, bytes.NewReader(content))
	patchReq.Header.Set("Tus-Resumable", "1.0.0")
	patchReq.Header.Set("Upload-Offset", "0")
	patchReq.Header.Set("Content-Type", "application/offset+octet-stream")
	patchResp, err := http.DefaultClient.Do(patchReq)
	if err != nil {
		t.Fatal(err)
	}
	patchResp.Body.Close()
	if patchResp.StatusCode != http.StatusNoContent {
		t.Fatalf("tus patch status = %d", patchResp.StatusCode)
	}

	uploadID := loc[strings.LastIndex(loc, "/")+1:]

	// With one allowed download, the download below also removes the share.
	apiRouter := e.router(nil)
	finRec := e.finalize(t, nil, map[string]any{
		"uploadId": uploadID, "format": 2, "keyVerifier": verifier, "maxDownloads": 1,
	}, nil)
	if finRec.Code != http.StatusOK {
		t.Fatalf("finalize status = %d (body %s)", finRec.Code, finRec.Body.String())
	}
	var fin finalizeResponse
	decodeJSON(t, finRec, &fin)

	dlReq := httptest.NewRequest(http.MethodGet, "/api/d/"+fin.Slug, nil)
	dlReq.Header.Set(keyVerifierHeader, verifier)
	dlRec := httptest.NewRecorder()
	apiRouter.ServeHTTP(dlRec, dlReq)
	if dlRec.Code != http.StatusOK {
		t.Fatalf("download status = %d", dlRec.Code)
	}
	if !bytes.Equal(dlRec.Body.Bytes(), content) {
		t.Fatalf("downloaded bytes do not match uploaded ciphertext")
	}

	after := httptest.NewRecorder()
	afterReq := httptest.NewRequest(http.MethodGet, "/api/d/"+fin.Slug, nil)
	afterReq.Header.Set(keyVerifierHeader, verifier)
	apiRouter.ServeHTTP(after, afterReq)
	if after.Code != http.StatusNotFound {
		t.Fatalf("post-burn download status = %d, want 404", after.Code)
	}

	if _, err := os.Stat(filepath.Join(e.cfg.UploadsDir, uploadID)); !os.IsNotExist(err) {
		t.Fatalf("blob must be removed after burn-after-download")
	}
}

func TestParseByteRange(t *testing.T) {
	const size = int64(20)
	cases := []struct {
		header string
		want   byteRange
	}{
		{"", byteRange{none: true}},
		{"bytes=0-9", byteRange{start: 0, end: 9}},
		{"bytes=5-", byteRange{start: 5, end: 19}},
		{"bytes=-4", byteRange{start: 16, end: 19}},
		{"bytes=-0", byteRange{none: true}},
		{"bytes=-100", byteRange{start: 0, end: 19}},
		{"bytes=10-100", byteRange{start: 10, end: 19}},
		{"bytes=20-25", byteRange{unsatisfiable: true}},
		{"bytes=9-5", byteRange{unsatisfiable: true}},
		{"not-a-range", byteRange{none: true}},
		{"bytes=abc-def", byteRange{none: true}},
		// Bounds past int64 behave like bounds past the file size.
		{"bytes=99999999999999999999-", byteRange{unsatisfiable: true}},
		{"bytes=-99999999999999999999", byteRange{start: 0, end: 19}},
		{"bytes=10-99999999999999999999", byteRange{start: 10, end: 19}},
	}
	for _, c := range cases {
		got := parseByteRange(c.header, size)
		if got != c.want {
			t.Errorf("parseByteRange(%q) = %+v, want %+v", c.header, got, c.want)
		}
	}
}
