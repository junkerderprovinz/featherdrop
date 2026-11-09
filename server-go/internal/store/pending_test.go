package store

import (
	"sync"
	"testing"
)

func TestQuotaUsage_CountsUploadsInProgressByTheirDeclaredLength(t *testing.T) {
	db := openTestDB(t)
	if err := CreateFileRecord(db, FileRecord{ID: "f", Slug: "s", Size: 100, CreatedAt: 1, Format: 4}); err != nil {
		t.Fatal(err)
	}
	for _, up := range []PendingUpload{{ID: "p1", Size: 20, CreatedAt: 1}, {ID: "p2", Size: 3, CreatedAt: 1}} {
		if got, err := ReservePendingUpload(db, up, 0); err != nil || got != Reserved {
			t.Fatalf("reserve %s = %v, %v", up.ID, got, err)
		}
	}
	if used, err := QuotaUsage(db, ""); err != nil || used != 123 {
		t.Errorf("usage = %d, %v, want 123", used, err)
	}
	if used, err := QuotaUsage(db, "p1"); err != nil || used != 103 {
		t.Errorf("usage without p1 = %d, %v, want 103", used, err)
	}
}

func TestReservePendingUpload_StopsAtTheQuota(t *testing.T) {
	db := openTestDB(t)
	var mu sync.Mutex
	reserved := 0
	var wg sync.WaitGroup
	for i := range 10 {
		wg.Go(func() {
			got, err := ReservePendingUpload(db, PendingUpload{ID: string(rune('a' + i)), Size: 30, CreatedAt: 1}, 100)
			if err != nil {
				t.Errorf("reserve: %v", err)
			}
			if got == Reserved {
				mu.Lock()
				reserved++
				mu.Unlock()
			} else if got != OverQuota {
				t.Errorf("reserve = %v, want OverQuota", got)
			}
		})
	}
	wg.Wait()
	if reserved != 3 {
		t.Errorf("%d uploads reserved, want 3", reserved)
	}
}

func TestStoringAnUploadMovesItsBytesFromPendingToStored(t *testing.T) {
	db := openTestDB(t)
	if err := CreateRequest(db, newRequest("req", nil, nil)); err != nil {
		t.Fatal(err)
	}
	for _, up := range []PendingUpload{{ID: "share", Size: 10, CreatedAt: 1}, {ID: "file-u1", Size: 7, RequestSlug: "req", CreatedAt: 1}} {
		if _, err := ReservePendingUpload(db, up, 0); err != nil {
			t.Fatal(err)
		}
	}
	if err := CreateFileRecord(db, FileRecord{ID: "share", Slug: "s", Size: 10, CreatedAt: 1, Format: 4}); err != nil {
		t.Fatal(err)
	}
	if ok, err := AddRequestUpload(db, "req", upload("u1", 7), 1); err != nil || !ok {
		t.Fatalf("add = %v, %v", ok, err)
	}
	if used, _ := QuotaUsage(db, ""); used != 17 {
		t.Errorf("usage = %d, want 17", used)
	}
	for _, id := range []string{"share", "file-u1"} {
		if up, err := GetPendingUpload(db, id); err != nil || up != nil {
			t.Errorf("%s still pending: %+v, %v", id, up, err)
		}
	}
}

func TestListPendingUploads_ReturnsThoseCreatedByTheCutoff(t *testing.T) {
	db := openTestDB(t)
	for _, up := range []PendingUpload{{ID: "old", Size: 1, CreatedAt: 10}, {ID: "edge", Size: 1, CreatedAt: 20}, {ID: "new", Size: 1, CreatedAt: 30}} {
		if _, err := ReservePendingUpload(db, up, 0); err != nil {
			t.Fatal(err)
		}
	}
	ids, err := ListPendingUploads(db, 20)
	if err != nil || len(ids) != 2 || ids[0] != "old" || ids[1] != "edge" {
		t.Errorf("listed %v, %v", ids, err)
	}
}

func TestTrackPendingUpload_KeepsAKnownUpload(t *testing.T) {
	db := openTestDB(t)
	if err := CreateRequest(db, newRequest("req", nil, nil)); err != nil {
		t.Fatal(err)
	}
	if got, err := ReservePendingUpload(db, PendingUpload{ID: "p", Size: 5, RequestSlug: "req", CreatedAt: 1}, 0); err != nil || got != Reserved {
		t.Fatalf("reserve = %v, %v", got, err)
	}
	if err := TrackPendingUpload(db, PendingUpload{ID: "p", Size: 9, CreatedAt: 2}); err != nil {
		t.Fatal(err)
	}
	if err := TrackPendingUpload(db, PendingUpload{ID: "q", Size: 4, CreatedAt: 2}); err != nil {
		t.Fatal(err)
	}
	if up, _ := GetPendingUpload(db, "p"); up == nil || up.Size != 5 || up.RequestSlug != "req" {
		t.Errorf("known upload changed: %+v", up)
	}
	if used, _ := QuotaUsage(db, ""); used != 9 {
		t.Errorf("usage = %d, want 9", used)
	}
}
