// Package api holds the JSON/file HTTP handlers that mirror the existing
// TypeScript Next.js route handlers EXACTLY (status codes, headers, JSON
// bodies): finalize (publish a completed tus upload), download (stream the
// ciphertext, with Range/?preview support and burn-after-download), and manage
// (status + delete-early for the uploader).
//
// Every handler is built by a constructor taking only the dependencies it needs
// (config, the SQLite *sql.DB, and the tus filestore over cfg.TmpDir) and
// returns an http.HandlerFunc, so they are trivially unit-testable with
// httptest and free of hidden globals.
//
// This server is zero-knowledge ONLY. The browser encrypts before upload; the
// server is a dumb byte store that never sees a key or plaintext. The v1 legacy
// at-rest (age) path, the cookie/POST download authorization, ?inline, and
// server-side MIME handling are intentionally NOT ported — v1 shares are extinct
// by swap time. A format 1 / absent-format finalize returns a clear 400.
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
	tushandler "github.com/tus/tusd/v2/pkg/handler"

	"github.com/junkerderprovinz/featherdrop/server-go/internal/config"
	"github.com/junkerderprovinz/featherdrop/server-go/internal/share"
	"github.com/junkerderprovinz/featherdrop/server-go/internal/store"
	"github.com/junkerderprovinz/featherdrop/server-go/internal/upload"
)

// finalizeBody is the JSON request body for POST /api/finalize. It mirrors the
// FinalizeBody interface in app/api/finalize/route.ts. Pointer fields
// distinguish "absent" from a zero value, matching the optional TS fields:
//   - Format == nil  -> v1/legacy (unsupported by this ZK-only server).
//   - MaxDownloads == nil -> unlimited.
//
// KeyVerifier is json.RawMessage (not *string) so we can distinguish the field
// being ABSENT (nil RawMessage) from explicitly present as JSON null ("null") or
// any other value — matching the TS guard `body.keyVerifier !== undefined`,
// where an explicit null is NOT undefined and so is validated (and rejected).
type finalizeBody struct {
	UploadID     string          `json:"uploadId"`
	Expiry       string          `json:"expiry"`
	MaxDownloads *int64          `json:"maxDownloads"`
	Format       *int64          `json:"format"`
	WrappedKey   string          `json:"wrappedKey"`
	KDFSalt      string          `json:"kdfSalt"`
	KeyVerifier  json.RawMessage `json:"keyVerifier"`
}

// finalizeResponse is the success body: {"slug":..,"manageToken":..}. Mirrors
// the v2 NextResponse.json({ slug, manageToken }).
type finalizeResponse struct {
	Slug        string `json:"slug"`
	ManageToken string `json:"manageToken"`
}

