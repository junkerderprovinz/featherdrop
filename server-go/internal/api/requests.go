package api

import (
	"database/sql"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"io/fs"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/tus/tusd/v2/pkg/filestore"

	"github.com/junkerderprovinz/featherdrop/server-go/internal/config"
	"github.com/junkerderprovinz/featherdrop/server-go/internal/share"
	"github.com/junkerderprovinz/featherdrop/server-go/internal/store"
	"github.com/junkerderprovinz/featherdrop/server-go/internal/upload"
)

// collectTokenHeader carries the collect token, which the requester's browser
// derives from the collect link's fragment.
const collectTokenHeader = "x-fd-collect-token"

// maxRequestBody bounds the JSON bodies of the request routes, which are a
// few hundred bytes.
const maxRequestBody = 64 << 10

// absentSecret is compared when there is no request, so a refusal takes the
// same work either way. A missing request is refused whatever the comparison
// says.
const absentSecret = "-------------------------------------------"

type createRequestBody struct {
	PublicKey        string `json:"publicKey"`
	CollectTokenHash string `json:"collectTokenHash"`
	Expiry           string `json:"expiry"`
	MaxUploads       *int64 `json:"maxUploads"`
	MaxSize          *int64 `json:"maxSize"`
}

// CreateRequestHandler builds POST /api/requests, which opens a file request.
// It stores the requester's public key and the hash of the collect token,
// never anything that opens an upload. Opening a request lets strangers
// upload, so it needs the upload password when one is set. A nil now means
// time.Now.
func CreateRequestHandler(cfg config.Config, db *sql.DB, now func() time.Time) http.HandlerFunc {
	if now == nil {
		now = time.Now
	}
	return func(w http.ResponseWriter, r *http.Request) {
		if !upload.IsUploadAuthorized(r.Header.Get(upload.UploadTokenHeader), cfg.UploadProtected, cfg.UploadPassword) {
			writeJSONError(w, http.StatusUnauthorized, "upload password required")
			return
		}
		var body createRequestBody
		if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, maxRequestBody)).Decode(&body); err != nil {
			writeJSONError(w, http.StatusBadRequest, "invalid JSON")
			return
		}
		if !share.IsValidRequestKey(body.PublicKey) {
			writeJSONError(w, http.StatusBadRequest, "invalid publicKey")
			return
		}
		if !share.IsValidCollectTokenHash(body.CollectTokenHash) {
			writeJSONError(w, http.StatusBadRequest, "invalid collectTokenHash")
			return
		}
		if body.Expiry != "" && (!share.IsValidExpiry(body.Expiry) || !share.ExpiryWithinCap(body.Expiry, cfg.MaxExpiry)) {
			writeJSONError(w, http.StatusBadRequest, "invalid expiry")
			return
		}
		if body.MaxSize != nil && *body.MaxSize < 1 {
			writeJSONError(w, http.StatusBadRequest, "invalid maxSize")
			return
		}

		nowMs := now().UnixMilli()
		expiry := body.Expiry
		if expiry == "" {
			expiry = cfg.DefaultExpiry
		}
		var expiresAt *int64
		if ts, ok := share.ExpiryToTimestamp(expiry, nowMs); ok {
			expiresAt = &ts
		}
		rec := store.RequestRecord{
			PublicKey:        body.PublicKey,
			CollectTokenHash: body.CollectTokenHash,
			ExpiresAt:        expiresAt,
			CreatedAt:        nowMs,
			MaxUploads:       share.ParseMaxUploads(body.MaxUploads),
			MaxSize:          body.MaxSize,
		}
		slug, err := uniqueRequestSlug(db)
		if err == nil {
			rec.Slug = slug
			err = store.CreateRequest(db, rec)
		}
		if err != nil {
			log.Printf("requests: create: %v", err)
			writeJSONError(w, http.StatusInternalServerError, "could not create request")
			return
		}
		writeJSON(w, http.StatusOK, finalizeResponse{Slug: rec.Slug})
	}
}

// uniqueRequestSlug returns a slug no request has yet, trying up to five times.
func uniqueRequestSlug(db *sql.DB) (string, error) {
	for range 5 {
		slug := share.NewSlug()
		rec, err := store.GetRequest(db, slug)
		if err != nil {
			return "", err
		}
		if rec == nil {
			return slug, nil
		}
	}
	return "", errors.New("could not allocate a unique slug")
}

