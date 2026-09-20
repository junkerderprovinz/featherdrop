// Package share holds the share rules the client in lib/ also follows: slug and
// id validation, expiry, download limits, the key verifier and upload
// completeness. Secret comparisons run in constant time, a length mismatch
// included.
package share

import (
	"crypto/rand"
	"regexp"
	"strings"
)

// slugAlphabet leaves out 0, O, 1, l and I, which are easy to misread in a link.
const slugAlphabet = "23456789abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ"

const slugLength = 8

// safeIDRe matches ids that are safe as file names: tus upload ids and stored
// blobs never contain a path separator.
var safeIDRe = regexp.MustCompile(`^[A-Za-z0-9._-]+$`)

// IsSafeID reports whether a filesystem path may be built from id.
func IsSafeID(id string) bool {
	return safeIDRe.MatchString(id) && !strings.Contains(id, "..")
}

// NewSlug returns a random 8-character share slug such as "k7Mx9qT2". It panics
// only if the system CSPRNG fails.
func NewSlug() string {
	out := make([]byte, slugLength)
	// Bytes at or above the largest multiple of the alphabet size are rejected
	// to avoid modulo bias.
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
