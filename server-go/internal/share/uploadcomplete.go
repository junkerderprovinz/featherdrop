package share

// IsUploadComplete reports whether a tus upload has fully arrived, judged by
// the bytes on disk against the declared Upload-Length. An upload without a
// declared length never counts as complete, since it could keep growing after
// it is stored, past the size caps and the quota.
func IsUploadComplete(onDiskSize, declaredSize int64, declaredKnown bool) bool {
	return declaredKnown && onDiskSize >= declaredSize
}
