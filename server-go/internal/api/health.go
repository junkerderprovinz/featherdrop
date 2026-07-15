package api

import "net/http"

// healthcheckResponse is the GET /api/healthcheck body: {"ok":true}.
type healthcheckResponse struct {
	OK bool `json:"ok"`
}

// HealthcheckHandler builds GET /api/healthcheck: a liveness probe for the
// Docker HEALTHCHECK (via the binary's -healthcheck self-flag; the distroless
// image has no shell/curl) and external monitors. It is deliberately never
// auth-gated and never rate-limited — a monitor's polling must not be able to
// starve itself out (main.go mounts it OUTSIDE the rate-limit wrappers).
func HealthcheckHandler() http.HandlerFunc {
	return func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, http.StatusOK, healthcheckResponse{OK: true})
	}
}