// RequestRoutes serves the routes under /api/r. The uploader's routes need
// the request's public key in x-fd-request-key; the requester's need the
// collect token in x-fd-collect-token. A wrong or missing proof, an unknown or
// expired request and an unknown upload all get the same 404. A nil now means
// time.Now.
func RequestRoutes(cfg config.Config, db *sql.DB, now func() time.Time) http.Handler {
	if now == nil {
		now = time.Now
	}
	h := requestHandlers{cfg: cfg, db: db, now: now, tus: filestore.New(cfg.TmpDir)}
	r := chi.NewRouter()
	r.Get("/{slug}", h.info)
	r.Post("/{slug}/uploads", h.send)
	r.Get("/{slug}/uploads", h.list)
	r.Get("/{slug}/uploads/{id}", h.blob)
	r.Get("/{slug}/uploads/{id}/header", h.header)
	r.Delete("/{slug}/uploads/{id}", h.deleteUpload)
	r.Delete("/{slug}", h.close)
	refuse := func(w http.ResponseWriter, _ *http.Request) {
		setNoIndex(w)
		writeJSONError(w, http.StatusNotFound, "not found")
	}
	r.NotFound(refuse)
	r.MethodNotAllowed(refuse)
	return r
}

type requestHandlers struct {
	cfg config.Config
	db  *sql.DB
	now func() time.Time
	tus filestore.FileStore
}

// forUploader returns the live request whose public key the client sent, or
// answers 404 itself.
func (h requestHandlers) forUploader(w http.ResponseWriter, r *http.Request) (*store.RequestRecord, bool) {
	setNoIndex(w)
	rec, err := store.GetRequest(h.db, chi.URLParam(r, "slug"))
	if err != nil {
		log.Printf("requests: get: %v", err)
	}
	stored := absentSecret
	if rec != nil {
		stored = rec.PublicKey
	}
	match := share.RequestKeyMatches(r.Header.Get(upload.RequestKeyHeader), stored)
	if rec == nil || !match || rec.Expired(h.now().UnixMilli()) {
		writeJSONError(w, http.StatusNotFound, "not found")
		return nil, false
	}
	return rec, true
}

// forCollector returns the live request whose collect token the client sent,
// or answers 404 itself.
func (h requestHandlers) forCollector(w http.ResponseWriter, r *http.Request) (*store.RequestRecord, bool) {
	setNoIndex(w)
	rec, err := store.GetRequest(h.db, chi.URLParam(r, "slug"))
	if err != nil {
		log.Printf("requests: get: %v", err)
	}
	stored := absentSecret
	if rec != nil {
		stored = rec.CollectTokenHash
	}
	match := share.CollectTokenMatches(r.Header.Get(collectTokenHeader), stored)
	if rec == nil || !match || rec.Expired(h.now().UnixMilli()) {
		writeJSONError(w, http.StatusNotFound, "not found")
		return nil, false
	}
	return rec, true
}

// requestInfo is all an uploader learns: nothing about earlier uploads beyond
// whether the request still takes one.
type requestInfo struct {
	ExpiresAt *int64 `json:"expiresAt"`
	MaxSize   *int64 `json:"maxSize"`
	Open      bool   `json:"open"`
}

func (h requestHandlers) info(w http.ResponseWriter, r *http.Request) {
	rec, ok := h.forUploader(w, r)
	if !ok {
		return
	}
	writeJSON(w, http.StatusOK, requestInfo{
		ExpiresAt: rec.ExpiresAt,
		MaxSize:   rec.MaxSize,
		Open:      share.RequestTakesUploads(rec.UploadCount, rec.MaxUploads),
	})
}

type sendBody struct {
	UploadID  string `json:"uploadId"`
	SealedKey string `json:"sealedKey"`
}

