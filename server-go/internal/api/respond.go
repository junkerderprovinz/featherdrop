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
