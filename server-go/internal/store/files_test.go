package store

import (
	"database/sql"
	"path/filepath"
	"sync"
	"testing"
)

// openTestDB opens a fresh schema-applied SQLite DB in a temp dir.
func openTestDB(t *testing.T) *sql.DB {
	t.Helper()
	db, err := Open(filepath.Join(t.TempDir(), "db.sqlite"))
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	t.Cleanup(func() { _ = db.Close() })
	return db
}

func strp(s string) *string { return &s }
func i64p(v int64) *int64   { return &v }

// sampleRecord returns a fully-populated zero-knowledge (format=2) record.
func sampleRecord(slug string) FileRecord {
	return FileRecord{
		ID:              slug + "-id",
		Slug:            slug,
		OriginalName:    "",
		Size:            2048,
		Mime:            nil,
		PasswordHash:    nil,
		ExpiresAt:       i64p(5000),
		CreatedAt:       1000,
		MaxDownloads:    nil,
		Encrypted:       0,
		EncMode:         nil,
		EncKeyWrapped:   nil,
		Format:          2,
		WrappedKey:      []byte{0x01, 0x02, 0x03},
		KDFSalt:         []byte{0xaa, 0xbb},
		KeyVerifier:     strp("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ"),
		ManageTokenHash: strp("hash-value"),
	}
}

func TestCreateAndGetFileBySlug(t *testing.T) {
	db := openTestDB(t)
	rec := sampleRecord("slugA")

	if err := CreateFileRecord(db, rec); err != nil {
		t.Fatalf("CreateFileRecord: %v", err)
	}

	got, err := GetFileBySlug(db, "slugA")
	if err != nil {
		t.Fatalf("GetFileBySlug: %v", err)
	}
	if got == nil {
		t.Fatal("GetFileBySlug returned nil for an existing slug")
	}

	if got.ID != rec.ID || got.Slug != rec.Slug || got.Size != rec.Size {
		t.Errorf("scalar mismatch: got %+v", got)
	}
	if got.DownloadCount != 0 {
		t.Errorf("download_count default = %d, want 0", got.DownloadCount)
	}
	if got.Format != 2 {
		t.Errorf("format = %d, want 2", got.Format)
	}
	if got.Mime != nil || got.PasswordHash != nil || got.MaxDownloads != nil {
		t.Errorf("expected NULL pointers to scan as nil: %+v", got)
	}
	if got.ExpiresAt == nil || *got.ExpiresAt != 5000 {
		t.Errorf("expires_at = %v, want 5000", got.ExpiresAt)
	}
	if got.KeyVerifier == nil || *got.KeyVerifier != *rec.KeyVerifier {
		t.Errorf("key_verifier = %v, want %v", got.KeyVerifier, rec.KeyVerifier)
	}
	if got.ManageTokenHash == nil || *got.ManageTokenHash != *rec.ManageTokenHash {
		t.Errorf("manage_token_hash = %v, want %v", got.ManageTokenHash, rec.ManageTokenHash)
	}
	if string(got.WrappedKey) != string(rec.WrappedKey) {
		t.Errorf("wrapped_key = %v, want %v", got.WrappedKey, rec.WrappedKey)
	}
	if string(got.KDFSalt) != string(rec.KDFSalt) {
		t.Errorf("kdf_salt = %v, want %v", got.KDFSalt, rec.KDFSalt)
	}
}

func TestGetFileBySlugNotFound(t *testing.T) {
	db := openTestDB(t)
	got, err := GetFileBySlug(db, "missing")
	if err != nil {
		t.Fatalf("GetFileBySlug error for missing slug: %v", err)
	}
	if got != nil {
		t.Errorf("GetFileBySlug(missing) = %+v, want nil", got)
	}
}

func TestCreateNullBlobsStoreAsNull(t *testing.T) {
	db := openTestDB(t)
	rec := sampleRecord("slugNull")
	rec.WrappedKey = nil
	rec.KDFSalt = nil
	if err := CreateFileRecord(db, rec); err != nil {
		t.Fatalf("CreateFileRecord: %v", err)
	}

	// Verify the columns are SQL NULL, not zero-length blobs.
	var wkNull, ksNull bool
	if err := db.QueryRow(
		"SELECT wrapped_key IS NULL, kdf_salt IS NULL FROM files WHERE slug=?",
		"slugNull",
	).Scan(&wkNull, &ksNull); err != nil {
		t.Fatalf("query nullness: %v", err)
	}
	if !wkNull || !ksNull {
		t.Errorf("expected NULL blobs, got wrapped_key NULL=%v kdf_salt NULL=%v", wkNull, ksNull)
	}

	got, err := GetFileBySlug(db, "slugNull")
	if err != nil {
		t.Fatalf("GetFileBySlug: %v", err)
	}
	if got.WrappedKey != nil || got.KDFSalt != nil {
		t.Errorf("nil blobs should scan back as nil: %+v", got)
	}
}

