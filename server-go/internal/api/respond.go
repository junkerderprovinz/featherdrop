package api

import (
	"encoding/json"
	"net/http"
)

// errorBody is the error shape every route uses: {"error":"..."}.
type errorBody struct {
	Error string `json:"error"`
}

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

func writeJSONError(w http.ResponseWriter, status int, msg string) {
	writeJSON(w, status, errorBody{Error: msg})
}

// setNoIndex keeps a share link that leaks into a crawlable page out of search
// indexes. Handlers call it first, so 404 and 401 responses carry it too and
// its presence reveals nothing about whether a share exists.
func setNoIndex(w http.ResponseWriter) {
	w.Header().Set("X-Robots-Tag", "noindex, nofollow")
}

// NotFoundHandler answers unmatched /api paths with a JSON 404 instead of the
// SPA's HTML shell.
func NotFoundHandler() http.HandlerFunc {
	return func(w http.ResponseWriter, _ *http.Request) {
		writeJSONError(w, http.StatusNotFound, "not found")
	}
}
