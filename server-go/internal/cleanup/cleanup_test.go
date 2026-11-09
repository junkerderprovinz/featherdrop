package cleanup

import (
	"bytes"
	"context"
	"database/sql"
	"errors"
	"io/fs"
	"log"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"testing/synctest"
	"time"

	"github.com/tus/tusd/v2/pkg/filestore"
	tushandler "github.com/tus/tusd/v2/pkg/handler"

	"github.com/junkerderprovinz/featherdrop/server-go/internal/config"
	"github.com/junkerderprovinz/featherdrop/server-go/internal/share"
	"github.com/junkerderprovinz/featherdrop/server-go/internal/store"
)

func newTestEnv(t *testing.T) (config.Config, *sql.DB) {
	t.Helper()
	dataDir := t.TempDir()
	cfg := config.Config{
		DataDir:    dataDir,
		ConfigDir:  dataDir,
		UploadsDir: filepath.Join(dataDir, "uploads"),
		TmpDir:     filepath.Join(dataDir, "tmp"),
		DBPath:     filepath.Join(dataDir, "db.sqlite"),
	}
	if err := cfg.EnsureDataDirs(); err != nil {
		t.Fatalf("ensure data dirs: %v", err)
	}
	db, err := store.Open(cfg.DBPath)
	if err != nil {
		t.Fatalf("open store: %v", err)
	}
	t.Cleanup(func() { _ = db.Close() })
	return cfg, db
}

// addShare stores a share row and its blob. A nil expiresAt never expires.
func addShare(t *testing.T, cfg config.Config, db *sql.DB, slug string, size int64, expiresAt *int64) {
	t.Helper()
	id := slug + "-id"
	if err := os.WriteFile(filepath.Join(cfg.UploadsDir, id), make([]byte, size), 0o600); err != nil {
		t.Fatalf("write blob: %v", err)
	}
	rec := store.FileRecord{
		ID:        id,
		Slug:      slug,
		Size:      size,
		ExpiresAt: expiresAt,
		CreatedAt: 1,
		Format:    2,
	}
	if err := store.CreateFileRecord(db, rec); err != nil {
		t.Fatalf("create record %s: %v", slug, err)
	}
}

func i64p(v int64) *int64 { return &v }

func assertShareGone(t *testing.T, cfg config.Config, db *sql.DB, slug string) {
	t.Helper()
	rec, err := store.GetFileBySlug(db, slug)
	if err != nil {
		t.Fatalf("get %s: %v", slug, err)
	}
	if rec != nil {
		t.Errorf("share %s still has its row", slug)
	}
	if _, err := os.Stat(filepath.Join(cfg.UploadsDir, slug+"-id")); !errors.Is(err, fs.ErrNotExist) {
		t.Errorf("share %s still has its blob (stat err %v)", slug, err)
	}
}

func assertShareKept(t *testing.T, cfg config.Config, db *sql.DB, slug string) {
	t.Helper()
	rec, err := store.GetFileBySlug(db, slug)
	if err != nil {
		t.Fatalf("get %s: %v", slug, err)
	}
	if rec == nil {
		t.Errorf("share %s lost its row", slug)
	}
	if _, err := os.Stat(filepath.Join(cfg.UploadsDir, slug+"-id")); err != nil {
		t.Errorf("share %s lost its blob: %v", slug, err)
	}
}

func assertStoredSize(t *testing.T, db *sql.DB, want int64) {
	t.Helper()
	got, err := store.TotalStoredSize(db)
	if err != nil {
		t.Fatalf("total stored size: %v", err)
	}
	if got != want {
		t.Errorf("stored size = %d, want %d", got, want)
	}
}

// makeTusUpload creates an upload the way tusd does, bytes and .info sidecar,
// and backdates both files to modTime.
func makeTusUpload(t *testing.T, cfg config.Config, modTime time.Time) string {
	t.Helper()
	content := []byte("partial ciphertext")
	up, err := filestore.New(cfg.TmpDir).NewUpload(context.Background(), tushandler.FileInfo{
		Size: int64(len(content)) * 4,
	})
	if err != nil {
		t.Fatalf("new upload: %v", err)
	}
	if _, err := up.WriteChunk(context.Background(), 0, bytes.NewReader(content)); err != nil {
		t.Fatalf("write chunk: %v", err)
	}
	info, err := up.GetInfo(context.Background())
	if err != nil {
		t.Fatalf("get info: %v", err)
	}
	for _, name := range []string{info.ID, info.ID + ".info"} {
		touch(t, filepath.Join(cfg.TmpDir, name), modTime)
	}
	return info.ID
}

func touch(t *testing.T, path string, modTime time.Time) {
	t.Helper()
	if err := os.Chtimes(path, modTime, modTime); err != nil {
		t.Fatalf("chtimes: %v", err)
	}
}

