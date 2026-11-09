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

	"github.com/junkerderprovinz/castleparcel/server-go/internal/share"
	"github.com/junkerderprovinz/castleparcel/server-go/internal/store"
)

// brokenWriter accepts limit bytes and then fails every write, like a client
// that drops the connection mid-stream. beforeBreak runs once, just before the
// first failing write.
type brokenWriter struct {
	header      http.Header
	code        int
	limit       int
	got         bytes.Buffer
	beforeBreak func()
}

func newBrokenWriter(limit int) *brokenWriter {
	return &brokenWriter{header: http.Header{}, limit: limit}
}

func (b *brokenWriter) Header() http.Header  { return b.header }
func (b *brokenWriter) WriteHeader(code int) { b.code = code }

func (b *brokenWriter) Write(p []byte) (int, error) {
	room := b.limit - b.got.Len()
	if len(p) <= room {
		return b.got.Write(p)
	}
	if b.beforeBreak != nil {
		b.beforeBreak()
		b.beforeBreak = nil
	}
	if room <= 0 {
		return 0, errors.New("connection reset")
	}
	b.got.Write(p[:room])
	return room, errors.New("connection reset")
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

// resume sends a download request that carries token and, unless empty, a
// Range header.
func (e *testEnv) resume(t *testing.T, now func() time.Time, slug, token, rng string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(http.MethodGet, "/api/d/"+slug, nil)
	if token != "" {
		req.Header.Set(resumeTokenHeader, token)
	}
	if rng != "" {
		req.Header.Set("Range", rng)
	}
	rec := httptest.NewRecorder()
	e.router(now).ServeHTTP(rec, req)
	return rec
}

// abort starts a download of slug that breaks after n bytes and returns its
// resume token.
func (e *testEnv) abort(t *testing.T, now func() time.Time, slug string, n int) string {
	t.Helper()
	w := newBrokenWriter(n)
	getShare(t, e.router(now), w, slug)
	if w.code != http.StatusOK {
		t.Fatalf("aborted download: status %d, want 200", w.code)
	}
	token := w.header.Get(resumeTokenHeader)
	if !share.IsValidManageToken(token) {
		t.Fatalf("aborted download: resume token %q", token)
	}
	return token
}

func blobExists(t *testing.T, e *testEnv, id string) bool {
	t.Helper()
	_, err := os.Stat(filepath.Join(e.cfg.UploadsDir, id))
	return err == nil
}

func TestDownload_AbortedDownloadCounts(t *testing.T) {
	tests := []struct {
		name  string
		limit func(*store.FileRecord)
		w     func() http.ResponseWriter
	}{
		{"unlimited share", nil, func() http.ResponseWriter { return newBrokenWriter(500) }},
		{"once-only share", limitedTo(1), func() http.ResponseWriter { return newBrokenWriter(500) }},
		{"one byte short", limitedTo(1), func() http.ResponseWriter { return newBrokenWriter(999) }},
		{"failed final flush", limitedTo(1), func() http.ResponseWriter { return unflushableWriter{httptest.NewRecorder()} }},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			e := newTestEnv(t)
			slug := e.seedV2(t, bytes.Repeat([]byte("ciphertext"), 100), tt.limit)

			getShare(t, e.router(nil), tt.w(), slug)

			row, err := store.GetFileBySlug(e.db, slug)
			if err != nil || row == nil {
				t.Fatalf("the share must wait for a resume (row %v, err %v)", row, err)
			}
			if row.DownloadCount != 1 {
				t.Fatalf("download_count = %d, want 1", row.DownloadCount)
			}
			if !blobExists(t, e, row.ID) {
				t.Fatalf("the blob must wait for a resume")
			}
		})
	}
}

