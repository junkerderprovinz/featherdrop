package api

import (
	"database/sql"
	"io"
	"log"
	"math"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/junkerderprovinz/featherdrop/server-go/internal/config"
	"github.com/junkerderprovinz/featherdrop/server-go/internal/share"
	"github.com/junkerderprovinz/featherdrop/server-go/internal/store"
)

// keyVerifierHeader carries base64url(SHA-256(content key)), the downloader's
// proof that it knows the key. The client sends it from lib/e2e.
const keyVerifierHeader = "x-fd-key-verifier"

type byteRange struct {
	start, end    int64
	unsatisfiable bool // respond 416
	none          bool // no or invalid range, serve the whole blob
}

var rangeRe = regexp.MustCompile(`^bytes=(\d*)-(\d*)$`)

// parseByteRange parses a single "bytes=start-end" Range header against size.
// A suffix "bytes=-N" selects the last N bytes, N of 0 or a missing or invalid
// header serves the whole blob, and a start past end or size is unsatisfiable.
// A bound that overflows int64 counts as larger than any file, so a huge start
// gives 416, a huge suffix the whole file and a huge end is clamped.
func parseByteRange(header string, size int64) byteRange {
	if header == "" {
		return byteRange{none: true}
	}
	m := rangeRe.FindStringSubmatch(strings.TrimSpace(header))
	if m == nil {
		return byteRange{none: true}
	}
	hasStart := m[1] != ""
	hasEnd := m[2] != ""
	var start, end int64
	switch {
	case hasStart:
		start, _ = parseRangeBound(m[1])
		if hasEnd {
			end, _ = parseRangeBound(m[2])
		} else {
			end = size - 1
		}
	case hasEnd:
		n, overflow := parseRangeBound(m[2])
		if n == 0 {
			return byteRange{none: true}
		}
		if overflow || n >= size {
			start = 0
		} else {
			start = size - n
		}
		end = size - 1
	default:
		return byteRange{none: true}
	}
	if start > end || start >= size {
		return byteRange{unsatisfiable: true}
	}
	if end > size-1 {
		end = size - 1
	}
	return byteRange{start: start, end: end}
}

// parseRangeBound parses a digit run from rangeRe. On int64 overflow it returns
// math.MaxInt64 and true instead of discarding the range; a syntax error cannot
// occur because the regex only matches digits.
func parseRangeBound(s string) (value int64, overflow bool) {
	v, err := strconv.ParseInt(s, 10, 64)
	if err != nil {
		return math.MaxInt64, true
	}
	return v, false
}

// isExpired reports whether rec has an expiry that has passed.
func isExpired(rec *store.FileRecord, nowMs int64) bool {
	return rec.ExpiresAt != nil && *rec.ExpiresAt <= nowMs
}

// DownloadHandler builds GET /api/d/{slug}, which serves the raw ciphertext.
// The real file name and type live inside the encrypted blob, so
// Content-Disposition uses a fixed name. A download counts, and a share at its
// limit burns, only once the whole blob is delivered. The handler holds the
// downloads in flight, so a server builds one. A nil now means time.Now.
func DownloadHandler(cfg config.Config, db *sql.DB, now func() time.Time) http.HandlerFunc {
	if now == nil {
		now = time.Now
	}
	slots := newDownloadSlots(db)
	return func(w http.ResponseWriter, r *http.Request) {
		rec, blobPath, ok := readableShare(w, r, cfg, db, now().UnixMilli())
		if !ok {
			return
		}

		if r.URL.Query().Get("preview") == "1" {
			servePreview(w, r, rec, blobPath)
			return
		}

		state, err := slots.acquire(rec.Slug)
		switch {
		case err != nil || state == slotGone:
			writeJSONError(w, http.StatusNotFound, "not found")
			return
		case state == slotBusy:
			writeJSONError(w, http.StatusConflict, "download in progress")
			return
		}

		delivered := serveWhole(w, rec, blobPath)
		dl, err := slots.finish(rec.Slug, delivered)
		if err != nil {
			log.Printf("download: register: %v", err)
			return
		}
		if dl.Burned {
			_ = os.Remove(blobPath)
		}
	}
}

