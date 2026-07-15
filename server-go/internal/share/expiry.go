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

// ExpiryWithinCap reports whether value's lifetime fits under the operator's
// MAX_EXPIRY cap (capValue). An empty or "never" cap allows everything.
// Against a finite cap, "never" is treated as the LONGEST lifetime (it exceeds
// every finite cap), and an unknown value is rejected too — an unknown key
// would be stored as NULL = never (see ExpiryToTimestamp), so letting it
// through would silently bypass the cap.
func ExpiryWithinCap(value, capValue string) bool {
	capMs, capFound := expiryMs[capValue]
	if capValue == "" || !capFound || capMs == 0 {
		// No cap configured, or the cap itself is "never" -> everything fits.
		// (An unknown capValue is rejected at boot; treat it as no cap here.)
		return true
	}
	ms, found := expiryMs[value]
	if !found || ms == 0 {
		return false // "never"/unknown -> stored as no expiry -> exceeds a finite cap
	}
	return ms <= capMs
}
