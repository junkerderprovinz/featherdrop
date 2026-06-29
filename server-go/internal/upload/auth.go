// Package upload wires the resumable upload endpoint (tus protocol) and its
// optional upload gate. It mirrors the existing TypeScript server/tus.ts plus
// lib/upload-auth.ts so the Go binary is a drop-in replacement.
package upload

import "crypto/subtle"

// UploadTokenHeader is the request header the client attaches the upload secret
// to. Mirrors lib/upload-auth.ts `UPLOAD_TOKEN_HEADER`.
//
// Note: Go's http.Header canonicalizes header keys, so this lower-case form is
// what the client sends on the wire; reads via http.Header.Get are
// case-insensitive regardless.
const UploadTokenHeader = "x-fd-upload-token"

// uploadTokenMatches reports whether provided equals secret in constant time.
//
// crypto/subtle.ConstantTimeCompare returns 0 for unequal-length inputs without
// inspecting their contents, which could leak the secret's length via an early
// exit. To match the TypeScript uploadTokenMatches behaviour, a length mismatch
// still performs a constant-time compare (against a same-length zero buffer)
// before returning false, so a wrong-length guess takes the same path as a
// wrong-content guess.
func uploadTokenMatches(provided, secret string) bool {
	a := []byte(provided)
	b := []byte(secret)
	if len(a) != len(b) {
		subtle.ConstantTimeCompare(a, make([]byte, len(a)))
		return false
	}
	return subtle.ConstantTimeCompare(a, b) == 1
}

// IsUploadAuthorized authorizes a write request against the upload gate.
//
//   - Not protected (no UPLOAD_PASSWORD configured) → always authorized (open,
//     today's default behaviour).
//   - Protected → token must be a non-empty constant-time match of secret.
//
// The secret is never logged. Mirrors lib/upload-auth.ts `isUploadAuthorized`.
func IsUploadAuthorized(token string, protected bool, secret string) bool {
	if !protected {
		return true
	}
	if len(token) == 0 {
		return false
	}
	return uploadTokenMatches(token, secret)
}