func TestDownload_ResumeWithTokenCompletesWithoutASecondCount(t *testing.T) {
	e := newTestEnv(t)
	content := bytes.Repeat([]byte("0123456789abcdef"), 256)
	slug := e.seedV2(t, content, limitedTo(1))
	row, _ := store.GetFileBySlug(e.db, slug)

	token := e.abort(t, nil, slug, 100)

	// Each request builds its handlers afresh, as after a restart.
	rec := e.resume(t, nil, slug, token, "bytes=100-")
	if rec.Code != http.StatusPartialContent {
		t.Fatalf("resume: status %d, want 206", rec.Code)
	}
	if cr := rec.Header().Get("Content-Range"); cr != "bytes 100-4095/4096" {
		t.Fatalf("Content-Range = %q", cr)
	}
	if !bytes.Equal(rec.Body.Bytes(), content[100:]) {
		t.Fatalf("resume body: %d bytes, want the %d after the break", rec.Body.Len(), len(content)-100)
	}
	if r, _ := store.GetFileBySlug(e.db, slug); r != nil {
		t.Fatalf("the completed download must burn the share, row = %+v", r)
	}
	if blobExists(t, e, row.ID) {
		t.Fatalf("the burned blob must be removed")
	}
	if again := e.resume(t, nil, slug, token, "bytes=0-"); again.Code != http.StatusNotFound {
		t.Fatalf("token after completion: status %d, want 404", again.Code)
	}
}

func TestDownload_ResumeOfAnUnlimitedShareIsNotCountedAgain(t *testing.T) {
	e := newTestEnv(t)
	content := bytes.Repeat([]byte("u"), 2048)
	slug := e.seedV2(t, content, nil)

	token := e.abort(t, nil, slug, 10)
	rec := e.resume(t, nil, slug, token, "")
	if rec.Code != http.StatusOK || !bytes.Equal(rec.Body.Bytes(), content) {
		t.Fatalf("resume without a range: status %d, %d bytes, want 200 with the whole blob", rec.Code, rec.Body.Len())
	}
	if row, _ := store.GetFileBySlug(e.db, slug); row == nil || row.DownloadCount != 1 {
		t.Fatalf("row = %+v, want download_count 1", row)
	}
	if again := e.resume(t, nil, slug, token, ""); again.Code != http.StatusNotFound {
		t.Fatalf("token after completion: status %d, want 404", again.Code)
	}
}

func TestDownload_ResumeWithoutTokenIsRefused(t *testing.T) {
	e := newTestEnv(t)
	slug := e.seedV2(t, bytes.Repeat([]byte("x"), 1000), limitedTo(1))
	e.abort(t, nil, slug, 100)

	rec := e.resume(t, nil, slug, "", "bytes=100-")
	if rec.Code != http.StatusConflict {
		t.Fatalf("range without a token: status %d, want 409", rec.Code)
	}
	if row, _ := store.GetFileBySlug(e.db, slug); row == nil || row.DownloadCount != 1 {
		t.Fatalf("row = %+v, want download_count 1", row)
	}
}

func TestDownload_ResumeWithWrongTokenIsRefused(t *testing.T) {
	e := newTestEnv(t)
	c := newClock()
	slug := e.seedV2(t, bytes.Repeat([]byte("x"), 1000), limitedTo(2))
	other := e.seedV2(t, bytes.Repeat([]byte("y"), 1000), nil)
	token := e.abort(t, c.now, slug, 100)
	otherToken := e.abort(t, c.now, other, 100)

	tests := []struct {
		name  string
		token string
		later time.Duration
	}{
		{"made-up token", share.NewManageToken(), 0},
		{"malformed token", "x", 0},
		{"token of another share", otherToken, 0},
		{"token idle for the whole window", token, share.ResumeIdle},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			c.advance(tt.later)
			if rec := e.resume(t, c.now, slug, tt.token, "bytes=100-"); rec.Code != http.StatusNotFound {
				t.Fatalf("status %d, want 404", rec.Code)
			}
			if row, _ := store.GetFileBySlug(e.db, slug); row == nil || row.DownloadCount != 1 {
				t.Fatalf("row = %+v, want download_count 1", row)
			}
		})
	}
}