func TestCreateDuplicateSlugFails(t *testing.T) {
	db := openTestDB(t)
	a := sampleRecord("dupSlug")
	b := sampleRecord("dupSlug")
	b.ID = "different-id"
	if err := CreateFileRecord(db, a); err != nil {
		t.Fatalf("first insert: %v", err)
	}
	if err := CreateFileRecord(db, b); err == nil {
		t.Errorf("duplicate slug insert succeeded, want UNIQUE constraint error")
	}
}

func TestRegisterDownloadUnlimitedNeverBurns(t *testing.T) {
	db := openTestDB(t)
	rec := sampleRecord("unlimited")
	rec.MaxDownloads = nil
	if err := CreateFileRecord(db, rec); err != nil {
		t.Fatalf("CreateFileRecord: %v", err)
	}

	for i := 1; i <= 5; i++ {
		res, err := RegisterDownload(db, "unlimited")
		if err != nil {
			t.Fatalf("RegisterDownload #%d: %v", i, err)
		}
		if !res.Allowed {
			t.Errorf("#%d Allowed = false, want true", i)
		}
		if res.Burned {
			t.Errorf("#%d Burned = true, want false (unlimited)", i)
		}
		if res.RecordID != rec.ID {
			t.Errorf("#%d RecordID = %q, want %q", i, res.RecordID, rec.ID)
		}
	}

	got, err := GetFileBySlug(db, "unlimited")
	if err != nil || got == nil {
		t.Fatalf("row should still exist: got=%v err=%v", got, err)
	}
	if got.DownloadCount != 5 {
		t.Errorf("download_count = %d, want 5", got.DownloadCount)
	}
}

func TestRegisterDownloadLimitOneBurnsAndDeletes(t *testing.T) {
	db := openTestDB(t)
	rec := sampleRecord("limit1")
	rec.MaxDownloads = i64p(1)
	if err := CreateFileRecord(db, rec); err != nil {
		t.Fatalf("CreateFileRecord: %v", err)
	}

	// First (and only allowed) download: allowed + burned, row deleted.
	res, err := RegisterDownload(db, "limit1")
	if err != nil {
		t.Fatalf("RegisterDownload #1: %v", err)
	}
	if !res.Allowed || !res.Burned {
		t.Errorf("#1 = {Allowed:%v Burned:%v}, want both true", res.Allowed, res.Burned)
	}
	if res.RecordID != rec.ID {
		t.Errorf("#1 RecordID = %q, want %q", res.RecordID, rec.ID)
	}

	// The row must be gone.
	got, err := GetFileBySlug(db, "limit1")
	if err != nil {
		t.Fatalf("GetFileBySlug after burn: %v", err)
	}
	if got != nil {
		t.Errorf("row still present after burn: %+v", got)
	}

	// Second download: not allowed (row gone), not burned.
	res2, err := RegisterDownload(db, "limit1")
	if err != nil {
		t.Fatalf("RegisterDownload #2: %v", err)
	}
	if res2.Allowed {
		t.Errorf("#2 Allowed = true, want false (already burned)")
	}
	if res2.Burned {
		t.Errorf("#2 Burned = true, want false")
	}
	if res2.RecordID != "" {
		t.Errorf("#2 RecordID = %q, want empty", res2.RecordID)
	}
}

func TestRegisterDownloadLimitTwo(t *testing.T) {
	db := openTestDB(t)
	rec := sampleRecord("limit2")
	rec.MaxDownloads = i64p(2)
	if err := CreateFileRecord(db, rec); err != nil {
		t.Fatalf("CreateFileRecord: %v", err)
	}

	// #1: allowed, not burned (1 < 2).
	r1, err := RegisterDownload(db, "limit2")
	if err != nil {
		t.Fatalf("#1: %v", err)
	}
	if !r1.Allowed || r1.Burned {
		t.Errorf("#1 = {Allowed:%v Burned:%v}, want {true,false}", r1.Allowed, r1.Burned)
	}

	// #2: allowed and burned (count reaches 2 == max), row deleted.
	r2, err := RegisterDownload(db, "limit2")
	if err != nil {
		t.Fatalf("#2: %v", err)
	}
	if !r2.Allowed || !r2.Burned {
		t.Errorf("#2 = {Allowed:%v Burned:%v}, want {true,true}", r2.Allowed, r2.Burned)
	}

	if got, _ := GetFileBySlug(db, "limit2"); got != nil {
		t.Errorf("row present after second burn: %+v", got)
	}

	// #3: not allowed.
	r3, err := RegisterDownload(db, "limit2")
	if err != nil {
		t.Fatalf("#3: %v", err)
	}
	if r3.Allowed {
		t.Errorf("#3 Allowed = true, want false")
	}
}

