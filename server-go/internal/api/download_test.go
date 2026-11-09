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
