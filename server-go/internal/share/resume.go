package share

import "time"

// A counted download hands its recipient a resume token. With it, a download
// that broke off continues by Range without being counted again, and a share
// that has no downloads left keeps its blob until the token's download is
// complete or the token runs out.
const (
	// ResumeIdle is how long a token stays valid after its download last sent
	// a byte. Half an hour covers a network switch, a dead hotspot or a laptop
	// lid closed for a while, and the token lives only in the open page, so
	// a longer wait seldom finds anyone left to resume.
	ResumeIdle = 30 * time.Minute
	// ResumeLifetime caps a token from the moment its download was counted, so
	// its holder cannot keep a used-up share on disk forever.
	ResumeLifetime = 24 * time.Hour
)

// NewResumeToken returns a fresh resume token and the hash that is stored for
// it. It panics only if the system CSPRNG fails.
func NewResumeToken() (token, hash string) {
	token = randomToken()
	return token, hashToken(token)
}

// HashResumeToken returns the stored form of a resume token.
func HashResumeToken(token string) string {
	return hashToken(token)
}