// send attaches a finished tus upload to the request. The blob has to be a
// well-formed format 4 container and the sealed key the length a sealed link
// token has; neither can be checked further without the requester's key.
func (h requestHandlers) send(w http.ResponseWriter, r *http.Request) {
	rec, ok := h.forUploader(w, r)
	if !ok {
		return
	}
	var body sendBody
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, maxRequestBody)).Decode(&body); err != nil {
		writeJSONError(w, http.StatusBadRequest, "invalid JSON")
		return
	}
	if body.UploadID == "" || !share.IsSafeID(body.UploadID) {
		writeJSONError(w, http.StatusBadRequest, "invalid uploadId")
		return
	}
	sealed, err := base64.StdEncoding.DecodeString(body.SealedKey)
	if err != nil || !share.IsValidSealedKey(sealed) {
		writeJSONError(w, http.StatusBadRequest, "invalid sealedKey")
		return
	}

	up, err := h.tus.GetUpload(r.Context(), body.UploadID)
	if err != nil {
		writeJSONError(w, http.StatusNotFound, "upload not found")
		return
	}
	info, err := up.GetInfo(r.Context())
	if err != nil {
		writeJSONError(w, http.StatusNotFound, "upload not found")
		return
	}
	tmpPath := filepath.Join(h.cfg.TmpDir, body.UploadID)
	st, err := os.Stat(tmpPath)
	if err != nil {
		writeJSONError(w, http.StatusNotFound, "upload not found")
		return
	}
	size := st.Size()
	if !share.IsUploadComplete(size, info.Size, !info.SizeIsDeferred) {
		writeJSONError(w, http.StatusConflict, "upload not complete")
		return
	}
	if rec.MaxSize != nil && size > *rec.MaxSize {
		writeJSONError(w, http.StatusRequestEntityTooLarge, "upload larger than the request allows")
		return
	}
	if err := checkFormat4Blob(tmpPath, size); err != nil {
		writeJSONError(w, http.StatusBadRequest, err.Error())
		return
	}
	if !share.RequestTakesUploads(rec.UploadCount, rec.MaxUploads) {
		writeJSONError(w, http.StatusGone, "request closed")
		return
	}
	if h.cfg.StorageQuota > 0 {
		used, err := store.QuotaUsage(h.db, body.UploadID)
		if err != nil {
			writeJSONError(w, http.StatusInternalServerError, "could not check storage quota")
			return
		}
		if used+size > h.cfg.StorageQuota {
			writeJSONError(w, http.StatusInsufficientStorage, "storage quota exceeded")
			return
		}
	}

	storedPath := filepath.Join(h.cfg.UploadsDir, body.UploadID)
	if err := os.Rename(tmpPath, storedPath); err != nil {
		writeJSONError(w, http.StatusInternalServerError, "could not store upload")
		return
	}
	_ = os.Remove(filepath.Join(h.cfg.TmpDir, body.UploadID+".info"))
	added, err := store.AddRequestUpload(h.db, rec.Slug, store.RequestUpload{
		ID:        share.NewRequestUploadID(),
		FileID:    body.UploadID,
		Size:      size,
		SealedKey: sealed,
		CreatedAt: h.now().UnixMilli(),
	}, h.now().UnixMilli())
	if err != nil || !added {
		// Without a row the blob would be unreachable and leak disk.
		_ = os.Remove(storedPath)
		_ = store.DeletePendingUpload(h.db, body.UploadID)
		if err != nil {
			log.Printf("requests: add upload: %v", err)
			writeJSONError(w, http.StatusInternalServerError, "could not store upload")
			return
		}
		// Another upload took the last place since the check above, or the
		// request was closed.
		writeJSONError(w, http.StatusGone, "request closed")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

type listedUpload struct {
	ID        string `json:"id"`
	Size      int64  `json:"size"`
	CreatedAt int64  `json:"createdAt"`
	SealedKey string `json:"sealedKey"`
}

type collectListing struct {
	ExpiresAt  *int64         `json:"expiresAt"`
	MaxUploads *int64         `json:"maxUploads"`
	MaxSize    *int64         `json:"maxSize"`
	Uploads    []listedUpload `json:"uploads"`
}

func (h requestHandlers) list(w http.ResponseWriter, r *http.Request) {
	rec, ok := h.forCollector(w, r)
	if !ok {
		return
	}
	ups, err := store.ListRequestUploads(h.db, rec.Slug)
	if err != nil {
		log.Printf("requests: list: %v", err)
		writeJSONError(w, http.StatusInternalServerError, "could not list uploads")
		return
	}
	out := collectListing{ExpiresAt: rec.ExpiresAt, MaxUploads: rec.MaxUploads, MaxSize: rec.MaxSize, Uploads: []listedUpload{}}
	for _, up := range ups {
		out.Uploads = append(out.Uploads, listedUpload{
			ID:        up.ID,
			Size:      up.Size,
			CreatedAt: up.CreatedAt,
			SealedKey: base64.StdEncoding.EncodeToString(up.SealedKey),
		})
	}
	writeJSON(w, http.StatusOK, out)
}

// collected returns the request and the upload the URL names for the holder
// of the collect link, or answers 404 itself.
func (h requestHandlers) collected(w http.ResponseWriter, r *http.Request) (*store.RequestRecord, *store.RequestUpload, bool) {
	rec, ok := h.forCollector(w, r)
	if !ok {
		return nil, nil, false
	}
	up, err := store.GetRequestUpload(h.db, rec.Slug, chi.URLParam(r, "id"))
	if err != nil {
		log.Printf("requests: get upload: %v", err)
	}
	if up == nil {
		writeJSONError(w, http.StatusNotFound, "not found")
		return nil, nil, false
	}
	return rec, up, true
}

// openUpload returns the blob of the upload the URL names, opened, or answers
// 404 itself.
func (h requestHandlers) openUpload(w http.ResponseWriter, r *http.Request) (*os.File, *store.RequestUpload, bool) {
	_, up, ok := h.collected(w, r)
	if !ok {
		return nil, nil, false
	}
	// The path comes from the stored file id, never from the URL.
	f, err := os.Open(filepath.Join(h.cfg.UploadsDir, up.FileID))
	if err != nil {
		writeJSONError(w, http.StatusNotFound, "not found")
		return nil, nil, false
	}
	return f, up, true
}

// blob serves an upload's ciphertext. It is never counted, so a broken
// download resumes with a Range request.
func (h requestHandlers) blob(w http.ResponseWriter, r *http.Request) {
	f, _, ok := h.openUpload(w, r)
	if !ok {
		return
	}
	defer f.Close()
	blobHeaders(w).Set("Accept-Ranges", "bytes")
	http.ServeContent(w, r, "", time.Time{}, f)
}

// header serves the prefix and sealed header of an upload, so the requester
// can list its files without fetching the content.
func (h requestHandlers) header(w http.ResponseWriter, r *http.Request) {
	f, up, ok := h.openUpload(w, r)
	if !ok {
		return
	}
	defer f.Close()
	prefix := make([]byte, format4PrefixLen)
	n, err := f.ReadAt(prefix, 0)
	if err != nil && !errors.Is(err, io.EOF) {
		writeJSONError(w, http.StatusNotFound, "not found")
		return
	}
	length, ok := format4HeaderLength(prefix[:n], up.Size)
	if !ok {
		writeJSONError(w, http.StatusNotFound, "not found")
		return
	}
	hd := w.Header()
	hd.Set("Content-Type", "application/octet-stream")
	hd.Set("X-Content-Type-Options", "nosniff")
	hd.Set("Cache-Control", "private, no-store")
	hd.Set("Content-Length", strconv.FormatInt(length, 10))
	w.WriteHeader(http.StatusOK)
	_, _ = io.Copy(w, io.NewSectionReader(f, 0, length))
}

// deleteUpload deletes one upload of a request, such as one whose sealed key
// does not open, for the holder of its collect link, and frees its place.
func (h requestHandlers) deleteUpload(w http.ResponseWriter, r *http.Request) {
	rec, up, ok := h.collected(w, r)
	if !ok {
		return
	}
	err := os.Remove(filepath.Join(h.cfg.UploadsDir, up.FileID))
	if err != nil && !errors.Is(err, fs.ErrNotExist) {
		writeJSONError(w, http.StatusInternalServerError, "could not delete upload")
		return
	}
	if _, err := store.DeleteRequestUpload(h.db, rec.Slug, up.ID); err != nil {
		writeJSONError(w, http.StatusInternalServerError, "could not delete upload")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// close deletes a request and its uploads for the holder of its collect link.
// It closes the request first, so no upload lands between the listing and
// the delete, and removes the blobs before the rows, as cleanup does, so one
// that cannot be removed keeps its row for a retry.
func (h requestHandlers) close(w http.ResponseWriter, r *http.Request) {
	rec, ok := h.forCollector(w, r)
	if !ok {
		return
	}
	if err := store.CloseRequest(h.db, rec.Slug); err != nil {
		writeJSONError(w, http.StatusInternalServerError, "could not close request")
		return
	}
	ups, err := store.ListRequestUploads(h.db, rec.Slug)
	if err != nil {
		writeJSONError(w, http.StatusInternalServerError, "could not close request")
		return
	}
	for _, up := range ups {
		err := os.Remove(filepath.Join(h.cfg.UploadsDir, up.FileID))
		if err != nil && !errors.Is(err, fs.ErrNotExist) {
			writeJSONError(w, http.StatusInternalServerError, "could not close request")
			return
		}
	}
	if _, err := store.DeleteRequest(h.db, rec.Slug); err != nil {
		writeJSONError(w, http.StatusInternalServerError, "could not close request")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
