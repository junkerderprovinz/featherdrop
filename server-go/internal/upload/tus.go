package upload

import (
	"database/sql"
	"net/http"
	"strconv"

	"github.com/tus/tusd/v2/pkg/filestore"
	tushandler "github.com/tus/tusd/v2/pkg/handler"

	"github.com/junkerderprovinz/featherdrop/server-go/internal/config"
	"github.com/junkerderprovinz/featherdrop/server-go/internal/store"
)

// BasePath is the URL prefix the tus protocol handler is mounted at. It mirrors
// server/tus.ts (`path: "/files"`). tusd requires a trailing slash.
const BasePath = "/files/"

// NewHandler builds the resumable upload (tus) handler, already wrapped with
// the upload gate and the storage-quota gate so the returned http.Handler is
// safe to mount directly. db is the metadata store the quota gate sums stored
// share sizes from; it may be nil when cfg.StorageQuota is 0 (unlimited).
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
func NewHandler(cfg config.Config, db *sql.DB) (http.Handler, error) {
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

	// Gate order: auth OUTERMOST so an unauthorized request learns nothing
	// about the quota state, then the quota gate, then tusd itself.
	return uploadGate(cfg, quotaGate(cfg, db, stripped)), nil
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

// quotaGate enforces the optional STORAGE_QUOTA on tus upload creation.
//
// Only the create POST is checked: it carries the declared Upload-Length, so a
// too-large upload is refused BEFORE any byte is accepted, with 507 and the
// uniform {"error":..} JSON body of internal/api/respond.go. PATCH/HEAD pass
// through untouched (tusd already caps them at the declared length), and a
// deferred-length create (no Upload-Length) cannot be judged here — finalize
// re-checks the ACTUAL on-disk size against the quota, so nothing is published
// over it either way. The sum counts finalized shares only (the files table);
// in-flight tmp bytes are not counted, matching "sum of stored share sizes".
//
// The gate FAILS OPEN on a store error: blocking every upload on a transient
// DB hiccup would be worse than momentarily over-admitting, and the finalize
// re-check still stands between an admitted upload and published storage.
func quotaGate(cfg config.Config, db *sql.DB, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if cfg.StorageQuota > 0 && db != nil && r.Method == http.MethodPost {
			length, err := strconv.ParseInt(r.Header.Get("Upload-Length"), 10, 64)
			if err == nil && length > 0 {
				used, err := store.TotalStoredSize(db)
				if err == nil && used+length > cfg.StorageQuota {
					w.Header().Set("Content-Type", "application/json")
					w.WriteHeader(http.StatusInsufficientStorage)
					_, _ = w.Write([]byte(`{"error":"storage quota exceeded"}`))
					return
				}
			}
		}
		next.ServeHTTP(w, r)
	})
}
