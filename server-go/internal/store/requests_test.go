package store

import (
	"sync"
	"testing"
)

func newRequest(slug string, max *int64, expiresAt *int64) RequestRecord {
	return RequestRecord{
		Slug:             slug,
		PublicKey:        "Zmh6rfhivXdsj8GLjp-OIAiXFIVu4jOzkCpZHQ1fKSU",
		CollectTokenHash: "aGFzaGhhc2hoYXNoaGFzaGhhc2hoYXNoaGFzaGhhc2g",
		ExpiresAt:        expiresAt,
		CreatedAt:        1,
		MaxUploads:       max,
	}
}

func upload(id string, size int64) RequestUpload {
	return RequestUpload{ID: id, FileID: "file-" + id, Size: size, SealedKey: []byte{1, 2, 3}, CreatedAt: 5}
}

func TestCreateRequest_RoundTrip(t *testing.T) {
	db := openTestDB(t)
	size := int64(4096)
	rec := newRequest("req1", new(int64(3)), new(int64(99)))
	rec.MaxSize = &size
	if err := CreateRequest(db, rec); err != nil {
		t.Fatalf("create: %v", err)
	}
	got, err := GetRequest(db, "req1")
	if err != nil || got == nil {
		t.Fatalf("get = %v, %v", got, err)
	}
	if got.PublicKey != rec.PublicKey || got.CollectTokenHash != rec.CollectTokenHash ||
		*got.ExpiresAt != 99 || *got.MaxUploads != 3 || *got.MaxSize != 4096 || got.UploadCount != 0 {
		t.Errorf("got %+v", got)
	}
	if missing, err := GetRequest(db, "nope"); err != nil || missing != nil {
		t.Errorf("unknown slug = %v, %v", missing, err)
	}
}

func TestAddRequestUpload_StopsAtTheMaximum(t *testing.T) {
	db := openTestDB(t)
	if err := CreateRequest(db, newRequest("req", new(int64(3)), nil)); err != nil {
		t.Fatal(err)
	}
	var mu sync.Mutex
	taken := 0
	var wg sync.WaitGroup
	for i := range 10 {
		wg.Go(func() {
			ok, err := AddRequestUpload(db, "req", upload(string(rune('a'+i)), 10), 1)
			if err != nil {
				t.Errorf("add: %v", err)
			}
			if ok {
				mu.Lock()
				taken++
				mu.Unlock()
			}
		})
	}
	wg.Wait()
	if taken != 3 {
		t.Fatalf("%d uploads taken, want 3", taken)
	}
	rec, _ := GetRequest(db, "req")
	ups, _ := ListRequestUploads(db, "req")
	if rec.UploadCount != 3 || len(ups) != 3 {
		t.Errorf("count %d, %d rows", rec.UploadCount, len(ups))
	}
}

func TestAddRequestUpload_UnknownRequestTakesNothing(t *testing.T) {
	db := openTestDB(t)
	ok, err := AddRequestUpload(db, "nope", upload("a", 1), 1)
	if err != nil || ok {
		t.Fatalf("add = %v, %v", ok, err)
	}
}

func TestRequestUploads_StayWithTheirRequest(t *testing.T) {
	db := openTestDB(t)
	for _, slug := range []string{"one", "two"} {
		if err := CreateRequest(db, newRequest(slug, nil, nil)); err != nil {
			t.Fatal(err)
		}
	}
	if ok, err := AddRequestUpload(db, "one", upload("u1", 7), 1); !ok || err != nil {
		t.Fatalf("add = %v, %v", ok, err)
	}
	if ok, err := AddRequestUpload(db, "one", upload("u2", 8), 1); !ok || err != nil {
		t.Fatalf("add = %v, %v", ok, err)
	}
	got, err := GetRequestUpload(db, "one", "u1")
	if err != nil || got == nil || got.FileID != "file-u1" || got.Size != 7 || string(got.SealedKey) != "\x01\x02\x03" {
		t.Fatalf("get = %+v, %v", got, err)
	}
	if other, err := GetRequestUpload(db, "two", "u1"); err != nil || other != nil {
		t.Errorf("an upload of one found under two: %+v, %v", other, err)
	}
	ups, err := ListRequestUploads(db, "one")
	if err != nil || len(ups) != 2 || ups[0].ID != "u1" || ups[1].ID != "u2" {
		t.Errorf("list = %+v, %v", ups, err)
	}
	if ups, _ := ListRequestUploads(db, "two"); len(ups) != 0 {
		t.Errorf("two lists %d uploads", len(ups))
	}
}

func TestDeleteRequest_TakesItsUploadsAlong(t *testing.T) {
	db := openTestDB(t)
	if err := CreateRequest(db, newRequest("req", nil, nil)); err != nil {
		t.Fatal(err)
	}
	if _, err := AddRequestUpload(db, "req", upload("u1", 7), 1); err != nil {
		t.Fatal(err)
	}
	ok, err := DeleteRequest(db, "req")
	if err != nil || !ok {
		t.Fatalf("delete = %v, %v", ok, err)
	}
	var n int
	if err := db.QueryRow(`SELECT COUNT(*) FROM request_uploads`).Scan(&n); err != nil || n != 0 {
		t.Errorf("%d upload rows left, %v", n, err)
	}
	if ok, err := DeleteRequest(db, "req"); err != nil || ok {
		t.Errorf("second delete = %v, %v", ok, err)
	}
}