func TestDownload_ResumeWindowCountsFromTheBreak(t *testing.T) {
	e := newTestEnv(t)
	c := newClock()
	slug := e.seedV2(t, bytes.Repeat([]byte("s"), 1000), limitedTo(1))

	w := newBrokenWriter(100)
	w.beforeBreak = func() { c.advance(20 * time.Minute) }
	getShare(t, e.router(c.now), w, slug)
	token := w.header.Get(resumeTokenHeader)

	c.advance(25 * time.Minute)
	if rec := e.resume(t, c.now, slug, token, "bytes=100-"); rec.Code != http.StatusPartialContent {
		t.Fatalf("resume 25 min after a break 20 min into the stream: status %d, want 206", rec.Code)
	}
}

func TestDownload_ResumeOutsideTheBlobIs416(t *testing.T) {
	e := newTestEnv(t)
	slug := e.seedV2(t, bytes.Repeat([]byte("x"), 1000), limitedTo(1))
	token := e.abort(t, nil, slug, 100)

	if rec := e.resume(t, nil, slug, token, "bytes=1000-"); rec.Code != http.StatusRequestedRangeNotSatisfiable {
		t.Fatalf("status %d, want 416", rec.Code)
	}
	if rec := e.resume(t, nil, slug, token, "bytes=100-"); rec.Code != http.StatusPartialContent {
		t.Fatalf("the token must survive a 416, status %d", rec.Code)
	}
}

func TestDownload_ResumeStillNeedsTheKeyVerifier(t *testing.T) {
	e := newTestEnv(t)
	v := goodVerifier
	slug := e.seedV2(t, bytes.Repeat([]byte("x"), 1000), func(r *store.FileRecord) {
		r.KeyVerifier = &v
		r.MaxDownloads = new(int64(1))
	})
	w := newBrokenWriter(100)
	req := httptest.NewRequest(http.MethodGet, "/api/d/"+slug, nil)
	req.Header.Set(keyVerifierHeader, v)
	e.router(nil).ServeHTTP(w, req)

	if rec := e.resume(t, nil, slug, w.header.Get(resumeTokenHeader), "bytes=100-"); rec.Code != http.StatusUnauthorized {
		t.Fatalf("resume without the verifier: status %d, want 401", rec.Code)
	}
}

func TestDownload_ParallelAbortedDownloadsNeverExceedTheLimit(t *testing.T) {
	const limit = 3
	e := newTestEnv(t)
	slug := e.seedV2(t, bytes.Repeat([]byte("p"), 8192), limitedTo(limit))
	h := e.router(nil)

	const clients = 16
	ws := make([]*brokenWriter, clients)
	var wg sync.WaitGroup
	for i := range ws {
		ws[i] = newBrokenWriter(64)
		wg.Go(func() { getShare(t, h, ws[i], slug) })
	}
	wg.Wait()

	started := 0
	for _, w := range ws {
		switch w.code {
		case http.StatusOK:
			started++
		case http.StatusConflict:
		default:
			t.Fatalf("unexpected status %d", w.code)
		}
	}
	row, _ := store.GetFileBySlug(e.db, slug)
	if started != limit || row == nil || row.DownloadCount != limit {
		t.Fatalf("%d started, row %+v; want exactly %d counted and the row kept for resumes", started, row, limit)
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

func format4WithVerifier(r *store.FileRecord) {
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
	slug := e.seedV2(t, []byte("blob"), format4WithVerifier)
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
	slug := e.seedV2(t, []byte("blob"), format4WithVerifier)
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
	slug := e.seedV2(t, []byte("blob"), format4WithVerifier)

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
	slug := e.seedV2(t, []byte("blob"), format4WithVerifier)
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
	attacked := e.seedV2(t, []byte("blob"), format4WithVerifier)
	other := e.seedV2(t, []byte("other"), format4WithVerifier)

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
	slug := e.seedV2(t, []byte("blob"), format4WithVerifier)

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
