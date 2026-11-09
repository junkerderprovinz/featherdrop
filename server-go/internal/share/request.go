package share

import (
	"crypto/rand"
	"regexp"
)

// A file request lets anyone with its request link upload to its requester,
// who alone holds the collect link. The request link carries the requester's
// X25519 public key, which doubles as the uploaders' proof towards the
// server. The collect link carries the secret the key pair is derived from;
// the server stores only the hash of a separate subkey of it, the collect
// token. See docs/encryption-format.md.

// SealedKeyBytes is the length of an upload's sealed link token: libsodium's
// crypto_box_seal of the 34-byte token adds an ephemeral public key and a tag.
const SealedKeyBytes = 34 + 32 + 16

// maxUploadsCap bounds how many uploads one request may take.
const maxUploadsCap = int64(1_000)

var requestKeyRe = regexp.MustCompile(`^[A-Za-z0-9_-]{43}$`)

// IsValidRequestKey reports whether v has the shape of a public key in
// unpadded base64url, 43 characters for 32 bytes.
func IsValidRequestKey(v string) bool {
	return requestKeyRe.MatchString(v)
}

// RequestKeyMatches reports in constant time whether provided is the stored
// public key. An empty key never matches.
func RequestKeyMatches(provided, stored string) bool {
	if provided == "" || stored == "" {
		return false
	}
	return constantTimeEqual(provided, stored)
}

// IsValidCollectTokenHash reports whether v has the shape of a stored collect
// token hash.
func IsValidCollectTokenHash(v string) bool {
	return manageTokenRe.MatchString(v)
}

// HashCollectToken returns base64url(SHA-256(token)), the value stored for a
// collect token, as lib/e2e/request-flow.ts computes it.
func HashCollectToken(token string) string {
	return hashToken(token)
}

// CollectTokenMatches reports in constant time whether provided hashes to
// storedHash. The hash runs even for an empty token, so a refusal takes as
// long whatever was sent.
func CollectTokenMatches(provided, storedHash string) bool {
	ok := constantTimeEqual(HashCollectToken(provided), storedHash)
	return ok && provided != "" && storedHash != ""
}

// ParseMaxUploads clamps a requester's upload count to 1..maxUploadsCap and
// returns nil, meaning unlimited, for a missing, zero or negative value.
func ParseMaxUploads(input *int64) *int64 {
	if input == nil || *input < 1 {
		return nil
	}
	return new(min(*input, maxUploadsCap))
}

// RequestTakesUploads reports whether a request with count uploads and an
// optional maximum has room for another.
func RequestTakesUploads(count int64, max *int64) bool {
	return max == nil || count < *max
}

// IsValidSealedKey reports whether b has the length of a sealed link token.
func IsValidSealedKey(b []byte) bool {
	return len(b) == SealedKeyBytes
}

// NewRequestUploadID returns a random id for an upload to a request, 26
// base32 characters, safe in a URL and as a file name.
func NewRequestUploadID() string {
	return rand.Text()
}