// FinalizeHandler builds POST /api/finalize. db is the metadata store; cfg
// supplies the upload gate config + TmpDir/UploadsDir. The tus filestore is
// created over cfg.TmpDir so we read the upload's metadata via the same typed
// FileInfo tusd persisted (no hand-rolled JSON sidecar parsing).
//
// now is injected for testability; pass nil for time.Now.
func FinalizeHandler(cfg config.Config, db *sql.DB, now func() time.Time) http.HandlerFunc {
	if now == nil {
		now = time.Now
	}
	fs := filestore.New(cfg.TmpDir)

	return func(w http.ResponseWriter, r *http.Request) {
		// Upload gate FIRST — before reading the body or touching storage — so an
		// unauthorized request creates no share and stores no bytes. Mirrors the TS
		// isUploadAuthorized(...) check at the top of POST. Constant-time compare;
		// the secret is never logged.
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

		// uploadId must be present and filesystem-safe: file paths are built from
		// this server-validated id, never from a raw URL slug.
		if body.UploadID == "" || !share.IsSafeID(body.UploadID) {
			writeJSONError(w, http.StatusBadRequest, "invalid uploadId")
			return
		}

		// expiry: validated only when non-empty (empty -> DefaultExpiry later).
		if body.Expiry != "" && !share.IsValidExpiry(body.Expiry) {
			writeJSONError(w, http.StatusBadRequest, "invalid expiry")
			return
		}

		// keyVerifier: validated whenever the field is PRESENT (including an
		// explicit JSON null), BEFORE any file is moved, so a 400 has no side
		// effects and the tus upload survives for a corrected retry. Mirrors the TS
		// guard `body.keyVerifier !== undefined && !isValidKeyVerifier(...)`: an
		// absent field is skipped; a present field must be a 43-char base64url
		// string, so an explicit null (or any non-string) is rejected with 400.
		keyVerifier, err := resolveKeyVerifier(body.KeyVerifier)
		if err != nil {
			writeJSONError(w, http.StatusBadRequest, "invalid keyVerifier")
			return
		}

		// Read the tus upload's typed FileInfo (declared Size, SizeIsDeferred,
		// MetaData) via the filestore, which also confirms the binary file exists.
		// GetUpload returns handler.ErrNotFound when the .info or bytes file is
		// missing -> 404 "upload not found", mirroring the TS stat() failure.
		//
		// Divergence (deliberate, documented): the TS route stats only the bytes
		// file and SKIPS the completeness check when the sidecar is unreadable,
		// publishing the share. We require the .info sidecar to be present and
		// readable. tusd always writes both files together, so a bytes-present-but-
		// .info-missing state is unreachable in normal operation; refusing it is
		// strictly the safer choice (we never publish an upload whose declared
		// length we cannot verify).
		up, err := fs.GetUpload(r.Context(), body.UploadID)
		if err != nil {
			if errors.Is(err, tushandler.ErrNotFound) {
				writeJSONError(w, http.StatusNotFound, "upload not found")
				return
			}
			writeJSONError(w, http.StatusNotFound, "upload not found")
			return
		}
		info, err := up.GetInfo(r.Context())
		if err != nil {
			writeJSONError(w, http.StatusNotFound, "upload not found")
			return
		}

		// On-disk byte count is the source of truth for size + completeness (the
		// sidecar's Offset stays frozen at 0; see lib/upload.ts). Stat the bytes
		// file directly under TmpDir/<id>.
		tmpPath := filepath.Join(cfg.TmpDir, body.UploadID)
		st, err := os.Stat(tmpPath)
		if err != nil {
			writeJSONError(w, http.StatusNotFound, "upload not found")
			return
		}
		size := st.Size()

		// Completeness: actual bytes vs declared Upload-Length. A deferred length
		// (SizeIsDeferred) means the total is unknown, so we cannot prove
		// incompleteness and accept. Mirrors isUploadComplete(size, sidecar.size).
		declaredKnown := !info.SizeIsDeferred
		if !share.IsUploadComplete(size, info.Size, declaredKnown) {
			writeJSONError(w, http.StatusConflict, "upload not complete")
			return
		}

		// Format gate: this server is zero-knowledge only. Only formats 2 (single
		// file) and 3 (multi-file manifest blob) are supported; both are
		// byte-store-identical here. Format 1 / absent is legacy/extinct -> 400.
		format := int64(0)
		if body.Format != nil {
			format = *body.Format
		}
		if format != 2 && format != 3 {
			writeJSONError(w, http.StatusBadRequest,
				"unsupported format (this server is zero-knowledge only)")
			return
		}

		// Mint the management ("delete early") token: only its SHA-256 hash is
		// stored; the raw token is returned to the uploader ONCE.
		manageToken := share.NewManageToken()
		manageHash := share.HashManageToken(manageToken)

		// Allocate a unique slug (retry on the astronomically unlikely collision).
		slug, err := uniqueSlug(db)
		if err != nil {
			writeJSONError(w, http.StatusInternalServerError, "could not allocate slug")
			return
		}

		// Move the already-encrypted blob to its final location (no crypto at all).
		storedPath := filepath.Join(cfg.UploadsDir, body.UploadID)
		if err := os.Rename(tmpPath, storedPath); err != nil {
			writeJSONError(w, http.StatusInternalServerError, "could not store upload")
			return
		}

		// Decode base64 wrappedKey/kdfSalt to bytes (nil when absent = link mode).
		// The client sends STANDARD base64 (btoa); decodeB64 is lenient (std/url,
		// padded/unpadded) to match Node's Buffer.from(...,"base64").
		wrappedKey := decodeB64(body.WrappedKey)
		kdfSalt := decodeB64(body.KDFSalt)

		// Remove the now-stale .info sidecar (best effort, like rm force:true).
		_ = os.Remove(filepath.Join(cfg.TmpDir, body.UploadID+".info"))

		// expires_at = ExpiryToTimestamp(expiry || DEFAULT_EXPIRY). ok=false
		// (never/0/unknown) stores NULL.
		var expiresAt *int64
		nowMs := now().UnixMilli()
		expVal := body.Expiry
		if expVal == "" {
			expVal = cfg.DefaultExpiry
		}
		if ts, ok := share.ExpiryToTimestamp(expVal, nowMs); ok {
			expiresAt = &ts
		}

		rec := store.FileRecord{
			ID:              body.UploadID,
			Slug:            slug,
			OriginalName:    "", // server does not know the real filename (ZK)
			Size:            size,
			Mime:            nil, // server does not know the MIME type (ZK)
			PasswordHash:    nil, // password never reaches the server in v2
			ExpiresAt:       expiresAt,
			CreatedAt:       nowMs,
			MaxDownloads:    share.ParseMaxDownloads(body.MaxDownloads),
			Encrypted:       0, // v1 age-encryption flag unused in v2
			EncMode:         nil,
			EncKeyWrapped:   nil,
			Format:          format, // 2 (single file) or 3 (multi-file manifest)
			WrappedKey:      wrappedKey,
			KDFSalt:         kdfSalt,
			KeyVerifier:     keyVerifier, // nil when absent (no-verifier share)
			ManageTokenHash: &manageHash,
		}
		if err := store.CreateFileRecord(db, rec); err != nil {
			writeJSONError(w, http.StatusInternalServerError, "could not create record")
			return
		}

		writeJSON(w, http.StatusOK, finalizeResponse{Slug: slug, ManageToken: manageToken})
	}
}

