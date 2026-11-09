package api

import (
	"bytes"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"github.com/junkerderprovinz/featherdrop/server-go/internal/share"
	"github.com/junkerderprovinz/featherdrop/server-go/internal/store"
)

// brokenWriter accepts limit bytes and then fails every write, like a client
// that drops the connection mid-stream.
type brokenWriter struct {
	header http.Header
	limit  int
	got    bytes.Buffer
}

func newBrokenWriter(limit int) *brokenWriter {
	return &brokenWriter{header: http.Header{}, limit: limit}
}

func (b *brokenWriter) Header() http.Header { return b.header }
func (b *brokenWriter) WriteHeader(int)     {}

func (b *brokenWriter) Write(p []byte) (int, error) {
	room := b.limit - b.got.Len()
	if room <= 0 {
		return 0, errors.New("connection reset")
	}
	if len(p) > room {
		b.got.Write(p[:room])
		return room, errors.New("connection reset")
	}
	return b.got.Write(p)
}

// unflushableWriter takes every byte but fails the final flush, as a real
// connection does when the peer is gone before the buffered tail goes out.
type unflushableWriter struct {
	*httptest.ResponseRecorder
}

func (unflushableWriter) FlushError() error { return errors.New("connection reset") }

// stalledWriter blocks its first write until release is closed, so a test can
// hold a download in flight.
type stalledWriter struct {
	*httptest.ResponseRecorder
	started chan struct{}
	release chan struct{}
	once    sync.Once
}

func newStalledWriter() *stalledWriter {
	return &stalledWriter{
		ResponseRecorder: httptest.NewRecorder(),
		started:          make(chan struct{}),
		release:          make(chan struct{}),
	}
}

func (s *stalledWriter) Write(p []byte) (int, error) {
	s.once.Do(func() {
		close(s.started)
		<-s.release
	})
	return s.ResponseRecorder.Write(p)
}

func limitedTo(n int64) func(*store.FileRecord) {
	return func(r *store.FileRecord) { r.MaxDownloads = &n }
}

func getShare(t *testing.T, h http.Handler, w http.ResponseWriter, slug string) {
	t.Helper()
	h.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/api/d/"+slug, nil))
}

func TestDownload_BrokenStreamCountsNothing(t *testing.T) {
	tests := []struct {
		name  string
		limit func(*store.FileRecord)
	}{
		{"unlimited share", nil},
		{"once-only share", limitedTo(1)},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			e := newTestEnv(t)
			content := bytes.Repeat([]byte("ciphertext"), 100)
			slug := e.seedV2(t, content, tt.limit)

			getShare(t, e.router(nil), newBrokenWriter(len(content)/2), slug)

			row, err := store.GetFileBySlug(e.db, slug)
			if err != nil || row == nil {
				t.Fatalf("share must survive a broken download (row %v, err %v)", row, err)
			}
			if row.DownloadCount != 0 {
				t.Fatalf("download_count = %d, want 0", row.DownloadCount)
			}
			if _, err := os.Stat(filepath.Join(e.cfg.UploadsDir, row.ID)); err != nil {
				t.Fatalf("blob must survive a broken download: %v", err)
			}
		})
	}
}

func TestDownload_FailedFinalFlushCountsNothing(t *testing.T) {
	e := newTestEnv(t)
	slug := e.seedV2(t, []byte("all bytes written, never flushed"), limitedTo(1))

	getShare(t, e.router(nil), unflushableWriter{httptest.NewRecorder()}, slug)

	row, _ := store.GetFileBySlug(e.db, slug)
	if row == nil || row.DownloadCount != 0 {
		t.Fatalf("a download whose flush failed must not count or burn, row = %+v", row)
	}
}

