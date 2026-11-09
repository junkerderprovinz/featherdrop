package store

import (
	"database/sql"
	"strconv"
	"sync"
	"testing"
	"time"

	"github.com/junkerderprovinz/castleparcel/server-go/internal/share"
)

const t0 = int64(1_900_000_000_000)

func minutes(n int64) int64 { return n * time.Minute.Milliseconds() }

func mustCreate(t *testing.T, db *sql.DB, rec FileRecord) {
	t.Helper()
	if err := CreateFileRecord(db, rec); err != nil {
		t.Fatalf("CreateFileRecord: %v", err)
	}
}

func mustStart(t *testing.T, db *sql.DB, slug, tokenHash string, nowMs int64) {
	t.Helper()
	got, err := StartDownload(db, slug, tokenHash, nowMs)
	if err != nil || got != DownloadStarted {
		t.Fatalf("StartDownload(%s) = %v, %v", slug, got, err)
	}
}

func TestStartDownloadCountsAtOnce(t *testing.T) {
	db := openTestDB(t)
	rec := sampleRecord("once")
	rec.MaxDownloads = i64p(1)
	mustCreate(t, db, rec)

	mustStart(t, db, "once", "token-a", t0)

	row, _ := GetFileBySlug(db, "once")
	if row == nil || row.DownloadCount != 1 {
		t.Fatalf("row = %+v, want it kept with download_count 1", row)
	}
}

func TestStartDownloadOfAUsedUpShare(t *testing.T) {
	db := openTestDB(t)
	rec := sampleRecord("once")
	rec.MaxDownloads = i64p(1)
	mustCreate(t, db, rec)
	mustStart(t, db, "once", "token-a", t0)

	if got, _ := StartDownload(db, "once", "token-b", t0+1); got != DownloadBusy {
		t.Fatalf("while the first can be resumed: %v, want busy", got)
	}
	if got, _ := StartDownload(db, "once", "token-b", t0+minutes(30)); got != DownloadGone {
		t.Fatalf("after the resume window: %v, want gone", got)
	}
	if got, _ := StartDownload(db, "missing", "token-c", t0); got != DownloadGone {
		t.Fatalf("missing share: %v, want gone", got)
	}
}

func TestResumeDownloadNeedsALiveTokenOfTheSameShare(t *testing.T) {
	db := openTestDB(t)
	mustCreate(t, db, sampleRecord("a"))
	mustCreate(t, db, sampleRecord("b"))
	mustStart(t, db, "a", "token-a", t0)

	tests := []struct {
		name  string
		slug  string
		token string
		at    int64
		want  bool
	}{
		{"unknown token", "a", "token-x", t0, false},
		{"token of another share", "b", "token-a", t0, false},
		{"idle for the whole window", "a", "token-a", t0 + minutes(30), false},
		{"live token", "a", "token-a", t0 + minutes(29), true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			ok, err := ResumeDownload(db, tt.slug, tt.token, tt.at)
			if err != nil || ok != tt.want {
				t.Fatalf("ResumeDownload = %v, %v; want %v", ok, err, tt.want)
			}
		})
	}
}

func TestResumeWindowSlidesWithActivityUpToTheLifetime(t *testing.T) {
	db := openTestDB(t)
	mustCreate(t, db, sampleRecord("a"))
	mustStart(t, db, "a", "token-a", t0)
	end := t0 + share.ResumeLifetime.Milliseconds()

	for at := t0 + minutes(25); at < end; at += minutes(25) {
		if ok, _ := ResumeDownload(db, "a", "token-a", at); !ok {
			t.Fatalf("resume %d min after the count was refused", (at-t0)/minutes(1))
		}
	}
	if ok, _ := ResumeDownload(db, "a", "token-a", end); ok {
		t.Fatalf("resume at the end of the lifetime was allowed")
	}
}

func TestKeepResumableExtendsTheWindow(t *testing.T) {
	db := openTestDB(t)
	mustCreate(t, db, sampleRecord("a"))
	mustStart(t, db, "a", "token-a", t0)

	if err := KeepResumable(db, "token-a", t0+minutes(20)); err != nil {
		t.Fatalf("KeepResumable: %v", err)
	}
	if ok, _ := ResumeDownload(db, "a", "token-a", t0+minutes(45)); !ok {
		t.Fatalf("resume 25 min after the last activity was refused")
	}
}

