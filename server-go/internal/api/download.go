package api

import (
	"database/sql"
	"io"
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

// keyVerifierHeader is the request header carrying base64url(SHA-256(content
// key)) — proof the downloader knows the content key. Mirrors the TS
// "x-fd-key-verifier".
const keyVerifierHeader = "x-fd-key-verifier"

// byteRange is the resolved result of parsing a Range header.
type byteRange struct {
	start, end    int64
	unsatisfiable bool // true -> respond 416
	none          bool // true -> no/invalid range, serve whole blob
}

// rangeRe matches a single "bytes=start-end" header (either bound may be empty).
// Mirrors the TS parseByteRange regex.
var rangeRe = regexp.MustCompile(`^bytes=(\d*)-(\d*)$`)

// parseByteRange parses a single "bytes=start-end" Range header against size.
// It mirrors parseByteRange in app/api/d/[slug]/route.ts EXACTLY: a suffix range
// "bytes=-N" returns the last N bytes (N==0 -> none, serve whole), no/invalid
// header -> none, and start>end || start>=size -> unsatisfiable (416). The end
// is clamped to size-1.
//
// Overflow parity: the TS uses parseInt(), which yields a finite (non-NaN) value
// LARGER than any real size for a bound that exceeds int64 (e.g.
// "bytes=99999999999999999999-"). strconv.ParseInt instead errors on overflow,
// which would wrongly fall through to "serve whole" (200). parseRangeBound
// therefore clamps an overflowing digit run to a "huge" sentinel so the same
// adversarial inputs reach the same branch as the TS: a huge START (or a START >
// END) -> 416; a huge suffix N -> [0, size-1] (206); a huge END -> clamped to
// size-1 (206). The regex only matches digits, so overflow is the only error.
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
		start, _ = parseRangeBound(m[1]) // overflow -> huge sentinel (>= size)
		if hasEnd {
			end, _ = parseRangeBound(m[2]) // overflow -> huge sentinel (clamped below)
		} else {
			end = size - 1
		}
	case hasEnd:
		n, overflow := parseRangeBound(m[2])
		if n == 0 {
			return byteRange{none: true}
		}
		if overflow || n >= size {
			// Suffix larger than the file -> last min(n,size) bytes = whole file.
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

// parseRangeBound parses a non-negative decimal Range bound. On an int64
// overflow it returns (math.MaxInt64, true) — a finite sentinel larger than any
// real file size — instead of an error, mirroring JavaScript parseInt()'s
// non-NaN large-number result so overflowing bounds reach the same branch as the
// TS parser (a huge start/end rather than a discarded range). The caller only
// feeds digit runs (the rangeRe alternative), so ErrSyntax never occurs.
func parseRangeBound(s string) (value int64, overflow bool) {
	v, err := strconv.ParseInt(s, 10, 64)
	if err != nil {
		return math.MaxInt64, true
	}
	return v, false
}

// isExpired reports whether rec has an expiry that has passed. Mirrors the TS
// isExpired(rec): expires_at !== null && expires_at <= now.
func isExpired(rec *store.FileRecord, nowMs int64) bool {
	return rec.ExpiresAt != nil && *rec.ExpiresAt <= nowMs
}

// DownloadHandler builds GET /api/d/{slug}. It serves the raw ciphertext
// verbatim (zero-knowledge); the real filename/MIME live inside the encrypted
// blob, so Content-Disposition uses a static "download" name. now is injected
// for testability; pass nil for time.Now.
func DownloadHandler(cfg config.Config, db *sql.DB, now func() time.Time) http.HandlerFunc {
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
		if rec == nil || isExpired(rec, now().UnixMilli()) {
			writeJSONError(w, http.StatusNotFound, "not found")
			return
		}

		// The blob path is built from the server-validated stored id, never the
		// raw URL slug.
		blobPath := filepath.Join(cfg.UploadsDir, rec.ID)
		if _, err := os.Stat(blobPath); err != nil {
			writeJSONError(w, http.StatusNotFound, "not found")
			return
		}

		// Format gate, mirroring the TS `if (rec.format >= 2)` guard. The TS route
		// routes format-1 rows to the v1 (age) flow; this server is zero-knowledge
		// ONLY and does not implement that path. A format-1 row (e.g. one migrated
		// from an older DB, where pre-existing rows default to format=1 and have
		// key_verifier=NULL) must therefore NOT be served/counted/burned through
		// the ZK path — that would stream raw age-ciphertext without proof and
		// destroy a legacy share the TS server would have served correctly. Reject
		// with a uniform 404 (never reveal existence).
		if rec.Format < 2 {
			writeJSONError(w, http.StatusNotFound, "not found")
			return
		}

		// Zero-knowledge path only (format >= 2). v1 shares are extinct.
		// Key-verifier gate: when stored, the request must present a matching
		// x-fd-key-verifier (constant-time) BEFORE anything is counted or burned.
		// NULL verifier = pre-verifier upload, served without proof (compat).
		if rec.KeyVerifier != nil && *rec.KeyVerifier != "" {
			provided := r.Header.Get(keyVerifierHeader)
			if provided == "" || !share.VerifierMatches(provided, *rec.KeyVerifier) {
				writeJSONError(w, http.StatusUnauthorized, "unauthorized")
				return
			}
		}

		// ?preview=1 — NO-COUNT, Range-capable read of the ciphertext. Allowed
		// ONLY for unlimited shares (skipping the counter on a limited share would
		// be a limit-bypass). Never burns.
		if r.URL.Query().Get("preview") == "1" {
			servePreview(w, r, rec, blobPath)
			return
		}

		// Counted download: register against the limit atomically. !Allowed (no
		// row / limit reached) -> 404. Then stream the whole blob; if this was the
		// final allowed download, burn the file from disk AFTER it is written.
		dl, err := store.RegisterDownload(db, rec.Slug)
		if err != nil {
			writeJSONError(w, http.StatusNotFound, "not found")
			return
		}
		if !dl.Allowed {
			writeJSONError(w, http.StatusNotFound, "not found")
			return
		}

		serveWhole(w, rec, blobPath, dl.Burned)
	}
}

// servePreview handles the ?preview=1 path: unlimited-only, Range-capable,
// no-count, never-burns. Mirrors the preview branch of the TS GET.
func servePreview(w http.ResponseWriter, r *http.Request, rec *store.FileRecord, blobPath string) {
	// no-count only for UNLIMITED shares; a limited share -> uniform 404.
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

// commonPreviewHeaders sets the headers shared by every preview response.
// Mirrors the TS commonHeaders object in the preview branch.
func commonPreviewHeaders(w http.ResponseWriter) {
	h := w.Header()
	h.Set("Content-Type", "application/octet-stream")
	h.Set("X-Content-Type-Options", "nosniff")
	h.Set("Cache-Control", "private, no-store")
	h.Set("Accept-Ranges", "bytes")
}

// serveWhole streams the whole blob for a counted download. Mirrors the final
// branch of the TS GET: octet-stream, attachment;filename="download",
// Content-Length, nosniff, no-store. When burn is true the blob is removed from
// disk AFTER the body has been fully written.
func serveWhole(w http.ResponseWriter, rec *store.FileRecord, blobPath string, burn bool) {
	f, err := os.Open(blobPath)
	if err != nil {
		writeJSONError(w, http.StatusNotFound, "not found")
		return
	}

	h := w.Header()
	h.Set("Content-Type", "application/octet-stream")
	h.Set("Content-Disposition", `attachment; filename="download"`)
	h.Set("X-Content-Type-Options", "nosniff")
	h.Set("Cache-Control", "private, no-store")
	h.Set("Content-Length", strconv.FormatInt(rec.Size, 10))
	w.WriteHeader(http.StatusOK)
	_, _ = io.Copy(w, f)

	// Close the handle before any unlink so the file is released (matters on
	// Windows, where an open handle blocks os.Remove).
	_ = f.Close()
	if burn {
		// Burn-after-download: remove the blob once fully streamed.
		_ = os.Remove(blobPath)
	}
}
