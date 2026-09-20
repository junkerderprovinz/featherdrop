package share

// IsUploadComplete reports whether a tus upload has fully arrived, judged by
// the bytes on disk against the declared Upload-Length. A deferred length
// cannot prove the upload incomplete, so it counts as complete.
func IsUploadComplete(onDiskSize, declaredSize int64, declaredKnown bool) bool {
	if !declaredKnown {
		return true
	}
	return onDiskSize >= declaredSize
}