func TestFinishDownloadBurnsAUsedUpShareAfterItsLastResume(t *testing.T) {
	db := openTestDB(t)
	rec := sampleRecord("two")
	rec.MaxDownloads = i64p(2)
	mustCreate(t, db, rec)
	mustStart(t, db, "two", "token-a", t0)
	mustStart(t, db, "two", "token-b", t0)

	res, err := FinishDownload(db, "token-a")
	if err != nil || res.Burned {
		t.Fatalf("first finish = %+v, %v; want the share kept for the other download", res, err)
	}
	res, err = FinishDownload(db, "token-b")
	if err != nil || !res.Burned || res.RecordID != rec.ID {
		t.Fatalf("last finish = %+v, %v; want a burn of %s", res, err, rec.ID)
	}
	if row, _ := GetFileBySlug(db, "two"); row != nil {
		t.Fatalf("row still there after the burn")
	}
}

func TestFinishDownloadKeepsAnUnlimitedShareAndRetiresTheToken(t *testing.T) {
	db := openTestDB(t)
	mustCreate(t, db, sampleRecord("open"))
	mustStart(t, db, "open", "token-a", t0)

	res, err := FinishDownload(db, "token-a")
	if err != nil || res.Burned {
		t.Fatalf("FinishDownload = %+v, %v; want no burn", res, err)
	}
	if ok, _ := ResumeDownload(db, "open", "token-a", t0); ok {
		t.Fatalf("a finished token resumed")
	}
	if res, err := FinishDownload(db, "token-a"); err != nil || res.Burned {
		t.Fatalf("second finish of one token = %+v, %v; want nothing", res, err)
	}
}

func TestStartDownloadNeverExceedsTheLimitUnderContention(t *testing.T) {
	db := openTestDB(t)
	const limit, clients = 5, 50
	rec := sampleRecord("conc")
	rec.MaxDownloads = i64p(limit)
	mustCreate(t, db, rec)

	results := make([]DownloadStart, clients)
	errs := make([]error, clients)
	var wg sync.WaitGroup
	for i := range clients {
		wg.Go(func() {
			results[i], errs[i] = StartDownload(db, "conc", "token-"+strconv.Itoa(i), t0)
		})
	}
	wg.Wait()

	started := 0
	for i, r := range results {
		if errs[i] != nil {
			t.Fatalf("StartDownload: %v (writers must wait, not fail)", errs[i])
		}
		if r == DownloadStarted {
			started++
		}
	}
	row, _ := GetFileBySlug(db, "conc")
	if started != limit || row == nil || row.DownloadCount != limit {
		t.Fatalf("%d started, row %+v; want exactly %d counted and the row kept", started, row, limit)
	}
}

func TestListAbandonedFindsUsedUpSharesWithoutALiveResume(t *testing.T) {
	db := openTestDB(t)
	once := sampleRecord("once")
	once.MaxDownloads = i64p(1)
	mustCreate(t, db, once)
	mustCreate(t, db, sampleRecord("open"))
	mustStart(t, db, "once", "token-a", t0)
	mustStart(t, db, "open", "token-b", t0)

	if got, _ := ListAbandoned(db, t0+minutes(29)); len(got) != 0 {
		t.Fatalf("abandoned within the window: %d, want 0", len(got))
	}
	got, err := ListAbandoned(db, t0+minutes(30))
	if err != nil || len(got) != 1 || got[0].Slug != "once" {
		t.Fatalf("ListAbandoned = %+v, %v; want only the used-up share", got, err)
	}
}

func TestDeleteStaleResumes(t *testing.T) {
	db := openTestDB(t)
	mustCreate(t, db, sampleRecord("open"))
	mustStart(t, db, "open", "token-a", t0)
	mustStart(t, db, "open", "token-b", t0+minutes(10))

	n, err := DeleteStaleResumes(db, t0+minutes(30))
	if err != nil || n != 1 {
		t.Fatalf("DeleteStaleResumes = %d, %v; want 1", n, err)
	}
	if ok, _ := ResumeDownload(db, "open", "token-b", t0+minutes(30)); !ok {
		t.Fatalf("the live token went with the stale one")
	}
}

func TestDeletingAShareDropsItsResumes(t *testing.T) {
	db := openTestDB(t)
	mustCreate(t, db, sampleRecord("a"))
	mustStart(t, db, "a", "token-a", t0)

	if _, _, err := DeleteFileBySlug(db, "a"); err != nil {
		t.Fatalf("DeleteFileBySlug: %v", err)
	}
	if n, _ := DeleteStaleResumes(db, t0+share.ResumeLifetime.Milliseconds()); n != 0 {
		t.Fatalf("%d resumes outlived their share", n)
	}
}
