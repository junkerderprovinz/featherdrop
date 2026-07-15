// Package ratelimit implements the per-client-IP token buckets behind the
// RATE_LIMIT guardrail (v6.1). Pure stdlib — golang.org/x/time/rate is not in
// go.mod and the classic token bucket is a few lines: each key (client IP)
// owns a bucket that refills continuously at the configured per-minute rate up
// to a burst capacity; a request consumes one token or is rejected with the
// time until the next token frees up (the Retry-After value).
//
// Buckets live in memory only (restart = clean slate, which is fine for an
// abuse brake) and are garbage-collected lazily: full buckets carry no state a
// fresh bucket wouldn't, so a periodic sweep drops every bucket that has
// refilled to capacity, keeping the map bounded by the recently-active IPs.
package ratelimit

import (
	"math"
	"net"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"
)

// sweepInterval is how often Allow opportunistically garbage-collects idle
// (fully-refilled) buckets. Once a minute keeps the map bounded without adding
// a background goroutine.
const sweepInterval = time.Minute

// bucket is one key's token bucket: the tokens remaining at time last.
type bucket struct {
	tokens float64
	last   time.Time
}

// Limiter is a per-key token-bucket rate limiter. The zero value is not usable;
// build one with NewLimiter. All methods are safe for concurrent use.
type Limiter struct {
	mu        sync.Mutex
	perSecond float64 // refill rate (tokens per second)
	burst     float64 // bucket capacity (= allowed burst)
	buckets   map[string]*bucket
	now       func() time.Time
	lastSweep time.Time
}

// NewLimiter builds a limiter allowing perMinute sustained requests per key
// with the given burst capacity. now is injected for testability; pass nil for
// time.Now (mirrors the now-func pattern of the api handlers).
func NewLimiter(perMinute, burst int, now func() time.Time) *Limiter {
	if now == nil {
		now = time.Now
	}
	return &Limiter{
		perSecond: float64(perMinute) / 60,
		burst:     float64(burst),
		buckets:   make(map[string]*bucket),
		now:       now,
		lastSweep: now(),
	}
}

// Allow consumes one token from key's bucket. When the bucket is empty it
// returns allowed=false and how long until the next token refills — the value
// the caller should surface as Retry-After.
func (l *Limiter) Allow(key string) (allowed bool, retryAfter time.Duration) {
	l.mu.Lock()
	defer l.mu.Unlock()

	now := l.now()
	l.sweepLocked(now)

	b, ok := l.buckets[key]
	if !ok {
		b = &bucket{tokens: l.burst, last: now}
		l.buckets[key] = b
	}
	// Continuous refill since the last touch, capped at the burst capacity.
	if elapsed := now.Sub(b.last).Seconds(); elapsed > 0 {
		b.tokens = math.Min(l.burst, b.tokens+elapsed*l.perSecond)
	}
	b.last = now

	if b.tokens >= 1 {
		b.tokens--
		return true, 0
	}
	// Time until the deficit to one whole token refills.
	need := (1 - b.tokens) / l.perSecond
	return false, time.Duration(need * float64(time.Second))
}

// sweepLocked garbage-collects buckets that have refilled to capacity — they
// are indistinguishable from a fresh bucket, so dropping them loses nothing.
// Called with l.mu held, at most once per sweepInterval.
func (l *Limiter) sweepLocked(now time.Time) {
	if now.Sub(l.lastSweep) < sweepInterval {
		return
	}
	l.lastSweep = now
	for key, b := range l.buckets {
		refilled := b.tokens + now.Sub(b.last).Seconds()*l.perSecond
		if refilled >= l.burst {
			delete(l.buckets, key)
		}
	}
}

// ClientIP resolves the client IP a bucket is keyed by. By default it is the
// connection peer (RemoteAddr with the port stripped). Only when trustProxy is
// set does the FIRST entry of X-Forwarded-For win — the first hop is the
// original client as appended by a well-behaved reverse proxy. XFF is
// attacker-controlled on a directly-exposed server, so it is NEVER consulted
// unless the operator explicitly opted in via TRUST_PROXY.
func ClientIP(r *http.Request, trustProxy bool) string {
	if trustProxy {
		if xff := r.Header.Get("X-Forwarded-For"); xff != "" {
			first, _, _ := strings.Cut(xff, ",")
			if ip := strings.TrimSpace(first); ip != "" {
				return ip
			}
		}
	}
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		// No port (e.g. a unix socket or a bare IP in tests): key on it verbatim.
		return r.RemoteAddr
	}
	return host
}

// Middleware wraps next with limiter l, keyed by ClientIP. When method is
// non-empty only requests of that method are limited (the tus handler is
// mounted for every verb, but only POST — the upload creation — is
// rate-limited; PATCH/HEAD must stay free so resumes are never throttled).
// A rejected request gets 429 with Retry-After and the uniform JSON error
// shape of internal/api/respond.go.
func Middleware(l *Limiter, trustProxy bool, method string, next http.Handler) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if method != "" && r.Method != method {
			next.ServeHTTP(w, r)
			return
		}
		if allowed, retryAfter := l.Allow(ClientIP(r, trustProxy)); !allowed {
			secs := int(math.Ceil(retryAfter.Seconds()))
			if secs < 1 {
				secs = 1
			}
			w.Header().Set("Retry-After", strconv.Itoa(secs))
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusTooManyRequests)
			_, _ = w.Write([]byte(`{"error":"too many requests"}`))
			return
		}
		next.ServeHTTP(w, r)
	}
}
