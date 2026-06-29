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

// metaResponse is the GET /api/d/{slug}/meta body. It mirrors the DownloadView
// props the SSR download page (app/d/[slug]/page.tsx) computed for a format>=2
// share: the share-shape metadata the future static SPA needs to render the
// download UI without an SSR pass.
//
// Nullable fields are pointers so a real null round-trips as JSON null (rather
// than being dropped); name and MIME are deliberately ABSENT — they live inside
// the client-encrypted blob and the server never knows them (zero-knowledge).
// key_verifier is ALSO absent: the client derives it from the content key. No
// per-share secret beyond what the SSR page already exposed to anyone with the
// slug is returned here.
type metaResponse struct {
	Format        int64   `json:"format"`
	Size          int64   `json:"size"`
	ExpiresAt     *int64  `json:"expiresAt"`
	HasPassword   bool    `json:"hasPassword"`
	DownloadsLeft *int64  `json:"downloadsLeft"`
	WrappedKey    *string `json:"wrappedKey"`
	KDFSalt       *string `json:"kdfSalt"`
}

// b64OrNil base64-encodes (STD, matching the TS Buffer.toString("base64")) a
// blob, returning nil for a nil/absent blob so it marshals to JSON null —
// mirroring the SSR page's `rec.wrapped_key ? base64 : null`.
func b64OrNil(b []byte) *string {
	if b == nil {
		return nil
	}
	s := base64.StdEncoding.EncodeToString(b)
	return &s
}

// MetaHandler builds GET /api/d/{slug}/meta. It is READ-ONLY: it never counts or
// burns a download. It returns the same share metadata the SSR download page
// computed for DownloadView, as JSON for the static SPA. No auth gate — the SSR
// page exposed these to anyone holding the slug. now is injected for
// testability; pass nil for time.Now.
func MetaHandler(db *sql.DB, now func() time.Time) http.HandlerFunc {
	if now == nil {
		now = time.Now
	}
	return func(w http.ResponseWriter, r *http.Request) {
		slug := chi.URLParam(r, "slug")

		rec, err := store.GetFileBySlug(db, slug)
		if err != nil {
			writeJSONError(w, http.StatusNotFound, "not found")
			return
		}
		// Mirrors the SSR page's notFound() guard: no row OR expired.
		if rec == nil || isExpired(rec, now().UnixMilli()) {
			writeJSONError(w, http.StatusNotFound, "not found")
			return
		}
		// Zero-knowledge only: a legacy/extinct format-1 row is never exposed.
		// The SSR page rendered DownloadView only for `rec.format >= 2`.
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
