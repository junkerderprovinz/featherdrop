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

// BasePath is where the tus handler is mounted; tusd requires the trailing
// slash.
const BasePath = "/files/"

// NewHandler builds the tus upload handler behind the upload gate and the
// storage quota gate, ready to mount. db may be nil when cfg.StorageQuota is 0.
//
// A tusd filestore writes each upload to cfg.TmpDir as <id> for the bytes and
// <id>.info for the JSON FileInfo sidecar; finalize moves the bytes to
// cfg.UploadsDir. RespectForwardedHeaders makes the Location header carry the
// public URL behind a reverse proxy.
func NewHandler(cfg config.Config, db *sql.DB) (http.Handler, error) {
	store := filestore.New(cfg.TmpDir)

	composer := tushandler.NewStoreComposer()
	store.UseIn(composer)

	// A cross-origin browser may only attach the upload token header if the
	// preflight allows it.
	cors := tushandler.DefaultCorsConfig
	cors.AllowHeaders += ", " + UploadTokenHeader

	h, err := tushandler.NewHandler(tushandler.Config{
		BasePath:                BasePath,
		StoreComposer:           composer,
		MaxSize:                 cfg.MaxFileSize, // tusd treats 0 as no limit
		RespectForwardedHeaders: true,
		Cors:                    &cors,
	})
	if err != nil {
		return nil, err
	}

	// The auth gate goes outermost so an unauthorized request learns nothing
	// about the quota.
	return uploadGate(cfg, quotaGate(cfg, db, stripBasePath(h))), nil
}

// stripBasePath removes the "/files" or "/files/" prefix before tusd sees the
// request. tusd matches the create endpoint on an empty path, while BasePath
// stays "/files/" in its config so the Location it returns is absolute. This is
// the mounting tusd documents.
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

// uploadGate checks the optional upload password before any tus method reaches
// tusd, so an unauthorized request never creates an upload or writes a byte.
// The OPTIONS preflight passes, because browsers send no custom headers on it.
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

// quotaGate refuses a tus create whose declared Upload-Length would push the
// stored shares past STORAGE_QUOTA, before any byte is accepted. Resumes pass,
// since tusd caps them at the declared length, and a deferred length cannot be
// judged here; finalize checks the real size in both cases. Uploads still in
// progress do not count toward the total.
//
// A store error lets the request through: blocking every upload on a transient
// database error is worse than admitting one too many, and finalize checks
// again before anything is published.
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
