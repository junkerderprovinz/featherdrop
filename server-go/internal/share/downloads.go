package share

// The download limit helpers follow lib/downloads.ts. A nil max is an unlimited
// share; store.RegisterDownload does the atomic count and burn.

const maxDownloadsCap = int64(10_000)

// DownloadsLeft returns the remaining downloads, never negative, or nil for an
// unlimited share.
func DownloadsLeft(count int64, max *int64) *int64 {
	if max == nil {
		return nil
	}
	left := *max - count
	if left < 0 {
		left = 0
	}
	return &left
}

// IsExhausted reports whether a limited share has used up its downloads.
func IsExhausted(count int64, max *int64) bool {
	return max != nil && count >= *max
}

// ParseMaxDownloads clamps an uploader-supplied limit to 1..maxDownloadsCap and
// returns nil, meaning unlimited, for a missing, zero or negative value.
func ParseMaxDownloads(input *int64) *int64 {
	if input == nil || *input < 1 {
		return nil
	}
	v := *input
	if v > maxDownloadsCap {
		v = maxDownloadsCap
	}
	return &v
}
