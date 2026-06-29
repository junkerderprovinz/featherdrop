package upload

import (
	"net/http"

	"github.com/tus/tusd/v2/pkg/filestore"
	tushandler "github.com/tus/tusd/v2/pkg/handler"

	"github.com/junkerderprovinz/featherdrop/server-go/internal/config"
)

// BasePath is the URL prefix the tus protocol handler is mounted at. It mirrors
// server/tus.ts (`path: "/files"`). tusd requires a trailing slash.
const BasePath = "/files/"

// NewHandler builds the resumable upload (tus) handler, already wrapped with the
// upload gate so the returned http.Handler is safe to mount directly.
//
// Storage: a tusd filestore writes into cfg.TmpDir. Each upload becomes two
// artifacts in that directory:
//
//	cfg.TmpDir/<id>        the raw upload bytes
//	cfg.TmpDir/<id>.info   a JSON sidecar with the FileInfo (metadata, length…)
//
// A later finalize phase reads these and moves the file into cfg.UploadsDir.
// NOTE for the finalize phase: tusd's filestore uses an `<id>.info` sidecar,
// whereas the Node @tus/file-store wrote `<id>.json`. The bytes file (`<id>`)
// is identical; only the sidecar name/format differs. Finalize must read
// `<id>.info` (JSON, FileInfo shape) when running against this Go backend.
//
// MaxSize is enforced only when cfg.MaxFileSize > 0 (0 = unlimited).
// RespectForwardedHeaders is enabled because we run behind a reverse proxy, so
// the Location header in the create response reflects the public URL.
func NewHandler(cfg config.Config) (http.Handler, error) {
	store := filestore.New(cfg.TmpDir)

	composer := tushandler.NewStoreComposer()
	store.UseIn(composer)

	// Allow the upload-gate header on cross-origin preflight so a browser may
	// attach it. Same-origin requests don't preflight; harmless either way.
	// Mirrors server/tus.ts `allowedHeaders: [UPLOAD_TOKEN_HEADER]`.
	cors := tushandler.DefaultCorsConfig
	cors.AllowHeaders += ", " + UploadTokenHeader

	h, err := tushandler.NewHandler(tushandler.Config{
		BasePath:                BasePath,
		StoreComposer:           composer,
		MaxSize:                 cfg.MaxFileSize, // 0 => unlimited (tusd treats <=0 as no limit)
		RespectForwardedHeaders: true,
		Cors:                    &cors,
	})
	if err != nil {
		return nil, err
	}

	// tusd's routed handler matches the upload-create endpoint on an *empty*
	// path (it trims slashes off the request path), so it must be mounted with
	// the BasePath prefix stripped: a POST to "/files" or "/files/" becomes ""
	// (create), and "/files/<id>" becomes "<id>" (PATCH/HEAD/DELETE). BasePath
	// stays "/files/" in the tusd config so the Location header it returns is
	// still absolute and correct. Mirrors tusd's documented mounting:
	//
	//	http.Handle("/files/", http.StripPrefix("/files/", handler))
	//	http.Handle("/files",  http.StripPrefix("/files",  handler))
	stripped := stripBasePath(h)

	return uploadGate(cfg, stripped), nil
}

// stripBasePath removes the "/files" or "/files/" prefix from the request path
// before handing off to the tusd routed handler, which expects to see only the
// path relative to its BasePath. The trailing-slash form is checked first so a
// bare "/files" request also reaches the create endpoint as an empty path.
func stripBasePath(next http.Handler) http.Handler {
	withSlash := http.StripPrefix("/files/", next)
	noSlash := http.StripPrefix("/files", next)
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/files" {
			noSlash.ServeHTTP(w, r)
			return
		}
		withSlash.ServeHTTP(w, r)
	})
}

// uploadGate enforces the optional upload password on every tus write method.
//
// The OPTIONS preflight is never gated: browsers don't send custom headers on
// preflight, so requiring the token there would break CORS. tusd answers the
// preflight itself. Every other method (POST/PATCH/HEAD/GET/DELETE) must pass
// IsUploadAuthorized BEFORE reaching tusd, so an unauthorized request never
// creates an upload or writes any bytes. Mirrors server/tus.ts
// `onIncomingRequest`. The secret is never logged.
func uploadGate(cfg config.Config, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodOptions {
			next.ServeHTTP(w, r)
			return
		}
		token := r.Header.Get(UploadTokenHeader)
		if !IsUploadAuthorized(token, cfg.UploadProtected, cfg.UploadPassword) {
			w.Header().Set("Content-Type", "text/plain; charset=utf-8")
			w.WriteHeader(http.StatusUnauthorized)
			_, _ = w.Write([]byte("upload password required\n"))
			return
		}
		next.ServeHTTP(w, r)
	})
}