func TestDownload_OnceOnlyShareSurvivesBrokenStreamForRetry(t *testing.T) {
	e := newTestEnv(t)
	content := bytes.Repeat([]byte("x"), 4096)
	slug := e.seedV2(t, content, limitedTo(1))
	h := e.router(nil)

	getShare(t, h, newBrokenWriter(100), slug)

	rec := httptest.NewRecorder()
	getShare(t, h, rec, slug)
	if rec.Code != http.StatusOK || !bytes.Equal(rec.Body.Bytes(), content) {
		t.Fatalf("retry: status %d, %d bytes, want 200 with the whole blob", rec.Code, rec.Body.Len())
	}
	if row, _ := store.GetFileBySlug(e.db, slug); row != nil {
		t.Fatalf("the delivered retry must burn the share")
	}

	again := httptest.NewRecorder()
	getShare(t, h, again, slug)
	if again.Code != http.StatusNotFound {
		t.Fatalf("after the burn: status %d, want 404", again.Code)
	}
}

func TestDownload_SecondDownloadWhileOnceOnlyShareStreams_409(t *testing.T) {
	e := newTestEnv(t)
	content := []byte("only one reader may get this")
	slug := e.seedV2(t, content, limitedTo(1))
	row, _ := store.GetFileBySlug(e.db, slug)
	h := e.router(nil)

	first := newStalledWriter()
	done := make(chan struct{})
	go func() {
		defer close(done)
		getShare(t, h, first, slug)
	}()
	release := sync.OnceFunc(func() { close(first.release) })
	// A failed assertion must not leave the first download holding the blob
	// open, or TempDir cannot remove it on Windows.
	t.Cleanup(func() {
		release()
		<-done
	})
	<-first.started

	second := httptest.NewRecorder()
	getShare(t, h, second, slug)
	if second.Code != http.StatusConflict {
		t.Fatalf("second download: status %d, want 409", second.Code)
	}
	var body errorBody
	decodeJSON(t, second, &body)
	if body.Error != "download in progress" {
		t.Fatalf("second download: error %q, want download in progress", body.Error)
	}

	release()
	<-done
	if first.Code != http.StatusOK || !bytes.Equal(first.Body.Bytes(), content) {
		t.Fatalf("first download: status %d, body %q", first.Code, first.Body.String())
	}
	if r, _ := store.GetFileBySlug(e.db, slug); r != nil {
		t.Fatalf("the delivered download must burn the share")
	}
	if _, err := os.Stat(filepath.Join(e.cfg.UploadsDir, row.ID)); !os.IsNotExist(err) {
		t.Fatalf("the burned blob must be removed, stat err = %v", err)
	}
}

func TestDownload_ParallelDownloadsNeverExceedTheLimit(t *testing.T) {
	const limit = 3
	e := newTestEnv(t)
	content := bytes.Repeat([]byte("parallel"), 8192)
	slug := e.seedV2(t, content, limitedTo(limit))
	h := e.router(nil)

	const clients = 16
	recs := make([]*httptest.ResponseRecorder, clients)
	var wg sync.WaitGroup
	for i := range recs {
		recs[i] = httptest.NewRecorder()
		wg.Go(func() { getShare(t, h, recs[i], slug) })
	}
	wg.Wait()

	delivered := 0
	for _, rec := range recs {
		switch rec.Code {
		case http.StatusOK:
			if !bytes.Equal(rec.Body.Bytes(), content) {
				t.Fatalf("a 200 carried %d bytes, want %d", rec.Body.Len(), len(content))
			}
			delivered++
		case http.StatusConflict, http.StatusNotFound:
		default:
			t.Fatalf("unexpected status %d", rec.Code)
		}
	}
	if delivered < 1 || delivered > limit {
		t.Fatalf("%d downloads delivered, want 1..%d", delivered, limit)
	}

	row, _ := store.GetFileBySlug(e.db, slug)
	switch {
	case delivered == limit && row != nil:
		t.Fatalf("share must burn after %d delivered downloads", limit)
	case delivered < limit && (row == nil || row.DownloadCount != int64(delivered)):
		t.Fatalf("download_count must equal the %d delivered downloads, row = %+v", delivered, row)
	}
}

