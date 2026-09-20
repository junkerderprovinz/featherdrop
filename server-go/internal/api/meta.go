package api

import (
	"database/sql"
	"encoding/base64"
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/junkerderprovinz/featherdrop/server-go/internal/share"
	"github.com/junkerderprovinz/featherdrop/server-go/internal/store"
)

// metaResponse is the GET /api/d/{slug}/meta body, what the download page needs
// to render. Nullable fields are pointers so they marshal as JSON null. Name and
// type live inside the encrypted blob, and the client derives the key verifier
// itself, so neither is here.
type metaResponse struct {
	Format        int64   `json:"format"`
	Size          int64   `json:"size"`
	ExpiresAt     *int64  `json:"expiresAt"`
	HasPassword   bool    `json:"hasPassword"`
	DownloadsLeft *int64  `json:"downloadsLeft"`
	WrappedKey    *string `json:"wrappedKey"`
	KDFSalt       *string `json:"kdfSalt"`
}

// b64OrNil encodes b as standard base64, or returns nil for a nil blob so it
// marshals as JSON null.
func b64OrNil(b []byte) *string {
	if b == nil {
		return nil
	}
	s := base64.StdEncoding.EncodeToString(b)
	return &s
}

// MetaHandler builds GET /api/d/{slug}/meta. It never counts or burns a
// download and needs no auth, since the metadata is meant for anyone holding
// the slug. A nil now means time.Now.
func MetaHandler(db *sql.DB, now func() time.Time) http.HandlerFunc {
	if now == nil {
		now = time.Now
	}
	return func(w http.ResponseWriter, r *http.Request) {
		setNoIndex(w)
		slug := chi.URLParam(r, "slug")

		rec, err := store.GetFileBySlug(db, slug)
		if err != nil {
			writeJSONError(w, http.StatusNotFound, "not found")
			return
		}
		if rec == nil || isExpired(rec, now().UnixMilli()) {
			writeJSONError(w, http.StatusNotFound, "not found")
			return
		}
		if rec.Format < 2 {
			writeJSONError(w, http.StatusNotFound, "not found")
			return
		}

		writeJSON(w, http.StatusOK, metaResponse{
			Format:        rec.Format,
			Size:          rec.Size,
			ExpiresAt:     rec.ExpiresAt,
			HasPassword:   rec.WrappedKey != nil,
			DownloadsLeft: share.DownloadsLeft(rec.DownloadCount, rec.MaxDownloads),
			WrappedKey:    b64OrNil(rec.WrappedKey),
			KDFSalt:       b64OrNil(rec.KDFSalt),
		})
	}
}