// uniqueSlug returns a fresh slug not already present in the store, retrying up
// to 5 times. Mirrors uniqueSlug() in app/api/finalize/route.ts.
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

// resolveKeyVerifier validates a present-or-absent keyVerifier field and resolves
// it to the *string stored on the record. It mirrors the TS guard
// `if (body.keyVerifier !== undefined && !isValidKeyVerifier(body.keyVerifier))`:
//   - absent field (nil RawMessage) -> (nil, nil): no-verifier share, no error.
//   - present and a valid 43-char base64url string -> (&v, nil).
//   - present but anything else (explicit JSON null, a non-string, or a
//     malformed string) -> error, so the caller returns 400.
//
// Note an absent field and an explicit null produce DIFFERENT outcomes (skip vs
// 400), matching JavaScript's `undefined` vs `null` distinction.
func resolveKeyVerifier(raw json.RawMessage) (*string, error) {
	if raw == nil {
		return nil, nil // field absent -> validation skipped (no-verifier share)
	}
	var v string
	if err := json.Unmarshal(raw, &v); err != nil {
		// Present but not a JSON string (e.g. null, number, object) -> invalid,
		// exactly as isValidKeyVerifier(non-string) returns false in the TS.
		return nil, errors.New("keyVerifier must be a string")
	}
	if !share.IsValidKeyVerifier(v) {
		return nil, errors.New("invalid keyVerifier")
	}
	return &v, nil
}

// decodeB64 decodes a client-supplied base64 string to bytes, returning nil for
// an empty input (= absent, link mode). It mirrors Node's lenient
// Buffer.from(s, "base64"): it accepts standard base64 (what the client's btoa
// emits) and also tolerates URL-safe alphabets and missing padding, so a valid
// blob is never silently dropped. On a truly undecodable string it returns nil
// (the field is treated as absent), matching the permissive Node behaviour where
// only the leading valid run is decoded.
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
