package share

const (
	hourMs = int64(60 * 60 * 1000)
	dayMs  = int64(24 * 60 * 60 * 1000)
)

// expiryMs maps the expiry keys the client sends to their duration, the same
// set as lib/expiry.ts. A duration of 0 means no expiry.
var expiryMs = map[string]int64{
	"1h":    hourMs,
	"6h":    6 * hourMs,
	"1d":    dayMs,
	"7d":    7 * dayMs,
	"30d":   30 * dayMs,
	"never": 0,
}

// IsValidExpiry reports whether value is one of the expiry keys.
func IsValidExpiry(value string) bool {
	_, ok := expiryMs[value]
	return ok
}

// ExpiryToTimestamp returns the unix-ms time at which a share with this expiry
// key ends. It returns false for "never" and for unknown keys, so a bad client
// value never shortens a share.
func ExpiryToTimestamp(value string, nowMs int64) (ts int64, ok bool) {
	ms, found := expiryMs[value]
	if !found || ms == 0 {
		return 0, false
	}
	return nowMs + ms, true
}

// ExpiryWithinCap reports whether value fits under the MAX_EXPIRY cap. An empty
// or "never" cap allows everything. Against a finite cap, "never" and unknown
// keys fail, since an unknown key would be stored as no expiry and slip past
// the cap.
func ExpiryWithinCap(value, capValue string) bool {
	capMs, capFound := expiryMs[capValue]
	// An unknown cap is refused at boot, so here it counts as no cap.
	if capValue == "" || !capFound || capMs == 0 {
		return true
	}
	ms, found := expiryMs[value]
	if !found || ms == 0 {
		return false
	}
	return ms <= capMs
}
