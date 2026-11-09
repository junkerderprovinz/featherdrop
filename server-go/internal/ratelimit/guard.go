package ratelimit

import (
	"io"
	"net/http"

	"github.com/junkerderprovinz/castleparcel/server-go/internal/clientip"
)

// Guard puts two budgets on routes that check a secret. Every request takes a
// token from Reads, a wide brake on floods. A request also holds a token of
// Misses until its status is known, and keeps it only when Charged says the
// answer is one worth limiting, such as a failed key check. A recipient
// seeking through a video therefore spends Reads, while a guesser runs out of
// Misses, and parallel guesses cannot outrun it because each one holds its
// token while it is checked.
type Guard struct {
	Reads   *Limiter
	Misses  *Limiter
	Charged func(status int, h http.Header) bool
}

// Middleware limits next with g, keyed like Middleware. A refused request
// gets the same 429 as there.
func (g Guard) Middleware(proxies clientip.Proxies, next http.Handler) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		key := clientip.Network(proxies.ClientIP(r))
		if ok, retryAfter := g.Reads.Allow(key); !ok {
			tooMany(w, retryAfter)
			return
		}
		if ok, retryAfter := g.Misses.Allow(key); !ok {
			tooMany(w, retryAfter)
			return
		}
		sw := &settlingWriter{ResponseWriter: w, settle: func(status int) {
			if !g.Charged(status, w.Header()) {
				g.Misses.Refund(key)
			}
		}}
		next.ServeHTTP(sw, r)
		sw.settleOnce(http.StatusOK)
	}
}

// settlingWriter calls settle once with the status, as soon as it is known.
type settlingWriter struct {
	http.ResponseWriter
	settle  func(status int)
	settled bool
}

func (s *settlingWriter) settleOnce(status int) {
	if !s.settled {
		s.settled = true
		s.settle(status)
	}
}

func (s *settlingWriter) WriteHeader(status int) {
	s.settleOnce(status)
	s.ResponseWriter.WriteHeader(status)
}

func (s *settlingWriter) Write(p []byte) (int, error) {
	s.settleOnce(http.StatusOK)
	return s.ResponseWriter.Write(p)
}

// ReadFrom keeps sendfile for a blob copied from disk.
func (s *settlingWriter) ReadFrom(r io.Reader) (int64, error) {
	s.settleOnce(http.StatusOK)
	return io.Copy(s.ResponseWriter, r)
}

func (s *settlingWriter) Unwrap() http.ResponseWriter { return s.ResponseWriter }
