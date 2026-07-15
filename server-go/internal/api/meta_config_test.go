package api

import (
	"bytes"
	"encoding/base64"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/junkerderprovinz/featherdrop/server-go/internal/store"
)

// metaRouter wires the meta route exactly as main.go does, so tests exercise the
// real chi {slug} URL-param routing.
func (e *testEnv) metaRouter(now func() time.Time) http.Handler {
	r := chi.NewRouter()
	r.Get("/api/d/{slug}/meta", MetaHandler(e.db, now))
	return r
}

// ---------------------------------------------------------------------------
// /api/d/{slug}/meta
// ---------------------------------------------------------------------------

func TestMeta_Format2Happy(t *testing.T) {
	e := newTestEnv(t)
	content := []byte("0123456789ABCDEF") // 16 bytes
	rawWrapped := bytes.Repeat([]byte{0xab}, 48)
	rawSalt := bytes.Repeat([]byte{0xcd}, 16)
	exp := int64(5_000_000)
	five := int64(5)
	slug := e.seedV2(t, content, func(r *store.FileRecord) {
		r.WrappedKey = rawWrapped
		r.KDFSalt = rawSalt
		r.ExpiresAt = &exp
		r.MaxDownloads = &five
	})

	req := httptest.NewRequest(http.MethodGet, "/api/d/"+slug+"/meta", nil)
	rec := httptest.NewRecorder()
	e.metaRouter(fixedNow(1000)).ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200 (body %s)", rec.Code, rec.Body.String())
	}

	var resp metaResponse
	decodeJSON(t, rec, &resp)
	if resp.Format != 2 {
		t.Fatalf("format = %d, want 2", resp.Format)
	}
	if resp.Size != int64(len(content)) {
		t.Fatalf("size = %d, want %d", resp.Size, len(content))
	}
	if resp.ExpiresAt == nil || *resp.ExpiresAt != exp {
		t.Fatalf("expiresAt = %v, want %d", resp.ExpiresAt, exp)
	}
	if !resp.HasPassword {
		t.Fatalf("hasPassword = false, want true (wrapped_key present)")
	}
	if resp.DownloadsLeft == nil || *resp.DownloadsLeft != 5 {
		t.Fatalf("downloadsLeft = %v, want 5", deref(resp.DownloadsLeft))
	}
	// base64 STD round-trip of the blobs (matches Buffer.toString("base64")).
	if resp.WrappedKey == nil || *resp.WrappedKey != base64.StdEncoding.EncodeToString(rawWrapped) {
		t.Fatalf("wrappedKey = %v, want STD base64 of wrapped blob", resp.WrappedKey)
	}
	gotWrapped, err := base64.StdEncoding.DecodeString(*resp.WrappedKey)
	if err != nil || !bytes.Equal(gotWrapped, rawWrapped) {
		t.Fatalf("wrappedKey base64 does not round-trip: %v", err)
	}
	if resp.KDFSalt == nil || *resp.KDFSalt != base64.StdEncoding.EncodeToString(rawSalt) {
		t.Fatalf("kdfSalt = %v, want STD base64 of salt", resp.KDFSalt)
	}
	gotSalt, err := base64.StdEncoding.DecodeString(*resp.KDFSalt)
	if err != nil || !bytes.Equal(gotSalt, rawSalt) {
		t.Fatalf("kdfSalt base64 does not round-trip: %v", err)
	}
}

func TestMeta_LinkMode_NullsAndUnlimited(t *testing.T) {
	// A link-mode share (no wrapped_key/kdf_salt, no limit, no expiry) must report
	// hasPassword=false and JSON null for wrappedKey/kdfSalt/expiresAt/downloadsLeft.
	e := newTestEnv(t)
	slug := e.seedV2(t, []byte("ciphertext"), nil)

	req := httptest.NewRequest(http.MethodGet, "/api/d/"+slug+"/meta", nil)
	rec := httptest.NewRecorder()
	e.metaRouter(nil).ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}

	// Decode into a generic map to assert the nullables serialize as JSON null and
	// that name/mime/keyVerifier are absent entirely (zero-knowledge).
	var m map[string]any
	decodeJSON(t, rec, &m)
	for _, k := range []string{"wrappedKey", "kdfSalt", "expiresAt", "downloadsLeft"} {
		v, ok := m[k]
		if !ok || v != nil {
			t.Fatalf("%s = %v (present=%v), want JSON null", k, v, ok)
		}
	}
	if hp, _ := m["hasPassword"].(bool); hp {
		t.Fatalf("hasPassword = true, want false")
	}
	for _, k := range []string{"name", "mime", "keyVerifier"} {
		if _, present := m[k]; present {
			t.Fatalf("%q must NOT be present in meta (zero-knowledge)", k)
		}
	}
}