func TestRegisterDownloadMissingSlug(t *testing.T) {
	db := openTestDB(t)
	res, err := RegisterDownload(db, "nope")
	if err != nil {
		t.Fatalf("RegisterDownload(missing): %v", err)
	}
	if res.Allowed || res.Burned || res.RecordID != "" {
		t.Errorf("missing slug result = %+v, want zero/disallowed", res)
	}
}

// TestRegisterDownloadConcurrentLimit verifies that under concurrent download
// pressure a limited share is bumped at most max_downloads times and burned
// exactly once — the atomic count++/delete must never exceed the limit.
//
// This deliberately calls RegisterDownload from many goroutines with NO external
// mutex, exercising the SAME store.Open the production main.go uses. Open now
// configures busy_timeout + WAL + a single connection, so concurrent write
// transactions serialize cleanly instead of failing with "database is locked"
// (which previously surfaced as spurious 404s). The test therefore asserts BOTH
// the limit invariant AND that every contending writer succeeds (errs == 0).
func TestRegisterDownloadConcurrentLimit(t *testing.T) {
	db := openTestDB(t)
	const limit = 5
	const goroutines = 50
	rec := sampleRecord("conc")
	rec.MaxDownloads = i64p(limit)
	if err := CreateFileRecord(db, rec); err != nil {
		t.Fatalf("CreateFileRecord: %v", err)
	}

	var (
		mu          sync.Mutex
		allowed     int
		burnedCount int
		errs        int
		wg          sync.WaitGroup
	)
	for i := 0; i < goroutines; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			res, err := RegisterDownload(db, "conc")
			mu.Lock()
			defer mu.Unlock()
			if err != nil {
				errs++
				return
			}
			if res.Allowed {
				allowed++
			}
			if res.Burned {
				burnedCount++
			}
		}()
	}
	wg.Wait()

	if errs != 0 {
		t.Errorf("RegisterDownload errors = %d, want 0 (writers must serialize, not fail)", errs)
	}
	if allowed != limit {
		t.Errorf("allowed downloads = %d, want exactly %d", allowed, limit)
	}
	if burnedCount != 1 {
		t.Errorf("burned count = %d, want exactly 1", burnedCount)
	}
	if got, _ := GetFileBySlug(db, "conc"); got != nil {
		t.Errorf("row present after concurrent burn: %+v", got)
	}
}

func TestDeleteFileBySlug(t *testing.T) {
	db := openTestDB(t)
	rec := sampleRecord("delme")
	if err := CreateFileRecord(db, rec); err != nil {
		t.Fatalf("CreateFileRecord: %v", err)
	}

	id, ok, err := DeleteFileBySlug(db, "delme")
	if err != nil {
		t.Fatalf("DeleteFileBySlug: %v", err)
	}
	if !ok {
		t.Fatal("DeleteFileBySlug ok = false, want true")
	}
	if id != rec.ID {
		t.Errorf("returned id = %q, want %q", id, rec.ID)
	}

	if got, _ := GetFileBySlug(db, "delme"); got != nil {
		t.Errorf("row present after delete: %+v", got)
	}

	// Deleting again: not found.
	id2, ok2, err := DeleteFileBySlug(db, "delme")
	if err != nil {
		t.Fatalf("second DeleteFileBySlug: %v", err)
	}
	if ok2 || id2 != "" {
		t.Errorf("second delete = (%q,%v), want (\"\",false)", id2, ok2)
	}
}

func TestDeleteFileBySlugMissing(t *testing.T) {
	db := openTestDB(t)
	id, ok, err := DeleteFileBySlug(db, "ghost")
	if err != nil {
		t.Fatalf("DeleteFileBySlug(missing): %v", err)
	}
	if ok || id != "" {
		t.Errorf("missing delete = (%q,%v), want (\"\",false)", id, ok)
	}
}

