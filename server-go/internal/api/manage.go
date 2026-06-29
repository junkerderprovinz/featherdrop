package api

import (
	"database/sql"
	"net/http"
	"os"
	"path/filepath"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/junkerderprovinz/featherdrop/server-go/internal/config"
	"github.com/junkerderprovinz/featherdrop/server-go/internal/share"
	"github.com/junkerderprovinz/featherdrop/server-go/internal/store"
)

// manageTokenHeader is the header carrying the raw "delete early" token. It is
// read from the management link's URL #fragment client-side and sent here — NOT
// in the request path — so it never lands in access logs. Mirrors the TS
// "x-fd-manage-token".
const manageTokenHeader = "x-fd-manage-token"

// manageGetResponse is the GET body: {ok,size,expiresAt,downloadsLeft}.
// expiresAt and downloadsLeft are nullable (pointer + omitempty would drop a
// real null, so they are always emitted; nil marshals to JSON null), mirroring
// NextResponse.json({ ok, size, expiresAt, downloadsLeft }).
type manageGetResponse struct {
	OK            bool   `json:"ok"`
	Size          int64  `json:"size"`
	ExpiresAt     *int64 `json:"expiresAt"`
	DownloadsLeft *int64 `json:"downloadsLeft"`
}

// authorizeManage replicates the TS authorize(): the share must exist, not be
// expired, and the x-fd-manage-token header must hash to the stored
// manage_token_hash (constant-time). Any failure returns nil so the caller
// responds with a UNIFORM 404 — never revealing whether the slug exists, is
// legacy, or whether the token was wrong.
func authorizeManage(db *sql.DB, slug, token string, nowMs int64) *store.FileRecord {
	rec, err := store.GetFileBySlug(db, slug)
	if err != nil || rec == nil || isExpired(rec, nowMs) {
		return nil
	}
	if !share.ManageTokenMatches(token, rec.ManageTokenHash) {
		return nil
	}
	return rec
}

// ManageHandler builds the combined GET+DELETE /api/m/{slug} handler. It
// dispatches on method; chi registers it for both. now is injected for
// testability; pass nil for time.Now.
func ManageHandler(cfg config.Config, db *sql.DB, now func() time.Time) http.HandlerFunc {
	if now == nil {
		now = time.Now
	}
	return func(w http.ResponseWriter, r *http.Request) {
		slug := chi.URLParam(r, "slug")
		token := r.Header.Get(manageTokenHeader)
		nowMs := now().UnixMilli()

		rec := authorizeManage(db, slug, token, nowMs)
		if rec == nil {
			writeJSONError(w, http.StatusNotFound, "not found")
			return
		}

		switch r.Method {
		case http.MethodGet:
			writeJSON(w, http.StatusOK, manageGetResponse{
				OK:            true,
				Size:          rec.Size,
				ExpiresAt:     rec.ExpiresAt,
				DownloadsLeft: share.DownloadsLeft(rec.DownloadCount, rec.MaxDownloads),
			})
		case http.MethodDelete:
			// Remove the row first (atomic by slug) and learn the stored file id.
			// If the row is already gone (raced with cleanup/another delete) ->
			// uniform 404.
			id, ok, err := store.DeleteFileBySlug(db, rec.Slug)
			if err != nil || !ok {
				writeJSONError(w, http.StatusNotFound, "not found")
				return
			}
			// Delete the blob; a missing file is not an error (force semantics), so
			// an already-burned/swept share still reports a successful delete.
			_ = os.Remove(filepath.Join(cfg.UploadsDir, id))
			writeJSON(w, http.StatusOK, struct {
				OK bool `json:"ok"`
			}{OK: true})
		default:
			// chi routes only GET+DELETE here, but be explicit for safety.
			writeJSONError(w, http.StatusMethodNotAllowed, "method not allowed")
		}
	}
}
