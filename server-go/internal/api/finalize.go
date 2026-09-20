// Package api holds the JSON and file HTTP handlers. The browser encrypts
// before upload, so the server stores bytes and never sees a key or plaintext;
// only formats 2 and 3 are served.
package api

import (
	"database/sql"
	"encoding/base64"
	"encoding/json"
	"errors"
	"net/http"
	"os"
	"path/filepath"
	"time"

	"github.com/tus/tusd/v2/pkg/filestore"

	"github.com/junkerderprovinz/featherdrop/server-go/internal/config"
	"github.com/junkerderprovinz/featherdrop/server-go/internal/share"
	"github.com/junkerderprovinz/featherdrop/server-go/internal/store"
	"github.com/junkerderprovinz/featherdrop/server-go/internal/upload"
)

// finalizeBody is the POST /api/finalize request. Pointer fields tell an absent
// value from zero: a nil MaxDownloads means unlimited. KeyVerifier stays raw so
// an explicit null can be rejected while an absent field is skipped.
type finalizeBody struct {
	UploadID     string          `json:"uploadId"`
	Expiry       string          `json:"expiry"`
	MaxDownloads *int64          `json:"maxDownloads"`
	Format       *int64          `json:"format"`
	WrappedKey   string          `json:"wrappedKey"`
	KDFSalt      string          `json:"kdfSalt"`
	KeyVerifier  json.RawMessage `json:"keyVerifier"`
}

// finalizeResponse carries only the slug; the content key never leaves the
// client.
type finalizeResponse struct {
	Slug string `json:"slug"`
}