func TestListExpired(t *testing.T) {
	db := openTestDB(t)

	// expired at 1000
	expired := sampleRecord("expired")
	expired.ExpiresAt = i64p(1000)
	// not yet expired
	future := sampleRecord("future")
	future.ExpiresAt = i64p(9999)
	// never expires (NULL)
	never := sampleRecord("never")
	never.ExpiresAt = nil
	// exactly at now (<= now is expired)
	atNow := sampleRecord("atnow")
	atNow.ExpiresAt = i64p(5000)

	for _, r := range []FileRecord{expired, future, never, atNow} {
		if err := CreateFileRecord(db, r); err != nil {
			t.Fatalf("CreateFileRecord(%s): %v", r.Slug, err)
		}
	}

	got, err := ListExpired(db, 5000)
	if err != nil {
		t.Fatalf("ListExpired: %v", err)
	}

	slugs := map[string]bool{}
	for _, r := range got {
		slugs[r.Slug] = true
	}
	if !slugs["expired"] {
		t.Errorf("expired share missing from ListExpired")
	}
	if !slugs["atnow"] {
		t.Errorf("at-now share (<= now) missing from ListExpired")
	}
	if slugs["future"] {
		t.Errorf("future share wrongly listed as expired")
	}
	if slugs["never"] {
		t.Errorf("never-expiring (NULL) share wrongly listed as expired")
	}
	if len(got) != 2 {
		t.Errorf("ListExpired returned %d rows, want 2", len(got))
	}
}

func TestListExpiredEmpty(t *testing.T) {
	db := openTestDB(t)
	got, err := ListExpired(db, 1)
	if err != nil {
		t.Fatalf("ListExpired: %v", err)
	}
	if len(got) != 0 {
		t.Errorf("ListExpired on empty DB = %d rows, want 0", len(got))
	}
}

func TestTotalStoredSize(t *testing.T) {
	db := openTestDB(t)

	// Empty table sums to 0 (COALESCE, not NULL/error).
	total, err := TotalStoredSize(db)
	if err != nil {
		t.Fatalf("TotalStoredSize (empty): %v", err)
	}
	if total != 0 {
		t.Errorf("empty total = %d, want 0", total)
	}

	// Sum tracks inserts…
	recA := sampleRecord("sizeA")
	recA.Size = 100
	recB := sampleRecord("sizeB")
	recB.ID = "sizeB-id"
	recB.Size = 250
	for _, rec := range []FileRecord{recA, recB} {
		if err := CreateFileRecord(db, rec); err != nil {
			t.Fatalf("CreateFileRecord(%s): %v", rec.Slug, err)
		}
	}
	total, err = TotalStoredSize(db)
	if err != nil {
		t.Fatalf("TotalStoredSize: %v", err)
	}
	if total != 350 {
		t.Errorf("total = %d, want 350", total)
	}

	// …and deletes (a burned/expired share frees its quota share).
	if _, ok, err := DeleteFileBySlug(db, "sizeA"); err != nil || !ok {
		t.Fatalf("DeleteFileBySlug: ok=%v err=%v", ok, err)
	}
	total, err = TotalStoredSize(db)
	if err != nil {
		t.Fatalf("TotalStoredSize (after delete): %v", err)
	}
	if total != 250 {
		t.Errorf("total after delete = %d, want 250", total)
	}

	// Method form stays covered.
	if got, err := New(db).TotalStoredSize(); err != nil || got != 250 {
		t.Errorf("Store.TotalStoredSize = (%d, %v), want (250, nil)", got, err)
	}
}

// TestStoreMethodForms exercises the *Store method wrappers so both call styles
// stay covered.
func TestStoreMethodForms(t *testing.T) {
	s := New(openTestDB(t))
	rec := sampleRecord("methods")
	rec.MaxDownloads = i64p(1)
	if err := s.CreateFileRecord(rec); err != nil {
		t.Fatalf("CreateFileRecord: %v", err)
	}
	got, err := s.GetFileBySlug("methods")
	if err != nil || got == nil {
		t.Fatalf("GetFileBySlug: got=%v err=%v", got, err)
	}
	res, err := s.RegisterDownload("methods")
	if err != nil {
		t.Fatalf("RegisterDownload: %v", err)
	}
	if !res.Allowed || !res.Burned {
		t.Errorf("RegisterDownload = %+v, want allowed+burned", res)
	}
	if _, ok, err := s.DeleteFileBySlug("methods"); err != nil || ok {
		t.Errorf("DeleteFileBySlug after burn = (ok=%v err=%v), want (false,nil)", ok, err)
	}
	if rows, err := s.ListExpired(1); err != nil || rows != nil {
		t.Errorf("ListExpired = (%v, %v), want (nil, nil)", rows, err)
	}
}
