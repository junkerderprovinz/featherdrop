package share

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"regexp"
)

// Management ("delete early") token for a share.
//
// At finalize the server mints a random 32-byte token, hands the RAW token back
// to the uploader ONCE (it rides in the management link's URL #fragment, like
// the content key) and stores ONLY its SHA-256 hash. The hash is one-way: a
// stolen database cannot reconstruct the token, so it cannot delete a share. To
// revoke, the client sends the raw token in the x-fd-manage-token header; the
// server hashes it and constant-time-compares it to the stored hash.
//
// SHA-256 -> 43 base64url chars without padding (same shape as the raw token).
// Mirrors lib/manage-token.ts.
var manageTokenRe = regexp.MustCompile(`^[A-Za-z0-9_-]{43}$`)

// NewManageToken mints a fresh random manage token: 32 random bytes encoded as
// unpadded base64url (43 chars), like the slug/content key. Mirrors
// lib/manage-token.ts newManageToken. It panics only if the system CSPRNG fails.
func NewManageToken() string {
	buf := make([]byte, 32)
	if _, err := rand.Read(buf); err != nil {
		panic("share: crypto/rand failed: " + err.Error())
	}
	return base64.RawURLEncoding.EncodeToString(buf)
}

// HashManageToken returns base64url(SHA-256(token)) — what the server stores;
// never the raw token. Mirrors lib/manage-token.ts hashManageToken.
func HashManageToken(token string) string {
	sum := sha256.Sum256([]byte(token))
	return base64.RawURLEncoding.EncodeToString(sum[:])
}

// IsValidManageToken reports whether v is a 43-char unpadded base64url raw
// token. Mirrors lib/manage-token.ts isValidManageToken.
func IsValidManageToken(v string) bool {
	return manageTokenRe.MatchString(v)
}

// IsValidManageTokenHash reports whether v is a 43-char unpadded base64url
// stored hash. Mirrors lib/manage-token.ts isValidManageTokenHash.
func IsValidManageTokenHash(v string) bool {
	return manageTokenRe.MatchString(v)
}

// ManageTokenMatches reports, in constant time, whether the raw provided token
// hashes to storedHash. A nil storedHash (legacy share with no manage token) or
// an empty provided token can never match. A length mismatch on the hashes is
// compared against a same-length dummy, so it rejects in the same time as a
// content mismatch. Mirrors lib/manage-token.ts manageTokenMatches.
func ManageTokenMatches(provided string, storedHash *string) bool {
	if provided == "" || storedHash == nil || *storedHash == "" {
		return false
	}
	return constantTimeEqual(HashManageToken(provided), *storedHash)
}
