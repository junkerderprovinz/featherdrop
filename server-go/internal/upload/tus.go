package upload

import (
	"database/sql"
	"io"
	"math"
	"net/http"
	"os"
	"strconv"
	"time"

	"github.com/tus/tusd/v2/pkg/filestore"
	tushandler "github.com/tus/tusd/v2/pkg/handler"
	"golang.org/x/exp/slog"

	"github.com/junkerderprovinz/featherdrop/server-go/internal/clientip"
	"github.com/junkerderprovinz/featherdrop/server-go/internal/config"
	"github.com/junkerderprovinz/featherdrop/server-go/internal/share"
	"github.com/junkerderprovinz/featherdrop/server-go/internal/store"
	"github.com/junkerderprovinz/featherdrop/server-go/internal/uploadcap"
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
	return newHandler(cfg, db, os.Stderr)
}

// newHandler builds the handler with tusd logging to logs. tusd logs every
// request with its upload id and size at info level, which would put a trail
// of every share into the container log, so only errors get through.
func newHandler(cfg config.Config, db *sql.DB, logs io.Writer) (http.Handler, error) {
	store := filestore.New(cfg.TmpDir)

	composer := tushandler.NewStoreComposer()
	store.UseIn(composer)

	// A cross-origin browser may only attach the upload token header if the
	// preflight allows it.
	cors := tushandler.DefaultCorsConfig
	cors.AllowHeaders += ", " + UploadTokenHeader + ", " + RequestHeader + ", " + RequestKeyHeader

	h, err := tushandler.NewHandler(tushandler.Config{
		BasePath:                BasePath,
		StoreComposer:           composer,
		MaxSize:                 cfg.MaxFileSize, // tusd treats 0 as no limit
		RespectForwardedHeaders: true,
		Cors:                    &cors,
		Logger:                  slog.New(slog.NewTextHandler(logs, &slog.HandlerOptions{Level: slog.LevelError})),
	})
	if err != nil {
		return nil, err
	}

	var next http.Handler = stripBasePath(h)
	if cfg.UploadLimitPerIP > 0 {
		next = limitGate(uploadcap.New(cfg.UploadLimitPerIP, nil), cfg.TrustedProxies, next)
	}
	// The auth gate goes outermost so an unauthorized request learns nothing
	// about the quota.
	return uploadGate(cfg, db, quotaGate(cfg, db, next)), nil
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
// An upload for a file request proves the request link instead, see
// requestGate. The OPTIONS preflight passes, because browsers send no custom
// headers on it.
func uploadGate(cfg config.Config, db *sql.DB, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodOptions {
			next.ServeHTTP(w, r)
			return
		}
		if r.Header.Get(RequestHeader) != "" {
			if status, msg := requestGate(db, r, time.Now().UnixMilli()); status != 0 {
				writeJSONError(w, status, msg)
				return
			}
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

// requestGate admits a tus request for the file request it names when it
// carries that request's public key and the request has not expired. A create
// must also find the request open and declare a length within its size cap,
// since a deferred one could grow past the cap and the quota after the attach;
// the attach checks both again on the real bytes. It returns 0 to admit, else
// the status and message to refuse with, a 404 alike for every wrong proof.
func requestGate(db *sql.DB, r *http.Request, nowMs int64) (int, string) {
	if db == nil {
		return http.StatusNotFound, "not found"
	}
	rec, err := store.GetRequest(db, r.Header.Get(RequestHeader))
	if err != nil || rec == nil || rec.Expired(nowMs) ||
		!share.RequestKeyMatches(r.Header.Get(RequestKeyHeader), rec.PublicKey) {
		return http.StatusNotFound, "not found"
	}
	if r.Method != http.MethodPost {
		return 0, ""
	}
	if !share.RequestTakesUploads(rec.UploadCount, rec.MaxUploads) {
		return http.StatusGone, "request closed"
	}
	length, err := strconv.ParseInt(r.Header.Get("Upload-Length"), 10, 64)
	if err != nil || length < 0 {
		return http.StatusBadRequest, "upload length required"
	}
	if rec.MaxSize != nil && length > *rec.MaxSize {
		return http.StatusRequestEntityTooLarge, "upload larger than the request allows"
	}
	return 0, ""
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
					writeJSONError(w, http.StatusInsufficientStorage, "storage quota exceeded")
					return
				}
			}
		}
		next.ServeHTTP(w, r)
	})
}

// limitGate charges a tus create's declared Upload-Length to its client under
// UPLOAD_LIMIT_PER_IP. Resumes pass, since tusd caps them at the declared
// length. A deferred length would slip past the count, so a create has to
// declare one. A create tusd refuses gives its bytes back.
func limitGate(limit *uploadcap.Cap, proxies clientip.Proxies, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			next.ServeHTTP(w, r)
			return
		}
		length, err := strconv.ParseInt(r.Header.Get("Upload-Length"), 10, 64)
		if err != nil || length < 0 {
			writeJSONError(w, http.StatusBadRequest, "upload length required")
			return
		}
		release, retryAfter, ok := limit.Take(proxies.ClientIP(r), length)
		if !ok {
			if retryAfter == 0 {
				writeJSONError(w, http.StatusRequestEntityTooLarge, "upload larger than the limit")
				return
			}
			w.Header().Set("Retry-After", strconv.Itoa(int(math.Ceil(retryAfter.Seconds()))))
			writeJSONError(w, http.StatusTooManyRequests, "upload limit reached")
			return
		}
		rec := &statusRecorder{ResponseWriter: w}
		next.ServeHTTP(rec, r)
		if rec.status != http.StatusCreated {
			release()
		}
	})
}

func writeJSONError(w http.ResponseWriter, status int, msg string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_, _ = w.Write([]byte(`{"error":"` + msg + `"}`))
}

// statusRecorder remembers the status a handler wrote. Unwrap lets tusd's
// http.ResponseController still reach the connection for its deadlines.
type statusRecorder struct {
	http.ResponseWriter
	status int
}

func (r *statusRecorder) WriteHeader(status int) {
	r.status = status
	r.ResponseWriter.WriteHeader(status)
}

func (r *statusRecorder) Unwrap() http.ResponseWriter {
	return r.ResponseWriter
}
