package share

// Expiry options offered to the uploader. Keys are the stable identifiers sent
// from the client; values are durations in milliseconds. "never" = no expiry.
// Mirrors lib/expiry.ts EXPIRY_OPTIONS exactly.
const (
	hourMs = int64(60 * 60 * 1000)
	dayMs  = int64(24 * 60 * 60 * 1000)
)

// expiryMs maps each allowed expiry key to its duration in milliseconds. A
// "never" key (and 0-duration options) means no expiry (stored as NULL).
var expiryMs = map[string]int64{
	"1h":    hourMs,
	"6h":    6 * hourMs,
	"1d":    dayMs,
	"7d":    7 * dayMs,
	"30d":   30 * dayMs,
	"never": 0,
}

// IsValidExpiry reports whether value is one of the allowed expiry keys.
// Mirrors lib/expiry.ts isValidExpiry.
func IsValidExpiry(value string) bool {
	_, ok := expiryMs[value]
	return ok
}

// ExpiryToTimestamp resolves an expiry option key to an absolute unix-ms
// timestamp using nowMs as "now". It returns (0, false) for "never", for the
// 0-duration option, and for any unknown key — so a bad client value never
// silently shortens a share (the caller stores NULL = no expiry when ok is
// false). Mirrors lib/expiry.ts expiryToTimestamp (null -> ok=false).
func ExpiryToTimestamp(value string, nowMs int64) (ts int64, ok bool) {
	ms, found := expiryMs[value]
	if !found || ms == 0 {
		return 0, false
	}
	return nowMs + ms, true
}
