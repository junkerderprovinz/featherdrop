package api

import (
	"encoding/json"
	"net/http"
)

// errorBody is the uniform JSON error shape used by every route: {"error":".."}.
// It mirrors NextResponse.json({ error: "..." }, { status }).
type errorBody struct {
	Error string `json:"error"`
}

// writeJSON writes v as a JSON response with the given status. It mirrors
// NextResponse.json: Content-Type application/json and a compact body. A marshal
// failure falls back to a 500 (it cannot happen for the small static shapes used
// here, but is handled defensively).
func writeJSON(w http.ResponseWriter, status int, v any) {
	buf, err := json.Marshal(v)
	if err != nil {
		http.Error(w, `{"error":"internal error"}`, http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_, _ = w.Write(buf)
}

// writeJSONError writes the uniform {"error":msg} body with the given status.
func writeJSONError(w http.ResponseWriter, status int, msg string) {
	writeJSON(w, status, errorBody{Error: msg})
}

// setNoIndex marks a response as never-index for crawlers. Every share-facing
// response (the /d/<slug> HTML shell plus the meta/download APIs) carries it:
// a share link that leaks into a crawlable page must not end up in a search
// index. Set unconditionally at the top of the handler so 404/401 responses
// carry it too (no existence side-channel via the header's presence).
func setNoIndex(w http.ResponseWriter) {
	w.Header().Set("X-Robots-Tag", "noindex, nofollow")
}

// NotFoundHandler responds with a uniform JSON 404 for unmatched API paths.
// Mount it as the catch-all under /api so a request to a non-existent /api/*
// route returns application/json 404 instead of falling through to the SPA HTML
// shell (which would serve text/html 200), matching typical API semantics.
func NotFoundHandler() http.HandlerFunc {
	return func(w http.ResponseWriter, _ *http.Request) {
		writeJSONError(w, http.StatusNotFound, "not found")
	}
}
