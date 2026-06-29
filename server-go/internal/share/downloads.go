package share

// Optional download limit / burn-after-download helpers. max is *int64: nil =
// unlimited share; a positive value caps how many times it can be downloaded,
// after which the file + DB row are deleted (the atomic count++/delete lives in
// store.RegisterDownload). Mirrors lib/downloads.ts.

// maxDownloadsCap is the upper bound an uploader-supplied limit is clamped to.
// Mirrors lib/downloads.ts MAX_CAP.
const maxDownloadsCap = int64(10_000)

// DownloadsLeft returns the remaining downloads, or nil when unlimited
// (max == nil). Never negative. Mirrors lib/downloads.ts downloadsLeft.
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

// IsExhausted reports whether a finite-limit share has used up all its
// downloads. An unlimited share (max == nil) is never exhausted. Mirrors
// lib/downloads.ts isExhausted.
func IsExhausted(count int64, max *int64) bool {
	return max != nil && count >= *max
}

// ParseMaxDownloads normalises an uploader-supplied limit to a positive integer
// (1..maxDownloadsCap) or nil (= unlimited) for anything missing (nil), zero,
// or negative. Mirrors lib/downloads.ts parseMaxDownloads (non-integer JSON
// numbers are already excluded by *int64 typing on the Go side).
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