// readableShare looks up the share a read request names and its blob path. When
// there is nothing to read it answers the request itself and returns false: a
// 404 for a missing, expired or format 1 share or a missing blob, a 401 for a
// wrong key verifier and a 429 while a format 4 share is locked after too many
// wrong ones.
func readableShare(w http.ResponseWriter, r *http.Request, cfg config.Config, db *sql.DB, nowMs int64) (*store.FileRecord, string, bool) {
	setNoIndex(w)
	slug := chi.URLParam(r, "slug")

	rec, err := store.GetFileBySlug(db, slug)
	if err != nil || rec == nil || isExpired(rec, nowMs) {
		writeJSONError(w, http.StatusNotFound, "not found")
		return nil, "", false
	}

	// The blob path comes from the stored id, never from the URL slug.
	blobPath := filepath.Join(cfg.UploadsDir, rec.ID)
	if _, err := os.Stat(blobPath); err != nil {
		writeJSONError(w, http.StatusNotFound, "not found")
		return nil, "", false
	}

	// Format 1 rows from an older database hold age ciphertext and no
	// verifier. Serving them here would stream them without proof and burn
	// them, so they get the same 404 as a missing share.
	if rec.Format < 2 {
		writeJSONError(w, http.StatusNotFound, "not found")
		return nil, "", false
	}

	// The verifier is checked before anything is counted or burned. Rows
	// uploaded before verifiers existed have none and are served without it.
	if rec.KeyVerifier == nil || *rec.KeyVerifier == "" {
		return rec, blobPath, true
	}
	provided := r.Header.Get(keyVerifierHeader)
	if provided == "" {
		writeJSONError(w, http.StatusUnauthorized, "unauthorized")
		return nil, "", false
	}
	// Only a format 4 verifier can stand for a password that has to be
	// guessed online. Formats 2 and 3 hand their wrapped key to anyone with
	// the slug, so a lock there would protect nothing and only let a slug
	// holder block the recipient.
	if rec.Format < 4 {
		if !share.VerifierMatches(provided, *rec.KeyVerifier) {
			writeJSONError(w, http.StatusUnauthorized, "unauthorized")
			return nil, "", false
		}
		return rec, blobPath, true
	}
	check, retryAfter, err := store.CheckKeyVerifier(db, rec.Slug, provided, nowMs)
	switch {
	case err != nil || check == store.VerifierNoShare:
		if err != nil {
			log.Printf("download: check verifier: %v", err)
		}
		writeJSONError(w, http.StatusNotFound, "not found")
		return nil, "", false
	case check == store.VerifierLocked:
		// The same answer as the per-client rate limit, so a lock says no
		// more than a busy network does.
		w.Header().Set("Retry-After", strconv.FormatInt(int64(math.Ceil(retryAfter.Seconds())), 10))
		writeJSONError(w, http.StatusTooManyRequests, "too many requests")
		return nil, "", false
	case check == store.VerifierWrong:
		writeJSONError(w, http.StatusUnauthorized, "unauthorized")
		return nil, "", false
	}
	return rec, blobPath, true
}

// servePreview handles ?preview=1, a Range-capable read that is neither counted
// nor burned. A limited share gets a 404, since an uncounted read would bypass
// its limit.
func servePreview(w http.ResponseWriter, r *http.Request, rec *store.FileRecord, blobPath string) {
	if rec.MaxDownloads != nil {
		writeJSONError(w, http.StatusNotFound, "not found")
		return
	}

	rng := parseByteRange(r.Header.Get("Range"), rec.Size)
	if rng.unsatisfiable {
		h := w.Header()
		h.Set("Content-Range", "bytes */"+strconv.FormatInt(rec.Size, 10))
		h.Set("Accept-Ranges", "bytes")
		w.WriteHeader(http.StatusRequestedRangeNotSatisfiable)
		return
	}

	f, err := os.Open(blobPath)
	if err != nil {
		writeJSONError(w, http.StatusNotFound, "not found")
		return
	}
	defer f.Close()

	commonPreviewHeaders(w)
	if !rng.none {
		length := rng.end - rng.start + 1
		h := w.Header()
		h.Set("Content-Range", "bytes "+strconv.FormatInt(rng.start, 10)+"-"+
			strconv.FormatInt(rng.end, 10)+"/"+strconv.FormatInt(rec.Size, 10))
		h.Set("Content-Length", strconv.FormatInt(length, 10))
		w.WriteHeader(http.StatusPartialContent)
		if _, err := f.Seek(rng.start, io.SeekStart); err != nil {
			return
		}
		_, _ = io.CopyN(w, f, length)
		return
	}

	w.Header().Set("Content-Length", strconv.FormatInt(rec.Size, 10))
	w.WriteHeader(http.StatusOK)
	_, _ = io.Copy(w, f)
}

func commonPreviewHeaders(w http.ResponseWriter) {
	h := w.Header()
	h.Set("Content-Type", "application/octet-stream")
	h.Set("X-Content-Type-Options", "nosniff")
	h.Set("Cache-Control", "private, no-store")
	h.Set("Accept-Ranges", "bytes")
}

// serveWhole streams the whole blob for a counted download and reports whether
// it was delivered: every byte written and flushed to the connection. A client
// that stops short of the last byte misses the final chunk and its
// authentication tag, so it never holds the complete file uncounted.
func serveWhole(w http.ResponseWriter, rec *store.FileRecord, blobPath string) bool {
	f, err := os.Open(blobPath)
	if err != nil {
		writeJSONError(w, http.StatusNotFound, "not found")
		return false
	}
	defer f.Close()

	h := w.Header()
	h.Set("Content-Type", "application/octet-stream")
	h.Set("Content-Disposition", `attachment; filename="download"`)
	h.Set("X-Content-Type-Options", "nosniff")
	h.Set("Cache-Control", "private, no-store")
	h.Set("Content-Length", strconv.FormatInt(rec.Size, 10))
	w.WriteHeader(http.StatusOK)
	n, err := io.Copy(w, f)
	if err != nil || n != rec.Size {
		return false
	}
	return http.NewResponseController(w).Flush() == nil
}