const wrongVerifier = "wrongwrongwrongwrongwrongwrongwrongwrongwro"

// clock is a settable time source for handlers built with a now func.
type clock struct {
	mu sync.Mutex
	t  time.Time
}

func newClock() *clock { return &clock{t: time.UnixMilli(1_900_000_000_000)} }

func (c *clock) now() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.t
}

func (c *clock) advance(d time.Duration) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.t = c.t.Add(d)
}

func format4(r *store.FileRecord) {
	v := goodVerifier
	r.Format = 4
	r.KeyVerifier = &v
}

// guess sends one download request with verifier through a router built for
// this call, so state that lives only in a handler would not carry over.
func (e *testEnv) guess(t *testing.T, now func() time.Time, path, verifier string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(http.MethodGet, path, nil)
	req.Header.Set(keyVerifierHeader, verifier)
	rec := httptest.NewRecorder()
	e.router(now).ServeHTTP(rec, req)
	return rec
}

func TestDownload_WrongVerifiersLockAFormat4ShareWithGrowingBackoff(t *testing.T) {
	e := newTestEnv(t)
	c := newClock()
	slug := e.seedV2(t, []byte("blob"), format4)
	path := "/api/d/" + slug

	for i := range share.FreeVerifierFailures {
		if rec := e.guess(t, c.now, path, wrongVerifier); rec.Code != http.StatusUnauthorized {
			t.Fatalf("free guess %d: status %d, want 401", i+1, rec.Code)
		}
	}
	if rec := e.guess(t, c.now, path, wrongVerifier); rec.Code != http.StatusUnauthorized {
		t.Fatalf("first guess past the free ones: status %d, want 401", rec.Code)
	}

	locked := e.guess(t, c.now, path, goodVerifier)
	if locked.Code != http.StatusTooManyRequests {
		t.Fatalf("right verifier while locked: status %d, want 429", locked.Code)
	}
	if ra := locked.Header().Get("Retry-After"); ra != "1" {
		t.Fatalf("Retry-After = %q, want 1", ra)
	}
	var body errorBody
	decodeJSON(t, locked, &body)
	if body.Error != "too many requests" {
		t.Fatalf("error = %q, want the rate limiter's too many requests", body.Error)
	}

	c.advance(time.Second)
	if rec := e.guess(t, c.now, path, wrongVerifier); rec.Code != http.StatusUnauthorized {
		t.Fatalf("guess after the lock: status %d, want 401", rec.Code)
	}
	if ra := e.guess(t, c.now, path, wrongVerifier).Header().Get("Retry-After"); ra != "2" {
		t.Fatalf("second lock: Retry-After = %q, want 2", ra)
	}
}

func TestDownload_RightVerifierResetsTheBackoff(t *testing.T) {
	e := newTestEnv(t)
	c := newClock()
	slug := e.seedV2(t, []byte("blob"), format4)
	header := "/api/d/" + slug + "/header"

	for range share.FreeVerifierFailures + 1 {
		e.guess(t, c.now, header, wrongVerifier)
	}
	c.advance(time.Second)
	// The header route answers 404 for format 4, but only after the verifier.
	if rec := e.guess(t, c.now, header, goodVerifier); rec.Code == http.StatusTooManyRequests || rec.Code == http.StatusUnauthorized {
		t.Fatalf("right verifier after the lock: status %d", rec.Code)
	}
	for i := range share.FreeVerifierFailures {
		if rec := e.guess(t, c.now, header, wrongVerifier); rec.Code != http.StatusUnauthorized {
			t.Fatalf("guess %d after the reset: status %d, want 401", i+1, rec.Code)
		}
	}
	if rec := e.guess(t, c.now, "/api/d/"+slug, goodVerifier); rec.Code != http.StatusOK {
		t.Fatalf("download after the reset: status %d, want 200", rec.Code)
	}
}

