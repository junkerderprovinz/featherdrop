package api

import (
	"database/sql"
	"errors"
	"io"
	"net/http"
	"os"
	"strconv"
	"time"

	"github.com/junkerderprovinz/featherdrop/server-go/internal/config"
	"github.com/junkerderprovinz/featherdrop/server-go/internal/share"
)

// HeaderHandler builds GET /api/d/{slug}/header. It serves the start of the
// blob up to the end of the encrypted names and sizes, enc_meta in formats 2
// and 3 and the sealed header in format 4, so a recipient can see what a
// limited or password share holds before spending a download. It never counts and stops before the first content byte. A nil now
// means time.Now.
func HeaderHandler(cfg config.Config, db *sql.DB, now func() time.Time) http.HandlerFunc {
	if now == nil {
		now = time.Now
	}
	return func(w http.ResponseWriter, r *http.Request) {
		rec, blobPath, ok := readableShare(w, r, cfg, db, now().UnixMilli())
		if !ok {
			return
		}
		// A format the server does not know might lay out its blob
		// differently, and a wrong cut could hand out content uncounted.
		var headerLength func(prefix []byte, size int64) (int64, bool)
		switch rec.Format {
		case 2, 3:
			headerLength = share.BlobHeaderLength
		case 4:
			headerLength = format4HeaderLength
		default:
			writeJSONError(w, http.StatusNotFound, "not found")
			return
		}

		f, err := os.Open(blobPath)
		if err != nil {
			writeJSONError(w, http.StatusNotFound, "not found")
			return
		}
		defer f.Close()

		peek := make([]byte, max(share.BlobHeaderPeekBytes, format4PrefixLen))
		n, err := f.ReadAt(peek, 0)
		if err != nil && !errors.Is(err, io.EOF) {
			writeJSONError(w, http.StatusNotFound, "not found")
			return
		}
		length, ok := headerLength(peek[:n], rec.Size)
		if !ok {
			writeJSONError(w, http.StatusNotFound, "not found")
			return
		}

		h := w.Header()
		h.Set("Content-Type", "application/octet-stream")
		h.Set("X-Content-Type-Options", "nosniff")
		h.Set("Cache-Control", "private, no-store")
		h.Set("Content-Length", strconv.FormatInt(length, 10))
		w.WriteHeader(http.StatusOK)
		_, _ = io.Copy(w, io.NewSectionReader(f, 0, length))
	}
}
