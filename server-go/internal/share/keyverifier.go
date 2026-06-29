package share

import (
	"crypto/subtle"
	"regexp"
)

// Key verifier for zero-knowledge (format=2/3) downloads.
//
// The verifier is base64url(SHA-256(K)) of the raw 32-byte content key K,
// computed by the CLIENT — the server only stores and compares the opaque
// string. It is one-way: knowing the verifier does not allow decryption; it only
// proves the downloader knows K, so someone who merely learned the slug cannot
// exhaust a limited share's download count or burn the file.
//
// SHA-256 is 32 bytes -> 43 base64url characters without padding. Mirrors
// lib/key-verifier.ts.
var verifierRe = regexp.MustCompile(`^[A-Za-z0-9_-]{43}$`)

// IsValidKeyVerifier reports whether v is a 43-char unpadded base64url string
// (finalize-body validation). Mirrors lib/key-verifier.ts isValidKeyVerifier.
func IsValidKeyVerifier(v string) bool {
	return verifierRe.MatchString(v)
}

// VerifierMatches reports whether a client-supplied verifier equals the stored
// one, in constant time. A length mismatch is compared against a same-length
// dummy instead of an early exit, so it rejects in the same time as a content
// mismatch and never leaks the stored length via a timing shortcut. Mirrors
// lib/key-verifier.ts verifierMatches.
func VerifierMatches(provided, stored string) bool {
	return constantTimeEqual(provided, stored)
}

// constantTimeEqual reports whether a == b in constant time, performing a
// same-length dummy compare on a length mismatch (mirrors the trick in
// upload/auth.go and the TS timingSafeEqual length-mismatch handling).
func constantTimeEqual(a, b string) bool {
	ab := []byte(a)
	bb := []byte(b)
	if len(ab) != len(bb) {
		subtle.ConstantTimeCompare(ab, make([]byte, len(ab)))
		return false
	}
	return subtle.ConstantTimeCompare(ab, bb) == 1
}