func TestListExpiredRequests(t *testing.T) {
	db := openTestDB(t)
	for slug, exp := range map[string]*int64{"past": new(int64(10)), "now": new(int64(20)), "later": new(int64(30)), "never": nil} {
		if err := CreateRequest(db, newRequest(slug, nil, exp)); err != nil {
			t.Fatal(err)
		}
	}
	got, err := ListExpiredRequests(db, 20)
	if err != nil {
		t.Fatal(err)
	}
	slugs := map[string]bool{}
	for _, r := range got {
		slugs[r.Slug] = true
	}
	if len(got) != 2 || !slugs["past"] || !slugs["now"] {
		t.Errorf("expired = %v", slugs)
	}
}

func TestQuotaUsage_CountsRequestUploads(t *testing.T) {
	db := openTestDB(t)
	if err := CreateFileRecord(db, FileRecord{ID: "f", Slug: "s", Size: 100, CreatedAt: 1, Format: 4}); err != nil {
		t.Fatal(err)
	}
	if err := CreateRequest(db, newRequest("req", nil, nil)); err != nil {
		t.Fatal(err)
	}
	if _, err := AddRequestUpload(db, "req", upload("u1", 23), 1); err != nil {
		t.Fatal(err)
	}
	total, err := QuotaUsage(db, "")
	if err != nil || total != 123 {
		t.Errorf("total = %d, %v", total, err)
	}
}

func TestAddRequestUpload_NeedsALiveRequest(t *testing.T) {
	db := openTestDB(t)
	if err := CreateRequest(db, newRequest("expiring", nil, new(int64(100)))); err != nil {
		t.Fatal(err)
	}
	if ok, err := AddRequestUpload(db, "expiring", upload("late", 1), 100); err != nil || ok {
		t.Errorf("upload at expiry = %v, %v", ok, err)
	}
	if ok, err := AddRequestUpload(db, "expiring", upload("early", 1), 99); err != nil || !ok {
		t.Errorf("upload before expiry = %v, %v", ok, err)
	}

	if err := CreateRequest(db, newRequest("open", nil, nil)); err != nil {
		t.Fatal(err)
	}
	if err := CloseRequest(db, "open"); err != nil {
		t.Fatal(err)
	}
	if ok, err := AddRequestUpload(db, "open", upload("after", 1), 1); err != nil || ok {
		t.Errorf("upload after close = %v, %v", ok, err)
	}
	rec, _ := GetRequest(db, "open")
	if rec == nil || !rec.Expired(1) {
		t.Errorf("a closed request does not read as expired: %+v", rec)
	}
}

func TestDeleteRequestUpload_RemovesOnlyThatUpload(t *testing.T) {
	db := openTestDB(t)
	if err := CreateRequest(db, newRequest("req", nil, nil)); err != nil {
		t.Fatal(err)
	}
	for _, id := range []string{"u1", "u2"} {
		if _, err := AddRequestUpload(db, "req", upload(id, 3), 1); err != nil {
			t.Fatal(err)
		}
	}
	if ok, err := DeleteRequestUpload(db, "req", "u1"); err != nil || !ok {
		t.Fatalf("delete = %v, %v", ok, err)
	}
	ups, _ := ListRequestUploads(db, "req")
	if len(ups) != 1 || ups[0].ID != "u2" {
		t.Errorf("left %+v", ups)
	}
	if ok, _ := DeleteRequestUpload(db, "other", "u2"); ok {
		t.Error("deleted an upload through another request")
	}
}

func TestDeleteRequestUpload_GivesItsPlaceBack(t *testing.T) {
	db := openTestDB(t)
	if err := CreateRequest(db, newRequest("req", new(int64(1)), nil)); err != nil {
		t.Fatal(err)
	}
	if ok, err := AddRequestUpload(db, "req", upload("junk", 3), 1); err != nil || !ok {
		t.Fatalf("add = %v, %v", ok, err)
	}
	if ok, err := DeleteRequestUpload(db, "req", "junk"); err != nil || !ok {
		t.Fatalf("delete = %v, %v", ok, err)
	}
	if rec, _ := GetRequest(db, "req"); rec.UploadCount != 0 {
		t.Errorf("count after delete = %d, want 0", rec.UploadCount)
	}
	if ok, err := AddRequestUpload(db, "req", upload("real", 3), 1); err != nil || !ok {
		t.Errorf("add after delete = %v, %v", ok, err)
	}
}

func TestDeleteRequestUpload_NeverCountsBelowZero(t *testing.T) {
	db := openTestDB(t)
	if err := CreateRequest(db, newRequest("req", nil, nil)); err != nil {
		t.Fatal(err)
	}
	if _, err := AddRequestUpload(db, "req", upload("u1", 3), 1); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`UPDATE requests SET upload_count = 0 WHERE slug = 'req'`); err != nil {
		t.Fatal(err)
	}
	if ok, err := DeleteRequestUpload(db, "req", "u1"); err != nil || !ok {
		t.Fatalf("delete = %v, %v", ok, err)
	}
	if rec, _ := GetRequest(db, "req"); rec.UploadCount != 0 {
		t.Errorf("count = %d, want 0", rec.UploadCount)
	}
	if ok, _ := DeleteRequestUpload(db, "req", "u1"); ok {
		t.Error("deleted the same upload twice")
	}
	if rec, _ := GetRequest(db, "req"); rec.UploadCount != 0 {
		t.Errorf("count after a delete that found nothing = %d, want 0", rec.UploadCount)
	}
}
