// Package share holds the pure domain helpers ported faithfully from the
// TypeScript lib/* modules: share-slug/id validation, expiry resolution,
// download-limit math, the zero-knowledge key-verifier, the manage ("delete
// early") token, and tus upload-completeness. Keeping these as small, pure,
// table-tested functions mirrors the TS contract one-to-one so the Go server is
// a behaviour-identical drop-in replacement.
//
// All token/verifier comparisons are constant-time (crypto/subtle), using the
// same same-length-dummy-compare trick as the existing upload/auth.go so a
// wrong-length guess takes the same code path as a wrong-content guess.
package share

import (
	"crypto/rand"
	"regexp"
	"strings"
)

// slugAlphabet is the URL-safe, unambiguous alphabet (no 0/O/1/l/I) used for
// human-friendly share links. Mirrors lib/ids.ts ALPHABET exactly.
const slugAlphabet = "23456789abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ"

// slugLength is the share slug length. Mirrors lib/ids.ts newSlug = customAlphabet(ALPHABET, 8).
const slugLength = 8

// safeIDRe matches a filesystem-safe id: tus upload ids and our stored
// filenames must never contain path separators. Mirrors lib/ids.ts SAFE_ID.
var safeIDRe = regexp.MustCompile(`^[A-Za-z0-9._-]+$`)

// IsSafeID reports whether id is safe to build a filesystem path from: it
// matches [A-Za-z0-9._-]+ and contains no ".." traversal sequence. Mirrors
// lib/ids.ts isSafeId.
func IsSafeID(id string) bool {
	return safeIDRe.MatchString(id) && !strings.Contains(id, "..")
}

// NewSlug returns a random 8-character share slug drawn uniformly from the
// unambiguous URL-safe alphabet (e.g. "k7Mx9qT2"). Mirrors lib/ids.ts newSlug.
//
// It uses crypto/rand and rejection sampling so the alphabet is sampled without
// modulo bias. It panics only if the system CSPRNG fails, which the standard
// library treats as unrecoverable.
func NewSlug() string {
	out := make([]byte, slugLength)
	// 256 % len(alphabet) bytes at the top of the range are rejected to avoid
	// modulo bias; len(alphabet)=56, so the usable range is [0, 224).
	limit := byte(256 - (256 % len(slugAlphabet)))
	buf := make([]byte, slugLength)
	n := 0
	for n < slugLength {
		if _, err := rand.Read(buf); err != nil {
			panic("share: crypto/rand failed: " + err.Error())
		}
		for _, b := range buf {
			if b >= limit {
				continue
			}
			out[n] = slugAlphabet[int(b)%len(slugAlphabet)]
			n++
			if n == slugLength {
				break
			}
		}
	}
	return string(out)
}
