// Package ratelimit implements the per-client-IP token buckets behind
// RATE_LIMIT. Each key owns a bucket that refills continuously up to a burst
// capacity; a request takes one token or is refused with the time until the
// next one. Buckets live in memory, so a restart clears them, which is fine for
// an abuse brake.
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

// sweepInterval bounds how often Allow drops idle buckets, which keeps the map
// small without a background goroutine.
const sweepInterval = time.Minute

type bucket struct {
	tokens float64
	last   time.Time
}

// Limiter is a per-key token bucket limiter, safe for concurrent use. Build one
// with NewLimiter.
type Limiter struct {
	mu        sync.Mutex
	perSecond float64
	burst     float64
	buckets   map[string]*bucket
	now       func() time.Time
	lastSweep time.Time
}

// NewLimiter allows perMinute sustained requests per key with the given burst.
// A nil now means time.Now.
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

// Allow takes one token from key's bucket. When the bucket is empty it returns
// false and the time until the next token, for Retry-After.
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
	if elapsed := now.Sub(b.last).Seconds(); elapsed > 0 {
		b.tokens = math.Min(l.burst, b.tokens+elapsed*l.perSecond)
	}
	b.last = now

	if b.tokens >= 1 {
		b.tokens--
		return true, 0
	}
	need := (1 - b.tokens) / l.perSecond
	return false, time.Duration(need * float64(time.Second))
}

// sweepLocked drops buckets that have refilled to capacity, since they are no
// different from a fresh one. The caller holds l.mu.
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

// ClientIP returns the key a request is limited by: the connection peer, or
// with trustProxy the first X-Forwarded-For entry. On a directly exposed server
// the client controls that header, so it is only read when the operator opts in.
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
		return r.RemoteAddr
	}
	return host
}

// Middleware limits next with l, keyed by ClientIP. A non-empty method limits
// only that method, so the tus handler can limit upload creation while resumes
// stay free. A refused request gets 429 with Retry-After and the API's JSON
// error body.
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