func TestMeta_UnknownSlug_404(t *testing.T) {
	e := newTestEnv(t)
	req := httptest.NewRequest(http.MethodGet, "/api/d/nonexistent/meta", nil)
	rec := httptest.NewRecorder()
	e.metaRouter(nil).ServeHTTP(rec, req)
	if rec.Code != http.StatusNotFound {
		t.Fatalf("status = %d, want 404", rec.Code)
	}
	var body errorBody
	decodeJSON(t, rec, &body)
	if body.Error != "not found" {
		t.Fatalf("error = %q, want not found", body.Error)
	}
}

func TestMeta_Expired_404(t *testing.T) {
	e := newTestEnv(t)
	past := int64(1000)
	slug := e.seedV2(t, []byte("blob"), func(r *store.FileRecord) { r.ExpiresAt = &past })
	req := httptest.NewRequest(http.MethodGet, "/api/d/"+slug+"/meta", nil)
	rec := httptest.NewRecorder()
	e.metaRouter(fixedNow(2000)).ServeHTTP(rec, req)
	if rec.Code != http.StatusNotFound {
		t.Fatalf("status = %d, want 404", rec.Code)
	}
}

func TestMeta_Format1_404(t *testing.T) {
	// A legacy format-1 row is never exposed via the ZK meta endpoint.
	e := newTestEnv(t)
	slug := e.seedV2(t, []byte("legacy"), func(r *store.FileRecord) { r.Format = 1 })
	req := httptest.NewRequest(http.MethodGet, "/api/d/"+slug+"/meta", nil)
	rec := httptest.NewRecorder()
	e.metaRouter(nil).ServeHTTP(rec, req)
	if rec.Code != http.StatusNotFound {
		t.Fatalf("status = %d, want 404 (format-1 not exposed)", rec.Code)
	}
}

func TestMeta_NeverCounts(t *testing.T) {
	// meta is read-only: hitting it must never bump download_count or burn a
	// limited share.
	e := newTestEnv(t)
	one := int64(1)
	slug := e.seedV2(t, []byte("burn-me-only-on-download"), func(r *store.FileRecord) {
		r.MaxDownloads = &one
	})

	for i := 0; i < 3; i++ {
		req := httptest.NewRequest(http.MethodGet, "/api/d/"+slug+"/meta", nil)
		rec := httptest.NewRecorder()
		e.metaRouter(nil).ServeHTTP(rec, req)
		if rec.Code != http.StatusOK {
			t.Fatalf("hit %d status = %d, want 200", i, rec.Code)
		}
	}
	row, _ := store.GetFileBySlug(e.db, slug)
	if row == nil {
		t.Fatalf("meta must not burn the share")
	}
	if row.DownloadCount != 0 {
		t.Fatalf("download_count = %d, want 0 (meta never counts)", row.DownloadCount)
	}
}

// ---------------------------------------------------------------------------
// /api/config
// ---------------------------------------------------------------------------

func TestConfig_DefaultsShape(t *testing.T) {
	e := newTestEnv(t)
	// Branding env left empty -> resolveBranding defaults; BaseURL empty;
	// UploadProtected false (no UPLOAD_PASSWORD set on cfg).
	req := httptest.NewRequest(http.MethodGet, "/api/config", nil)
	rec := httptest.NewRecorder()
	ConfigHandler(e.cfg).ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200 (body %s)", rec.Code, rec.Body.String())
	}
	if ct := rec.Header().Get("Content-Type"); ct != "application/json" {
		t.Fatalf("Content-Type = %q", ct)
	}

	var resp configResponse
	decodeJSON(t, rec, &resp)
	if resp.BaseURL != "" {
		t.Fatalf("baseUrl = %q, want empty", resp.BaseURL)
	}
	if resp.UploadProtected {
		t.Fatalf("uploadProtected = true, want false")
	}
	if resp.MaxExpiry != "" {
		t.Fatalf("maxExpiry = %q, want empty (no cap)", resp.MaxExpiry)
	}
	if resp.Branding.AppName != "featherdrop" {
		t.Fatalf("branding.appName = %q, want featherdrop (default)", resp.Branding.AppName)
	}
	if resp.Branding.LogoURL != "" {
		t.Fatalf("branding.logoUrl = %q, want empty (default = no logo)", resp.Branding.LogoURL)
	}
	if resp.Branding.AccentColor != "#d4af37" {
		t.Fatalf("branding.accentColor = %q, want #d4af37 (default)", resp.Branding.AccentColor)
	}
}

func TestConfig_CustomBrandingAndBaseURL(t *testing.T) {
	e := newTestEnv(t)
	e.cfg.BaseURL = "https://drop.example.com"
	e.cfg.AppName = "  MyDrop  " // trimmed
	e.cfg.AppLogo = "https://cdn.example.com/logo.svg"
	e.cfg.AccentColor = "#AABBCC" // normalised to lowercase

	req := httptest.NewRequest(http.MethodGet, "/api/config", nil)
	rec := httptest.NewRecorder()
	ConfigHandler(e.cfg).ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	var resp configResponse
	decodeJSON(t, rec, &resp)
	if resp.BaseURL != "https://drop.example.com" {
		t.Fatalf("baseUrl = %q", resp.BaseURL)
	}
	if resp.Branding.AppName != "MyDrop" {
		t.Fatalf("branding.appName = %q, want MyDrop (trimmed)", resp.Branding.AppName)
	}
	if resp.Branding.LogoURL != "https://cdn.example.com/logo.svg" {
		t.Fatalf("branding.logoUrl = %q", resp.Branding.LogoURL)
	}
	if resp.Branding.AccentColor != "#aabbcc" {
		t.Fatalf("branding.accentColor = %q, want #aabbcc (lowercased)", resp.Branding.AccentColor)
	}
}

