package ratelimit

import (
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

// fakeClock is a manually-advanced clock so refill/sweep behaviour is
// deterministic (mirrors the injectable now() of the api handlers).
type fakeClock struct{ t time.Time }

func newFakeClock() *fakeClock {
	return &fakeClock{t: time.UnixMilli(1_000_000_000_000)}
}

func (c *fakeClock) now() time.Time          { return c.t }
func (c *fakeClock) advance(d time.Duration) { c.t = c.t.Add(d) }

// okHandler is the wrapped next handler: 200 "ok".
func okHandler() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("ok"))
	})
}

func TestLimiter_AllowsBurstThenBlocks(t *testing.T) {
	clock := newFakeClock()
	l := NewLimiter(30, 10, clock.now) // 30/min, burst 10

	for i := 0; i < 10; i++ {
		if ok, _ := l.Allow("1.2.3.4"); !ok {
			t.Fatalf("burst request %d denied, want the full burst of 10 allowed", i+1)
		}
	}
	ok, retryAfter := l.Allow("1.2.3.4")
	if ok {
		t.Fatalf("request 11 allowed, want denied (burst exhausted)")
	}
	// 30/min = one token per 2s: the deficit of one whole token needs 2s.
	if retryAfter <= 0 || retryAfter > 2*time.Second {
		t.Fatalf("retryAfter = %v, want in (0s, 2s]", retryAfter)
	}
}

func TestLimiter_RefillsAtRate(t *testing.T) {
	clock := newFakeClock()
	l := NewLimiter(30, 10, clock.now) // one token per 2s

	for i := 0; i < 10; i++ {
		l.Allow("1.2.3.4")
	}
	if ok, _ := l.Allow("1.2.3.4"); ok {
		t.Fatalf("exhausted bucket must deny")
	}
	// After 2s exactly one token has refilled: one allow, then denied again.
	clock.advance(2 * time.Second)
	if ok, _ := l.Allow("1.2.3.4"); !ok {
		t.Fatalf("one token must have refilled after 2s at 30/min")
	}
	if ok, _ := l.Allow("1.2.3.4"); ok {
		t.Fatalf("second request after a single-token refill must be denied")
	}
	// A long idle refills to (at most) the burst — never beyond.
	clock.advance(time.Hour)
	allowed := 0
	for i := 0; i < 20; i++ {
		if ok, _ := l.Allow("1.2.3.4"); ok {
			allowed++
		}
	}
	if allowed != 10 {
		t.Fatalf("after a long idle %d requests allowed, want exactly the burst 10", allowed)
	}
}

func TestLimiter_PerKeyIsolation(t *testing.T) {
	clock := newFakeClock()
	l := NewLimiter(30, 10, clock.now)

	for i := 0; i < 10; i++ {
		l.Allow("1.2.3.4")
	}
	if ok, _ := l.Allow("1.2.3.4"); ok {
		t.Fatalf("exhausted key must deny")
	}
	// A different client IP owns its own untouched bucket.
	if ok, _ := l.Allow("5.6.7.8"); !ok {
		t.Fatalf("another key must not be affected by an exhausted neighbour")
	}
}

func TestLimiter_SweepDropsIdleBuckets(t *testing.T) {
	clock := newFakeClock()
	l := NewLimiter(30, 10, clock.now)

	l.Allow("1.2.3.4")
	l.Allow("5.6.7.8")
	if got := len(l.buckets); got != 2 {
		t.Fatalf("bucket count = %d, want 2", got)
	}
	// After enough idle time every bucket has refilled to capacity; the next
	// Allow's sweep drops them (the new caller re-creates only its own).
	clock.advance(time.Hour)
	l.Allow("9.9.9.9")
	if got := len(l.buckets); got != 1 {
		t.Fatalf("bucket count after sweep = %d, want 1 (idle buckets collected)", got)
	}
}

func TestClientIP_TrustProxy(t *testing.T) {
	tests := []struct {
		name       string
		remoteAddr string
		xff        string
		trustProxy bool
		want       string
	}{
		{"no proxy: RemoteAddr host", "10.0.0.9:12345", "", false, "10.0.0.9"},
		{"no proxy: XFF ignored (spoofable)", "10.0.0.9:12345", "1.2.3.4", false, "10.0.0.9"},
		{"proxy: first XFF entry wins", "10.0.0.9:12345", "1.2.3.4, 5.6.7.8", true, "1.2.3.4"},
		{"proxy: single XFF entry", "10.0.0.9:12345", "1.2.3.4", true, "1.2.3.4"},
		{"proxy: whitespace trimmed", "10.0.0.9:12345", "  1.2.3.4 , 5.6.7.8", true, "1.2.3.4"},
		{"proxy: no XFF falls back to RemoteAddr", "10.0.0.9:12345", "", true, "10.0.0.9"},
		{"portless RemoteAddr used verbatim", "10.0.0.9", "", false, "10.0.0.9"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			r := httptest.NewRequest(http.MethodGet, "/", nil)
			r.RemoteAddr = tt.remoteAddr
			if tt.xff != "" {
				r.Header.Set("X-Forwarded-For", tt.xff)
			}
			if got := ClientIP(r, tt.trustProxy); got != tt.want {
				t.Errorf("ClientIP(%q, xff=%q, trust=%v) = %q, want %q",
					tt.remoteAddr, tt.xff, tt.trustProxy, got, tt.want)
			}
		})
	}
}

