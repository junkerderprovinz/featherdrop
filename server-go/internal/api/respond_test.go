package api

import (
	"net/http"
	"testing"
)

func TestChargedOutcome(t *testing.T) {
	started := http.Header{}
	started.Set(resumeTokenHeader, "token")
	tests := []struct {
		name   string
		status int
		header http.Header
		want   bool
	}{
		{"missing share", http.StatusNotFound, http.Header{}, true},
		{"wrong verifier", http.StatusUnauthorized, http.Header{}, true},
		{"new counted download", http.StatusOK, started, true},
		{"resumed download", http.StatusPartialContent, http.Header{}, false},
		{"preview read", http.StatusOK, http.Header{}, false},
		{"locked share", http.StatusTooManyRequests, http.Header{}, false},
		{"download in progress", http.StatusConflict, http.Header{}, false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := ChargedOutcome(tt.status, tt.header); got != tt.want {
				t.Fatalf("ChargedOutcome(%d) = %v, want %v", tt.status, got, tt.want)
			}
		})
	}
}