func TestDownload_GuessesOnTheHeaderRouteCountTowardTheLock(t *testing.T) {
	e := newTestEnv(t)
	c := newClock()
	slug := e.seedV2(t, []byte("blob"), format4)

	for range share.FreeVerifierFailures + 1 {
		e.guess(t, c.now, "/api/d/"+slug+"/header", wrongVerifier)
	}
	if rec := e.guess(t, c.now, "/api/d/"+slug, goodVerifier); rec.Code != http.StatusTooManyRequests {
		t.Fatalf("download after header guesses: status %d, want 429", rec.Code)
	}
}

func TestDownload_ParallelWrongVerifiersGetNoExtraGuesses(t *testing.T) {
	e := newTestEnv(t)
	c := newClock()
	slug := e.seedV2(t, []byte("blob"), format4)
	h := e.router(c.now)

	const clients = 40
	codes := make([]int, clients)
	var wg sync.WaitGroup
	for i := range codes {
		wg.Go(func() {
			req := httptest.NewRequest(http.MethodGet, "/api/d/"+slug, nil)
			req.Header.Set(keyVerifierHeader, wrongVerifier)
			rec := httptest.NewRecorder()
			h.ServeHTTP(rec, req)
			codes[i] = rec.Code
		})
	}
	wg.Wait()

	compared := 0
	for _, code := range codes {
		switch code {
		case http.StatusUnauthorized:
			compared++
		case http.StatusTooManyRequests:
		default:
			t.Fatalf("unexpected status %d", code)
		}
	}
	if compared != share.FreeVerifierFailures+1 {
		t.Fatalf("%d guesses were compared, want %d", compared, share.FreeVerifierFailures+1)
	}
}

func TestDownload_LockStaysWithItsShare(t *testing.T) {
	e := newTestEnv(t)
	c := newClock()
	attacked := e.seedV2(t, []byte("blob"), format4)
	other := e.seedV2(t, []byte("other"), format4)

	for range share.FreeVerifierFailures + 1 {
		e.guess(t, c.now, "/api/d/"+attacked, wrongVerifier)
	}
	if rec := e.guess(t, c.now, "/api/d/"+other, goodVerifier); rec.Code != http.StatusOK {
		t.Fatalf("other share: status %d, want 200", rec.Code)
	}
}

func TestDownload_MissingVerifierIsNoGuess(t *testing.T) {
	e := newTestEnv(t)
	c := newClock()
	slug := e.seedV2(t, []byte("blob"), format4)

	for range 3 * share.FreeVerifierFailures {
		if rec := e.guess(t, c.now, "/api/d/"+slug, ""); rec.Code != http.StatusUnauthorized {
			t.Fatalf("request without a verifier: status %d, want 401", rec.Code)
		}
	}
	if rec := e.guess(t, c.now, "/api/d/"+slug, goodVerifier); rec.Code != http.StatusOK {
		t.Fatalf("right verifier: status %d, want 200", rec.Code)
	}
}

// Formats 2 and 3 hand their password material to anyone with the slug, so a
// lock would protect nothing and only let a slug holder block the recipient.
func TestDownload_OlderFormatsAreNeverLocked(t *testing.T) {
	e := newTestEnv(t)
	c := newClock()
	v := goodVerifier
	slug := e.seedV2(t, []byte("blob"), func(r *store.FileRecord) { r.KeyVerifier = &v })

	for range 3 * share.FreeVerifierFailures {
		if rec := e.guess(t, c.now, "/api/d/"+slug, wrongVerifier); rec.Code != http.StatusUnauthorized {
			t.Fatalf("wrong guess: status %d, want 401", rec.Code)
		}
	}
	if rec := e.guess(t, c.now, "/api/d/"+slug, goodVerifier); rec.Code != http.StatusOK {
		t.Fatalf("right verifier: status %d, want 200", rec.Code)
	}
}