func tmpFileExists(t *testing.T, cfg config.Config, name string) bool {
	t.Helper()
	_, err := os.Stat(filepath.Join(cfg.TmpDir, name))
	if err != nil && !errors.Is(err, fs.ErrNotExist) {
		t.Fatalf("stat %s: %v", name, err)
	}
	return err == nil
}

func TestSweepDeletesExpiredSharesAndTheirBlobs(t *testing.T) {
	cfg, db := newTestEnv(t)
	now := time.UnixMilli(10_000)

	addShare(t, cfg, db, "expired", 100, i64p(9_000))
	addShare(t, cfg, db, "atnow", 200, i64p(10_000))
	addShare(t, cfg, db, "future", 400, i64p(20_000))
	addShare(t, cfg, db, "never", 800, nil)

	res, err := Sweep(cfg, db, now)
	if err != nil {
		t.Fatalf("Sweep: %v", err)
	}
	if res.Shares != 2 {
		t.Errorf("Shares = %d, want 2", res.Shares)
	}
	assertShareGone(t, cfg, db, "expired")
	assertShareGone(t, cfg, db, "atnow")
	assertShareKept(t, cfg, db, "future")
	assertShareKept(t, cfg, db, "never")
	assertStoredSize(t, db, 400+800)
}

func TestSweepDeletesExpiredRowWhoseBlobIsAlreadyGone(t *testing.T) {
	cfg, db := newTestEnv(t)
	addShare(t, cfg, db, "orphanrow", 100, i64p(1))
	if err := os.Remove(filepath.Join(cfg.UploadsDir, "orphanrow-id")); err != nil {
		t.Fatalf("remove blob: %v", err)
	}

	res, err := Sweep(cfg, db, time.UnixMilli(2))
	if err != nil {
		t.Fatalf("Sweep: %v", err)
	}
	if res.Shares != 1 {
		t.Errorf("Shares = %d, want 1", res.Shares)
	}
	assertShareGone(t, cfg, db, "orphanrow")
	assertStoredSize(t, db, 0)
}

// A blob that cannot be removed must keep its row, so the quota keeps counting
// bytes that are still on disk and the next pass tries again. A non-empty
// directory in the blob's place makes os.Remove fail on every platform.
func TestSweepKeepsExpiredRowWhenBlobCannotBeRemoved(t *testing.T) {
	cfg, db := newTestEnv(t)
	addShare(t, cfg, db, "stuck", 100, i64p(1))
	addShare(t, cfg, db, "free", 200, i64p(1))

	blob := filepath.Join(cfg.UploadsDir, "stuck-id")
	if err := os.Remove(blob); err != nil {
		t.Fatalf("remove blob: %v", err)
	}
	if err := os.MkdirAll(filepath.Join(blob, "busy"), 0o700); err != nil {
		t.Fatalf("mkdir: %v", err)
	}

	res, err := Sweep(cfg, db, time.UnixMilli(2))
	if err == nil {
		t.Error("Sweep reported no error for a blob it could not remove")
	}
	if res.Shares != 1 {
		t.Errorf("Shares = %d, want 1", res.Shares)
	}
	assertShareKept(t, cfg, db, "stuck")
	assertShareGone(t, cfg, db, "free")
	assertStoredSize(t, db, 100)
}

// startOnceOnly stores a once-only share and starts its one download at nowMs,
// as a download that breaks off right away leaves it.
func startOnceOnly(t *testing.T, cfg config.Config, db *sql.DB, slug string, expiresAt *int64, nowMs int64) {
	t.Helper()
	addShare(t, cfg, db, slug, 100, expiresAt)
	if _, err := db.Exec(`UPDATE files SET max_downloads = 1 WHERE slug = ?`, slug); err != nil {
		t.Fatalf("limit %s: %v", slug, err)
	}
	got, err := store.StartDownload(db, slug, slug+"-token", nowMs)
	if err != nil || got != store.DownloadStarted {
		t.Fatalf("start %s: %v, %v", slug, got, err)
	}
}

func TestSweepKeepsAUsedUpShareWhileItsDownloadCanResume(t *testing.T) {
	cfg, db := newTestEnv(t)
	startOnceOnly(t, cfg, db, "pending", nil, 0)

	window := share.ResumeIdle.Milliseconds()
	if _, err := Sweep(cfg, db, time.UnixMilli(window-1)); err != nil {
		t.Fatalf("Sweep: %v", err)
	}
	assertShareKept(t, cfg, db, "pending")

	res, err := Sweep(cfg, db, time.UnixMilli(window))
	if err != nil {
		t.Fatalf("Sweep: %v", err)
	}
	if res.Shares != 1 {
		t.Errorf("Shares = %d, want 1", res.Shares)
	}
	assertShareGone(t, cfg, db, "pending")
	assertStoredSize(t, db, 0)
}

