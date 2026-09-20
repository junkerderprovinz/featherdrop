// Package upload serves the resumable tus upload endpoint and its optional
// upload password gate.
package upload

import "crypto/subtle"

// UploadTokenHeader carries the upload password, as the client sends it from
// lib/upload-auth.ts.
const UploadTokenHeader = "x-fd-upload-token"

// uploadTokenMatches compares provided and secret in constant time.
// subtle.ConstantTimeCompare returns at once on a length mismatch, which would
// leak the secret's length, so a mismatch still runs a dummy compare.
func uploadTokenMatches(provided, secret string) bool {
	a := []byte(provided)
	b := []byte(secret)
	if len(a) != len(b) {
		subtle.ConstantTimeCompare(a, make([]byte, len(a)))
		return false
	}
	return subtle.ConstantTimeCompare(a, b) == 1
}

// IsUploadAuthorized reports whether a write request passes the upload gate.
// Without an UPLOAD_PASSWORD every request passes; with one, token has to be a
// non-empty match.
func IsUploadAuthorized(token string, protected bool, secret string) bool {
	if !protected {
		return true
	}
	if len(token) == 0 {
		return false
	}
	return uploadTokenMatches(token, secret)
}
