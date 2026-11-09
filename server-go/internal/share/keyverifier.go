package share

import (
	"crypto/subtle"
	"regexp"
	"time"
)

// verifierRe matches a key verifier: base64url(SHA-256(K)) of the 32-byte
// content key, computed by the client (lib/key-verifier.ts). It only proves the
// downloader knows K, so someone who merely learned the slug cannot use up a
// limited share or burn it.
var verifierRe = regexp.MustCompile(`^[A-Za-z0-9_-]{43}$`)

// IsValidKeyVerifier reports whether v is a 43-character unpadded base64url
// string.
func IsValidKeyVerifier(v string) bool {
	return verifierRe.MatchString(v)
}

// VerifierMatches reports in constant time whether provided equals stored.
func VerifierMatches(provided, stored string) bool {
	return constantTimeEqual(provided, stored)
}

// constantTimeEqual compares a and b in constant time. On a length mismatch it
// still runs a compare against a dummy, so the stored length does not leak
// through timing.
func constantTimeEqual(a, b string) bool {
	ab := []byte(a)
	bb := []byte(b)
	if len(ab) != len(bb) {
		subtle.ConstantTimeCompare(ab, make([]byte, len(ab)))
		return false
	}
	return subtle.ConstantTimeCompare(ab, bb) == 1
}

// FreeVerifierFailures is how many wrong verifiers in a row a format 4 share
// takes before each further one locks it.
const FreeVerifierFailures = 10

// maxVerifierLock caps the lock, so a share stays reachable for its recipient
// at least once an hour while still allowing only about 24 guesses a day.
const maxVerifierLock = time.Hour

// VerifierLock returns how long a share stays locked after its failures-th
// wrong verifier in a row: nothing for the free ones, then one second,
// doubling with each further failure up to an hour.
func VerifierLock(failures int64) time.Duration {
	over := failures - FreeVerifierFailures
	if over <= 0 {
		return 0
	}
	if over > 12 {
		return maxVerifierLock
	}
	return min(time.Second<<(over-1), maxVerifierLock)
}
