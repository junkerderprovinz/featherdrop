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

	"github.com/junkerderprovinz/castleparcel/server-go/internal/config"
	"github.com/junkerderprovinz/castleparcel/server-go/internal/share"
	"github.com/junkerderprovinz/castleparcel/server-go/internal/store"
)

// keyVerifierHeader carries the downloader's proof that it knows the key:
// base64url(SHA-256(content key)) in formats 2 and 3, a subkey of the root key
// in format 4. The client sends it from lib/e2e.
const keyVerifierHeader = "x-fd-key-verifier"

// resumeTokenHeader carries the resume token: in the response that counts a
// download, and in each request that continues it.
const resumeTokenHeader = "x-fd-resume-token"

const (
	// sendChunk is how much a download sends between looks at the clock. A
	// chunk read straight from the file keeps sendfile in play.
	sendChunk = 8 << 20
	// keepEvery is how often a running download pushes its resume window out,
	// so one that takes longer than share.ResumeIdle is not swept mid-stream.
	keepEvery = time.Minute
)

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
// Content-Disposition uses a fixed name. A download counts, and uses up a
// limited share, as soon as it starts. Its response carries a resume token, and
// a request with that token continues the download by Range without counting
// it again. A share with no downloads left keeps its blob until the last token
// is finished or runs out (share.ResumeIdle, share.ResumeLifetime). A nil now
// means time.Now.
func DownloadHandler(cfg config.Config, db *sql.DB, now func() time.Time) http.HandlerFunc {
	if now == nil {
		now = time.Now
	}
	return func(w http.ResponseWriter, r *http.Request) {
		rec, blobPath, ok := readableShare(w, r, cfg, db, now().UnixMilli())
		if !ok {
			return
		}
		switch {
		case r.URL.Query().Get("preview") == "1":
			servePreview(w, r, rec, blobPath)
		case r.Header.Get(resumeTokenHeader) != "":
			serveResume(w, r, db, rec, blobPath, now)
		default:
			serveCounted(w, db, rec, blobPath, now)
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

// download is one counted download, known by the hash of its resume token.
type download struct {
	db        *sql.DB
	tokenHash string
	now       func() time.Time
}

// serveCounted counts a new download and streams the whole blob with a fresh
// resume token. A share with nothing left gets 404, and one whose last
// download can still be resumed gets 409.
func serveCounted(w http.ResponseWriter, db *sql.DB, rec *store.FileRecord, blobPath string, now func() time.Time) {
	f, err := os.Open(blobPath)
	if err != nil {
		writeJSONError(w, http.StatusNotFound, "not found")
		return
	}
	token, tokenHash := share.NewResumeToken()
	res, err := store.StartDownload(db, rec.Slug, tokenHash, now().UnixMilli())
	if err != nil || res != store.DownloadStarted {
		f.Close()
		switch {
		case err != nil:
			log.Printf("download: start: %v", err)
			writeJSONError(w, http.StatusNotFound, "not found")
		case res == store.DownloadBusy:
			writeJSONError(w, http.StatusConflict, "download in progress")
		default:
			writeJSONError(w, http.StatusNotFound, "not found")
		}
		return
	}

	h := blobHeaders(w)
	h.Set(resumeTokenHeader, token)
	h.Set("Content-Length", strconv.FormatInt(rec.Size, 10))
	w.WriteHeader(http.StatusOK)
	d := download{db: db, tokenHash: tokenHash, now: now}
	d.end(d.send(w, f, 0, rec.Size), blobPath)
}

// serveResume continues a counted download for the holder of its token. An
// unknown, finished or expired token gets the same 404 as a missing share.
func serveResume(w http.ResponseWriter, r *http.Request, db *sql.DB, rec *store.FileRecord, blobPath string, now func() time.Time) {
	tokenHash := share.HashResumeToken(r.Header.Get(resumeTokenHeader))
	live, err := store.ResumeDownload(db, rec.Slug, tokenHash, now().UnixMilli())
	if err != nil {
		log.Printf("download: resume: %v", err)
	}
	if !live {
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

	start, end := int64(0), rec.Size-1
	h := blobHeaders(w)
	h.Set("Accept-Ranges", "bytes")
	if rng.none {
		h.Set("Content-Length", strconv.FormatInt(rec.Size, 10))
		w.WriteHeader(http.StatusOK)
	} else {
		start, end = rng.start, rng.end
		h.Set("Content-Range", "bytes "+strconv.FormatInt(start, 10)+"-"+
			strconv.FormatInt(end, 10)+"/"+strconv.FormatInt(rec.Size, 10))
		h.Set("Content-Length", strconv.FormatInt(end-start+1, 10))
		w.WriteHeader(http.StatusPartialContent)
	}
	d := download{db: db, tokenHash: tokenHash, now: now}
	sent := d.send(w, f, start, end-start+1)
	d.end(sent && end == rec.Size-1, blobPath)
}

// send streams length bytes of f from start and closes f, so a burn that
// follows can remove the blob on Windows too. It reports whether every byte
// was written and flushed.
func (d download) send(w http.ResponseWriter, f *os.File, start, length int64) bool {
	defer f.Close()
	if _, err := f.Seek(start, io.SeekStart); err != nil {
		return false
	}
	next := d.now().Add(keepEvery)
	for length > 0 {
		n, err := io.CopyN(w, f, min(length, sendChunk))
		length -= n
		if err != nil {
			return false
		}
		if now := d.now(); !now.Before(next) {
			d.keep(now)
			next = now.Add(keepEvery)
		}
	}
	return http.NewResponseController(w).Flush() == nil
}

// end finishes the download once it has reached the last byte, burning a
// used-up share whose last download it was. A download that broke off gets
// its resume window from the moment of the break.
func (d download) end(complete bool, blobPath string) {
	if !complete {
		d.keep(d.now())
		return
	}
	res, err := store.FinishDownload(d.db, d.tokenHash)
	if err != nil {
		log.Printf("download: finish: %v", err)
		return
	}
	if res.Burned {
		_ = os.Remove(blobPath)
	}
}

func blobHeaders(w http.ResponseWriter) http.Header {
	h := w.Header()
	h.Set("Content-Type", "application/octet-stream")
	h.Set("Content-Disposition", `attachment; filename="download"`)
	h.Set("X-Content-Type-Options", "nosniff")
	h.Set("Cache-Control", "private, no-store")
	return h
}

func (d download) keep(now time.Time) {
	if err := store.KeepResumable(d.db, d.tokenHash, now.UnixMilli()); err != nil {
		log.Printf("download: keep resumable: %v", err)
	}
}
