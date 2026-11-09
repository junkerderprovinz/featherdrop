package ratelimit

import (
	"io"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
	"time"

	"github.com/junkerderprovinz/featherdrop/server-go/internal/clientip"
)

func statusHandler(status int, header map[string]string) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		for k, v := range header {
			w.Header().Set(k, v)
		}
		w.WriteHeader(status)
	})
}

func chargedOnMiss(status int, h http.Header) bool {
	return status == http.StatusNotFound || h.Get("x-started") != ""
}

func newGuard(clock *fakeClock) Guard {
	return Guard{
		Reads:   NewLimiter(600, 50, clock.now),
		Misses:  NewLimiter(20, 3, clock.now),
		Charged: chargedOnMiss,
	}
}

func sendFrom(h http.Handler, addr string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(http.MethodGet, "/x", nil)
	req.RemoteAddr = addr
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return rec
}

func TestGuard_SuccessfulReadsSpendOnlyTheReadBudget(t *testing.T) {
	clock := newFakeClock()
	h := newGuard(clock).Middleware(clientip.Proxies{}, statusHandler(http.StatusPartialContent, nil))

	for i := range 50 {
		if rec := sendFrom(h, "1.2.3.4:1"); rec.Code != http.StatusPartialContent {
			t.Fatalf("read %d: status %d, want 206", i+1, rec.Code)
		}
	}
	if rec := sendFrom(h, "1.2.3.4:1"); rec.Code != http.StatusTooManyRequests {
		t.Fatalf("read past the read burst: status %d, want 429", rec.Code)
	}
}

func TestGuard_ChargedAnswersSpendTheMissBudget(t *testing.T) {
	tests := []struct {
		name string
		next http.Handler
	}{
		{"miss", statusHandler(http.StatusNotFound, nil)},
		{"started download", statusHandler(http.StatusOK, map[string]string{"x-started": "1"})},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			clock := newFakeClock()
			g := newGuard(clock)
			h := g.Middleware(clientip.Proxies{}, tt.next)
			for range 3 {
				sendFrom(h, "1.2.3.4:1")
			}

			// Once the miss budget is gone, every request waits, since any of
			// them could be a guess.
			read := g.Middleware(clientip.Proxies{}, statusHandler(http.StatusPartialContent, nil))
			rec := sendFrom(read, "1.2.3.4:1")
			if rec.Code != http.StatusTooManyRequests {
				t.Fatalf("after the miss budget: status %d, want 429", rec.Code)
			}
			if rec.Header().Get("Retry-After") != "3" {
				t.Fatalf("Retry-After = %q, want 3", rec.Header().Get("Retry-After"))
			}
			if rec := sendFrom(read, "5.6.7.8:1"); rec.Code != http.StatusPartialContent {
				t.Fatalf("another client: status %d, want 206", rec.Code)
			}
			clock.advance(3 * time.Second)
			if rec := sendFrom(read, "1.2.3.4:1"); rec.Code != http.StatusPartialContent {
				t.Fatalf("after a refill: status %d, want 206", rec.Code)
			}
		})
	}
}

func TestGuard_ParallelGuessesNeverOutrunTheMissBudget(t *testing.T) {
	clock := newFakeClock()
	var entered sync.WaitGroup
	entered.Add(3)
	release := make(chan struct{})
	slow := http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		entered.Done()
		<-release
		w.WriteHeader(http.StatusNotFound)
	})
	h := newGuard(clock).Middleware(clientip.Proxies{}, slow)

	const clients = 9
	codes := make([]int, clients)
	var wg sync.WaitGroup
	for i := range codes {
		wg.Go(func() { codes[i] = sendFrom(h, "1.2.3.4:1").Code })
	}
	entered.Wait()
	close(release)
	wg.Wait()

	handled := 0
	for _, code := range codes {
		if code == http.StatusNotFound {
			handled++
		}
	}
	if handled != 3 {
		t.Fatalf("%d parallel requests reached the handler, want the miss burst of 3", handled)
	}
}

func TestGuard_KeepsFlushAndSendfileReachable(t *testing.T) {
	clock := newFakeClock()
	var flushErr error
	var readFrom bool
	next := http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, readFrom = w.(io.ReaderFrom)
		w.WriteHeader(http.StatusOK)
		flushErr = http.NewResponseController(w).Flush()
	})
	sendFrom(newGuard(clock).Middleware(clientip.Proxies{}, next), "1.2.3.4:1")

	if flushErr != nil {
		t.Fatalf("flush through the guard: %v", flushErr)
	}
	if !readFrom {
		t.Fatalf("the guard hides io.ReaderFrom, so downloads lose sendfile")
	}
}