func TestSweepDeletesAnExpiredShareWithAPendingResume(t *testing.T) {
	cfg, db := newTestEnv(t)
	startOnceOnly(t, cfg, db, "expiring", i64p(1_000), 0)

	if _, err := Sweep(cfg, db, time.UnixMilli(1_000)); err != nil {
		t.Fatalf("Sweep: %v", err)
	}
	assertShareGone(t, cfg, db, "expiring")
	if ok, _ := store.ResumeDownload(db, "expiring", "expiring-token", 1_000); ok {
		t.Errorf("the resume outlived its expired share")
	}
}

func TestSweepRemovesUploadsUntouchedForADay(t *testing.T) {
	cfg, db := newTestEnv(t)
	now := time.Now()

	stale := makeTusUpload(t, cfg, now.Add(-25*time.Hour))
	fresh := makeTusUpload(t, cfg, now.Add(-time.Hour))
	// tusd writes the sidecar once and appends every PATCH to the bytes, so a
	// long upload that is still running has an old sidecar and fresh bytes.
	running := makeTusUpload(t, cfg, now.Add(-30*time.Hour))
	touch(t, filepath.Join(cfg.TmpDir, running), now.Add(-time.Minute))

	res, err := Sweep(cfg, db, now)
	if err != nil {
		t.Fatalf("Sweep: %v", err)
	}
	if res.Uploads != 1 {
		t.Errorf("Uploads = %d, want 1", res.Uploads)
	}
	for _, name := range []string{stale, stale + ".info"} {
		if tmpFileExists(t, cfg, name) {
			t.Errorf("stale upload file %s was kept", name)
		}
	}
	for _, name := range []string{fresh, fresh + ".info", running, running + ".info"} {
		if !tmpFileExists(t, cfg, name) {
			t.Errorf("live upload file %s was removed", name)
		}
	}
}

func TestSweepRemovesStaleUploadHalves(t *testing.T) {
	cfg, db := newTestEnv(t)
	now := time.Now()

	// Finalize removes the sidecar after moving the bytes, so a crash between
	// the two leaves a sidecar alone; a lost sidecar leaves bytes alone.
	sidecarOnly := makeTusUpload(t, cfg, now.Add(-48*time.Hour))
	if err := os.Remove(filepath.Join(cfg.TmpDir, sidecarOnly)); err != nil {
		t.Fatalf("remove bytes: %v", err)
	}
	bytesOnly := makeTusUpload(t, cfg, now.Add(-48*time.Hour))
	if err := os.Remove(filepath.Join(cfg.TmpDir, bytesOnly+".info")); err != nil {
		t.Fatalf("remove sidecar: %v", err)
	}

	res, err := Sweep(cfg, db, now)
	if err != nil {
		t.Fatalf("Sweep: %v", err)
	}
	if res.Uploads != 2 {
		t.Errorf("Uploads = %d, want 2", res.Uploads)
	}
	if tmpFileExists(t, cfg, sidecarOnly+".info") || tmpFileExists(t, cfg, bytesOnly) {
		t.Error("a stale upload half was kept")
	}
}

// lockedBuffer collects log output written from the Run goroutine.
type lockedBuffer struct {
	mu  sync.Mutex
	buf bytes.Buffer
}

func (b *lockedBuffer) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.Write(p)
}

func (b *lockedBuffer) take() string {
	b.mu.Lock()
	defer b.mu.Unlock()
	s := b.buf.String()
	b.buf.Reset()
	return s
}

func captureLog(t *testing.T) *lockedBuffer {
	t.Helper()
	out := &lockedBuffer{}
	prevOut, prevFlags := log.Writer(), log.Flags()
	log.SetOutput(out)
	log.SetFlags(0)
	t.Cleanup(func() {
		log.SetOutput(prevOut)
		log.SetFlags(prevFlags)
	})
	return out
}

func TestRunSweepsAtStartAndOnEveryTickUntilCancelled(t *testing.T) {
	logs := captureLog(t)
	synctest.Test(t, func(t *testing.T) {
		cfg, db := newTestEnv(t)
		const interval = 5 * time.Minute

		addShare(t, cfg, db, "atstart", 100, i64p(time.Now().UnixMilli()))
		addShare(t, cfg, db, "later", 200, i64p(time.Now().Add(interval/2).UnixMilli()))

		ctx, cancel := context.WithCancel(t.Context())
		done := make(chan struct{})
		go func() {
			defer close(done)
			Run(ctx, cfg, db, interval)
		}()

		synctest.Wait()
		assertShareGone(t, cfg, db, "atstart")
		assertShareKept(t, cfg, db, "later")
		if got := logs.take(); got != "cleanup: removed 1 shares, 0 stale uploads\n" {
			t.Errorf("startup log = %q", got)
		}

		time.Sleep(interval)
		synctest.Wait()
		assertShareGone(t, cfg, db, "later")
		logs.take()

		time.Sleep(interval)
		synctest.Wait()
		if got := logs.take(); got != "" {
			t.Errorf("a pass that removed nothing logged %q", got)
		}

		cancel()
		synctest.Wait()
		select {
		case <-done:
		default:
			t.Fatal("Run kept going after its context was cancelled")
		}
	})
}
