package api

import "net/http"

type healthcheckResponse struct {
	OK bool `json:"ok"`
}

// HealthcheckHandler builds GET /api/healthcheck, the liveness probe for the
// Docker HEALTHCHECK and external monitors. It has no auth and no rate limit so
// a monitor's polling cannot starve itself out.
func HealthcheckHandler() http.HandlerFunc {
	return func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, http.StatusOK, healthcheckResponse{OK: true})
	}
}
