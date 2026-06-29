package upload

import "testing"

func TestIsUploadAuthorized_Open(t *testing.T) {
	// Not protected: any token (including empty) is authorized.
	cases := []string{"", "anything", "secret", "x-fd-upload-token"}
	for _, tok := range cases {
		if !IsUploadAuthorized(tok, false, "") {
			t.Errorf("IsUploadAuthorized(%q, false, \"\") = false, want true (open)", tok)
		}
		// A non-empty configured secret is irrelevant while protected is false.
		if !IsUploadAuthorized(tok, false, "secret") {
			t.Errorf("IsUploadAuthorized(%q, false, \"secret\") = false, want true (open)", tok)
		}
	}
}

func TestIsUploadAuthorized_Protected(t *testing.T) {
	const secret = "correct horse"

	tests := []struct {
		name  string
		token string
		want  bool
	}{
		{"correct token", secret, true},
		{"wrong token same length", "correct mouse", false},
		{"wrong token different length", "nope", false},
		{"empty token", "", false},
		{"longer token", secret + "x", false},
		{"prefix of secret", "correct", false},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			if got := IsUploadAuthorized(tc.token, true, secret); got != tc.want {
				t.Errorf("IsUploadAuthorized(%q, true, secret) = %v, want %v", tc.token, got, tc.want)
			}
		})
	}
}

func TestUploadTokenMatches(t *testing.T) {
	if !uploadTokenMatches("abc", "abc") {
		t.Error("uploadTokenMatches(equal) = false, want true")
	}
	if uploadTokenMatches("abc", "abd") {
		t.Error("uploadTokenMatches(same-length mismatch) = true, want false")
	}
	if uploadTokenMatches("abc", "abcd") {
		t.Error("uploadTokenMatches(length mismatch) = true, want false")
	}
	if uploadTokenMatches("", "") {
		// Empty == empty is technically a match, but IsUploadAuthorized rejects
		// empty tokens before reaching here; document the raw behaviour.
		t.Log("uploadTokenMatches(\"\",\"\") = true (empty compares equal); guarded by IsUploadAuthorized")
	}
}

func TestUploadTokenHeader(t *testing.T) {
	if UploadTokenHeader != "x-fd-upload-token" {
		t.Errorf("UploadTokenHeader = %q, want x-fd-upload-token", UploadTokenHeader)
	}
}
