package share

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"regexp"
)

// The manage token lets an uploader delete a share early. Only its SHA-256 hash
// is stored, so a stolen database cannot delete shares. Both the raw token and
// the hash are 43 unpadded base64url characters, as in lib/manage-token.ts.
var manageTokenRe = regexp.MustCompile(`^[A-Za-z0-9_-]{43}$`)

// NewManageToken returns 32 random bytes as unpadded base64url. It panics only
// if the system CSPRNG fails.
func NewManageToken() string {
	buf := make([]byte, 32)
	if _, err := rand.Read(buf); err != nil {
		panic("share: crypto/rand failed: " + err.Error())
	}
	return base64.RawURLEncoding.EncodeToString(buf)
}

// HashManageToken returns base64url(SHA-256(token)), the value that is stored.
func HashManageToken(token string) string {
	sum := sha256.Sum256([]byte(token))
	return base64.RawURLEncoding.EncodeToString(sum[:])
}

// IsValidManageToken reports whether v has the shape of a raw token.
func IsValidManageToken(v string) bool {
	return manageTokenRe.MatchString(v)
}

// IsValidManageTokenHash reports whether v has the shape of a stored hash.
func IsValidManageTokenHash(v string) bool {
	return manageTokenRe.MatchString(v)
}

// ManageTokenMatches reports in constant time whether provided hashes to
// storedHash. An empty token or a share without a hash never matches.
func ManageTokenMatches(provided string, storedHash *string) bool {
	if provided == "" || storedHash == nil || *storedHash == "" {
		return false
	}
	return constantTimeEqual(HashManageToken(provided), *storedHash)
}
