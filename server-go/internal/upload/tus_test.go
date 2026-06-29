package upload

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/go-chi/chi/v5"

	"github.com/junkerderprovinz/featherdrop/server-go/internal/config"
)

// newTestRouter builds a chi router mounting the tus handler exactly as main.go
// does, so the tests exercise the real routing for both "/files" and
// "/files/*".
func newTestRouter(t *testing.T, cfg config.Config) http.Handler {
	t.Helper()
	h, err := NewHandler(cfg)
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
	srv := newTestRouter(t, openCfg(t))

	rec := tusCreate(srv, "")
	if rec.Code != http.StatusCreated {
		t.Fatalf("POST /files (open) = %d, want 201; body=%q", rec.Code, rec.Body.String())
	}
	if loc := rec.Header().Get("Location"); loc == "" {
		t.Errorf("create response missing Location header")
	}
}

func TestTus_Open_Options(t *testing.T) {
	srv := newTestRouter(t, openCfg(t))

	rec := tusOptions(srv)
	if rec.Code != http.StatusNoContent && rec.Code != http.StatusOK {
		t.Fatalf("OPTIONS /files = %d, want 204 or 200; body=%q", rec.Code, rec.Body.String())
	}
	if rec.Header().Get("Tus-Resumable") == "" && rec.Header().Get("Tus-Version") == "" {
		t.Errorf("OPTIONS response missing Tus-Version/Tus-Resumable headers; headers=%v", rec.Header())
	}
}

func TestTus_Protected_CreateWithoutToken_401(t *testing.T) {
	srv := newTestRouter(t, protectedCfg(t, "s3cret"))

	rec := tusCreate(srv, "")
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("POST /files (protected, no token) = %d, want 401; body=%q", rec.Code, rec.Body.String())
	}
	if got := rec.Body.String(); got != "upload password required\n" {
		t.Errorf("401 body = %q, want %q", got, "upload password required\n")
	}
}

func TestTus_Protected_CreateWithWrongToken_401(t *testing.T) {
	srv := newTestRouter(t, protectedCfg(t, "s3cret"))

	rec := tusCreate(srv, "wrong")
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("POST /files (protected, wrong token) = %d, want 401; body=%q", rec.Code, rec.Body.String())
	}
}

func TestTus_Protected_CreateWithToken_201(t *testing.T) {
	srv := newTestRouter(t, protectedCfg(t, "s3cret"))

	rec := tusCreate(srv, "s3cret")
	if rec.Code != http.StatusCreated {
		t.Fatalf("POST /files (protected, correct token) = %d, want 201; body=%q", rec.Code, rec.Body.String())
	}
	if loc := rec.Header().Get("Location"); loc == "" {
		t.Errorf("create response missing Location header")
	}
}

func TestTus_Protected_OptionsNoToken_OK(t *testing.T) {
	srv := newTestRouter(t, protectedCfg(t, "s3cret"))

	rec := tusOptions(srv)
	if rec.Code != http.StatusNoContent && rec.Code != http.StatusOK {
		t.Fatalf("OPTIONS /files (protected, no token) = %d, want 204 or 200; body=%q", rec.Code, rec.Body.String())
	}
}