func TestMiddleware_429WithRetryAfter(t *testing.T) {
	clock := newFakeClock()
	l := NewLimiter(30, 2, clock.now) // tiny burst so the test is short
	h := Middleware(l, false, "", okHandler())

	send := func() *httptest.ResponseRecorder {
		req := httptest.NewRequest(http.MethodGet, "/x", nil)
		req.RemoteAddr = "1.2.3.4:5555"
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, req)
		return rec
	}

	for i := 0; i < 2; i++ {
		if rec := send(); rec.Code != http.StatusOK {
			t.Fatalf("burst request %d = %d, want 200", i+1, rec.Code)
		}
	}
	rec := send()
	if rec.Code != http.StatusTooManyRequests {
		t.Fatalf("over-rate status = %d, want 429", rec.Code)
	}
	if ra := rec.Header().Get("Retry-After"); ra == "" || ra == "0" {
		t.Fatalf("Retry-After = %q, want a positive integer", ra)
	}
	if ct := rec.Header().Get("Content-Type"); ct != "application/json" {
		t.Fatalf("429 Content-Type = %q, want application/json", ct)
	}
	if got := rec.Body.String(); got != `{"error":"too many requests"}` {
		t.Fatalf("429 body = %q, want the uniform JSON error", got)
	}
}

func TestMiddleware_PerIPIsolation(t *testing.T) {
	clock := newFakeClock()
	l := NewLimiter(30, 1, clock.now)
	h := Middleware(l, false, "", okHandler())

	send := func(addr string) int {
		req := httptest.NewRequest(http.MethodGet, "/x", nil)
		req.RemoteAddr = addr
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, req)
		return rec.Code
	}

	if code := send("1.2.3.4:1111"); code != http.StatusOK {
		t.Fatalf("first IP first request = %d, want 200", code)
	}
	if code := send("1.2.3.4:2222"); code != http.StatusTooManyRequests {
		t.Fatalf("first IP second request = %d, want 429 (port must not split the key)", code)
	}
	if code := send("5.6.7.8:1111"); code != http.StatusOK {
		t.Fatalf("second IP = %d, want 200 (buckets are per IP)", code)
	}
}

func TestMiddleware_XFFOnlyWithTrustProxy(t *testing.T) {
	send := func(h http.Handler, xff string) int {
		req := httptest.NewRequest(http.MethodGet, "/x", nil)
		req.RemoteAddr = "10.0.0.9:1234"
		if xff != "" {
			req.Header.Set("X-Forwarded-For", xff)
		}
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, req)
		return rec.Code
	}

	// trustProxy=false: rotating XFF must NOT dodge the limit (all requests
	// come from the same peer, so they share one bucket).
	clock := newFakeClock()
	untrusted := Middleware(NewLimiter(30, 1, clock.now), false, "", okHandler())
	if code := send(untrusted, "1.1.1.1"); code != http.StatusOK {
		t.Fatalf("first request = %d, want 200", code)
	}
	if code := send(untrusted, "2.2.2.2"); code != http.StatusTooManyRequests {
		t.Fatalf("spoofed-XFF second request = %d, want 429 (XFF must be ignored)", code)
	}

	// trustProxy=true: distinct XFF clients get distinct buckets, and the same
	// XFF client is limited.
	trusted := Middleware(NewLimiter(30, 1, clock.now), true, "", okHandler())
	if code := send(trusted, "1.1.1.1"); code != http.StatusOK {
		t.Fatalf("trusted first client = %d, want 200", code)
	}
	if code := send(trusted, "2.2.2.2"); code != http.StatusOK {
		t.Fatalf("trusted second client = %d, want 200 (own bucket)", code)
	}
	if code := send(trusted, "1.1.1.1"); code != http.StatusTooManyRequests {
		t.Fatalf("trusted repeat client = %d, want 429", code)
	}
}

func TestMiddleware_MethodFilter(t *testing.T) {
	clock := newFakeClock()
	l := NewLimiter(30, 1, clock.now)
	h := Middleware(l, false, http.MethodPost, okHandler())

	send := func(method string) int {
		req := httptest.NewRequest(method, "/files", nil)
		req.RemoteAddr = "1.2.3.4:5555"
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, req)
		return rec.Code
	}

	// POST consumes the single token; a second POST is limited…
	if code := send(http.MethodPost); code != http.StatusOK {
		t.Fatalf("first POST = %d, want 200", code)
	}
	if code := send(http.MethodPost); code != http.StatusTooManyRequests {
		t.Fatalf("second POST = %d, want 429", code)
	}
	// …but PATCH/HEAD (upload resumes) pass through untouched, even now.
	for _, m := range []string{http.MethodPatch, http.MethodHead, http.MethodOptions} {
		if code := send(m); code != http.StatusOK {
			t.Fatalf("%s = %d, want 200 (method filter must exempt it)", m, code)
		}
	}
}
