package api

import (
	"database/sql"
	"errors"
	"io/fs"
	"net/http"
	"os"
	"path/filepath"

	"github.com/go-chi/chi/v5"

	"github.com/junkerderprovinz/castleparcel/server-go/internal/config"
	"github.com/junkerderprovinz/castleparcel/server-go/internal/share"
	"github.com/junkerderprovinz/castleparcel/server-go/internal/store"
)

// manageTokenHeader carries the raw manage token. The client reads it from the
// management link's fragment and sends it here rather than in the path, which
// keeps it out of access logs.
const manageTokenHeader = "x-fd-manage-token"

// RevokeHandler builds DELETE /api/m/{slug}, which deletes a share, expired or
// not, for whoever holds its manage token. Only the token's hash is stored and
// compared in constant time. A wrong or missing token, a share without one and
// an unknown slug all get the same 404.
func RevokeHandler(cfg config.Config, db *sql.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		setNoIndex(w)
		rec, err := store.GetFileBySlug(db, chi.URLParam(r, "slug"))
		if err != nil || rec == nil ||
			!share.ManageTokenMatches(r.Header.Get(manageTokenHeader), rec.ManageTokenHash) {
			writeJSONError(w, http.StatusNotFound, "not found")
			return
		}

		// The blob goes first, as in cleanup: one that cannot be removed, such
		// as one a Windows download holds open, keeps its row for a retry.
		err = os.Remove(filepath.Join(cfg.UploadsDir, rec.ID))
		if err != nil && !errors.Is(err, fs.ErrNotExist) {
			writeJSONError(w, http.StatusInternalServerError, "could not delete share")
			return
		}
		if _, _, err := store.DeleteFileBySlug(db, rec.Slug); err != nil {
			writeJSONError(w, http.StatusInternalServerError, "could not delete share")
			return
		}
		w.WriteHeader(http.StatusNoContent)
	}
}
