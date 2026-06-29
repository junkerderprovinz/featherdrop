package share

// IsUploadComplete reports whether a tus upload has fully arrived, judged from
// the ACTUAL bytes on disk (onDiskSize) against the declared total length.
//
// declaredSize is the sidecar's size (Upload-Length). When it is unknown
// (deferred length / not provided, declaredKnown == false) we cannot prove
// incompleteness, so we accept. Mirrors lib/upload.ts isUploadComplete (where a
// non-number declaredSize -> true).
func IsUploadComplete(onDiskSize, declaredSize int64, declaredKnown bool) bool {
	if !declaredKnown {
		return true
	}
	return onDiskSize >= declaredSize
}