// FinalizeHandler builds POST /api/finalize, which publishes a completed tus
// upload as a share. It reads the upload through a tus filestore over
// cfg.TmpDir. A nil now means time.Now.
func FinalizeHandler(cfg config.Config, db *sql.DB, now func() time.Time) http.HandlerFunc {
	if now == nil {
		now = time.Now
	}
	fs := filestore.New(cfg.TmpDir)

	return func(w http.ResponseWriter, r *http.Request) {
		// Checked before the body is read, so an unauthorized request stores
		// nothing.
		token := r.Header.Get(upload.UploadTokenHeader)
		if !upload.IsUploadAuthorized(token, cfg.UploadProtected, cfg.UploadPassword) {
			writeJSONError(w, http.StatusUnauthorized, "upload password required")
			return
		}

		var body finalizeBody
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			writeJSONError(w, http.StatusBadRequest, "invalid JSON")
			return
		}

		// File paths are built from this id, so it must be filesystem-safe.
		if body.UploadID == "" || !share.IsSafeID(body.UploadID) {
			writeJSONError(w, http.StatusBadRequest, "invalid uploadId")
			return
		}

		if body.Expiry != "" && !share.IsValidExpiry(body.Expiry) {
			writeJSONError(w, http.StatusBadRequest, "invalid expiry")
			return
		}

		// An empty expiry resolves to DefaultExpiry, which Validate already
		// clamped to the cap.
		if body.Expiry != "" && !share.ExpiryWithinCap(body.Expiry, cfg.MaxExpiry) {
			writeJSONError(w, http.StatusBadRequest, "expiry exceeds the server's maximum")
			return
		}

		// Validated before any file moves, so a 400 leaves the tus upload in
		// place for a corrected retry.
		keyVerifier, err := resolveKeyVerifier(body.KeyVerifier)
		if err != nil {
			writeJSONError(w, http.StatusBadRequest, "invalid keyVerifier")
			return
		}

		// GetUpload fails when the .info sidecar or the bytes are missing. An
		// upload whose declared length cannot be read is never published.
		up, err := fs.GetUpload(r.Context(), body.UploadID)
		if err != nil {
			writeJSONError(w, http.StatusNotFound, "upload not found")
			return
		}
		info, err := up.GetInfo(r.Context())
		if err != nil {
			writeJSONError(w, http.StatusNotFound, "upload not found")
			return
		}

		// The sidecar's Offset stays at 0 (see lib/upload.ts), so the size on
		// disk is what counts.
		tmpPath := filepath.Join(cfg.TmpDir, body.UploadID)
		st, err := os.Stat(tmpPath)
		if err != nil {
			writeJSONError(w, http.StatusNotFound, "upload not found")
			return
		}
		size := st.Size()

		declaredKnown := !info.SizeIsDeferred
		if !share.IsUploadComplete(size, info.Size, declaredKnown) {
			writeJSONError(w, http.StatusConflict, "upload not complete")
			return
		}

		// Format 2 is a single file, 3 a multi-file manifest blob; both are
		// plain bytes to the server.
		format := int64(0)
		if body.Format != nil {
			format = *body.Format
		}
		if format != 2 && format != 3 {
			writeJSONError(w, http.StatusBadRequest,
				"unsupported format (this server is zero-knowledge only)")
			return
		}

		// The tus create only checked the declared length, and a deferred length
		// declares none, so this check on the real bytes is the one that counts.
		// It runs before the rename so a 507 leaves the upload for a later retry.
		if cfg.StorageQuota > 0 {
			used, err := store.TotalStoredSize(db)
			if err != nil {
				writeJSONError(w, http.StatusInternalServerError, "could not check storage quota")
				return
			}
			if used+size > cfg.StorageQuota {
				writeJSONError(w, http.StatusInsufficientStorage, "storage quota exceeded")
				return
			}
		}

		slug, err := uniqueSlug(db)
		if err != nil {
			writeJSONError(w, http.StatusInternalServerError, "could not allocate slug")
			return
		}

		storedPath := filepath.Join(cfg.UploadsDir, body.UploadID)
		if err := os.Rename(tmpPath, storedPath); err != nil {
			writeJSONError(w, http.StatusInternalServerError, "could not store upload")
			return
		}

		// Both are absent in link mode.
		wrappedKey := decodeB64(body.WrappedKey)
		kdfSalt := decodeB64(body.KDFSalt)

		_ = os.Remove(filepath.Join(cfg.TmpDir, body.UploadID+".info"))

		var expiresAt *int64
		nowMs := now().UnixMilli()
		expVal := body.Expiry
		if expVal == "" {
			expVal = cfg.DefaultExpiry
		}
		if ts, ok := share.ExpiryToTimestamp(expVal, nowMs); ok {
			expiresAt = &ts
		}

		// Name, type and password stay on the client. The encryption and manage
		// token columns belong to older formats and stay NULL.
		rec := store.FileRecord{
			ID:              body.UploadID,
			Slug:            slug,
			OriginalName:    "",
			Size:            size,
			Mime:            nil,
			PasswordHash:    nil,
			ExpiresAt:       expiresAt,
			CreatedAt:       nowMs,
			MaxDownloads:    share.ParseMaxDownloads(body.MaxDownloads),
			Encrypted:       0,
			EncMode:         nil,
			EncKeyWrapped:   nil,
			Format:          format,
			WrappedKey:      wrappedKey,
			KDFSalt:         kdfSalt,
			KeyVerifier:     keyVerifier,
			ManageTokenHash: nil,
		}
		if err := store.CreateFileRecord(db, rec); err != nil {
			// Without a row the renamed blob would be unreachable and leak disk.
			_ = os.Remove(storedPath)
			writeJSONError(w, http.StatusInternalServerError, "could not create record")
			return
		}

		writeJSON(w, http.StatusOK, finalizeResponse{Slug: slug})
	}
}

// uniqueSlug returns a slug not yet in the store, trying up to five times.
func uniqueSlug(db *sql.DB) (string, error) {
	for i := 0; i < 5; i++ {
		slug := share.NewSlug()
		rec, err := store.GetFileBySlug(db, slug)
		if err != nil {
			return "", err
		}
		if rec == nil {
			return slug, nil
		}
	}
	return "", errors.New("could not allocate a unique slug")
}

// resolveKeyVerifier returns nil for an absent field, the value for a valid
// 43-character base64url string, and an error for anything else, an explicit
// JSON null included.
func resolveKeyVerifier(raw json.RawMessage) (*string, error) {
	if raw == nil {
		return nil, nil
	}
	var v string
	if err := json.Unmarshal(raw, &v); err != nil {
		return nil, errors.New("keyVerifier must be a string")
	}
	if !share.IsValidKeyVerifier(v) {
		return nil, errors.New("invalid keyVerifier")
	}
	return &v, nil
}

// decodeB64 decodes a client-supplied base64 string and returns nil for an empty
// or undecodable one. The client sends standard base64, but URL-safe and
// unpadded input is accepted too so a valid blob is never dropped.
func decodeB64(s string) []byte {
	if s == "" {
		return nil
	}
	for _, enc := range []*base64.Encoding{
		base64.StdEncoding,
		base64.RawStdEncoding,
		base64.URLEncoding,
		base64.RawURLEncoding,
	} {
		if b, err := enc.DecodeString(s); err == nil {
			return b
		}
	}
	return nil
}