func TestConfig_MaxExpiryExposed(t *testing.T) {
	// A configured MAX_EXPIRY cap is surfaced as maxExpiry so the UI can hide
	// expiry options above it.
	e := newTestEnv(t)
	e.cfg.MaxExpiry = "7d"

	req := httptest.NewRequest(http.MethodGet, "/api/config", nil)
	rec := httptest.NewRecorder()
	ConfigHandler(e.cfg).ServeHTTP(rec, req)

	var resp configResponse
	decodeJSON(t, rec, &resp)
	if resp.MaxExpiry != "7d" {
		t.Fatalf("maxExpiry = %q, want 7d", resp.MaxExpiry)
	}
	// The raw JSON must carry the documented key name.
	var m map[string]any
	decodeJSON(t, rec, &m)
	if v, ok := m["maxExpiry"]; !ok || v != "7d" {
		t.Fatalf("maxExpiry key = %v (present=%v), want \"7d\"", v, ok)
	}
}

func TestConfig_UploadProtectedReflectsPassword(t *testing.T) {
	e := newTestEnv(t)
	e.cfg.UploadPassword = "s3cret"
	e.cfg.UploadProtected = true

	req := httptest.NewRequest(http.MethodGet, "/api/config", nil)
	rec := httptest.NewRecorder()
	ConfigHandler(e.cfg).ServeHTTP(rec, req)

	var resp configResponse
	decodeJSON(t, rec, &resp)
	if !resp.UploadProtected {
		t.Fatalf("uploadProtected = false, want true")
	}
}

func TestConfig_NoSecretsLeak(t *testing.T) {
	// The JSON must expose ONLY non-secret fields. The upload password must never
	// appear anywhere in the body, nor secret-named keys.
	e := newTestEnv(t)
	e.cfg.UploadPassword = "TOP-SECRET-PASSWORD"
	e.cfg.UploadProtected = true

	req := httptest.NewRequest(http.MethodGet, "/api/config", nil)
	rec := httptest.NewRecorder()
	ConfigHandler(e.cfg).ServeHTTP(rec, req)

	bodyStr := rec.Body.String()
	if bytes.Contains(rec.Body.Bytes(), []byte("TOP-SECRET-PASSWORD")) {
		t.Fatalf("config body leaked the upload password: %s", bodyStr)
	}

	// Assert the JSON has exactly the expected top-level keys (no secret-named
	// fields like uploadPassword/masterKey/token).
	var m map[string]any
	decodeJSON(t, rec, &m)
	allowed := map[string]bool{"baseUrl": true, "uploadProtected": true, "maxExpiry": true, "defaultExpiry": true, "branding": true}
	for k := range m {
		if !allowed[k] {
			t.Fatalf("unexpected top-level config field %q (possible secret leak)", k)
		}
	}
	for _, secret := range []string{"uploadPassword", "UPLOAD_PASSWORD", "masterKey", "MASTER_KEY", "token"} {
		if _, present := m[secret]; present {
			t.Fatalf("secret-named field %q present in config JSON", secret)
		}
	}
}

// ---------------------------------------------------------------------------
// /api/* catch-all (JSON 404 instead of the SPA HTML shell)
// ---------------------------------------------------------------------------

func TestNotFoundHandler_JSON404(t *testing.T) {
	// An unmatched /api path must yield a JSON 404, not the HTML SPA shell. Wire
	// it via chi exactly as main.go does (a /api/* catch-all after the real
	// routes) so the routing precedence is exercised too.
	r := chi.NewRouter()
	r.Get("/api/config", func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusOK) })
	r.HandleFunc("/api/*", NotFoundHandler())

	req := httptest.NewRequest(http.MethodGet, "/api/does-not-exist", nil)
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)

	if rec.Code != http.StatusNotFound {
		t.Fatalf("status = %d, want 404", rec.Code)
	}
	if ct := rec.Header().Get("Content-Type"); ct != "application/json" {
		t.Fatalf("Content-Type = %q, want application/json", ct)
	}
	var body errorBody
	decodeJSON(t, rec, &body)
	if body.Error != "not found" {
		t.Fatalf("error = %q, want not found", body.Error)
	}

	// A real registered route must still win over the catch-all.
	req = httptest.NewRequest(http.MethodGet, "/api/config", nil)
	rec = httptest.NewRecorder()
	r.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("registered route status = %d, want 200 (catch-all stole it)", rec.Code)
	}
}
