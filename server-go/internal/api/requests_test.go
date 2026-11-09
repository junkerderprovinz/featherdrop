package api

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/tus/tusd/v2/pkg/filestore"
	tushandler "github.com/tus/tusd/v2/pkg/handler"

	"github.com/junkerderprovinz/featherdrop/server-go/internal/share"
	"github.com/junkerderprovinz/featherdrop/server-go/internal/store"
	"github.com/junkerderprovinz/featherdrop/server-go/internal/upload"
)

const (
	testRequestKey   = "cHVibGljcHVibGljcHVibGljcHVibGljcHVibGljcHU"
	testCollectToken = "Y29sbGVjdGNvbGxlY3Rjb2xsZWN0Y29sbGVjdGNvbGw"
)

func (e *testEnv) requestRouter(now func() time.Time) http.Handler {
	r := chi.NewRouter()
	r.Post("/api/requests", CreateRequestHandler(e.cfg, e.db, now))
	r.Mount("/api/r", RequestRoutes(e.cfg, e.db, now))
	return r
}

func (e *testEnv) do(t *testing.T, now func() time.Time, method, path string, body any, headers map[string]string) *httptest.ResponseRecorder {
	t.Helper()
	var raw []byte
	if body != nil {
		raw, _ = json.Marshal(body)
	}
	req := httptest.NewRequest(method, path, bytes.NewReader(raw))
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	rec := httptest.NewRecorder()
	e.requestRouter(now).ServeHTTP(rec, req)
	return rec
}

// openRequest creates a request through the API and returns its slug.
func (e *testEnv) openRequest(t *testing.T, now func() time.Time, extra map[string]any) string {
	t.Helper()
	body := map[string]any{
		"publicKey":        testRequestKey,
		"collectTokenHash": share.HashCollectToken(testCollectToken),
		"expiry":           "1d",
	}
	for k, v := range extra {
		body[k] = v
	}
	rec := e.do(t, now, http.MethodPost, "/api/requests", body, nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("create request: %d %s", rec.Code, rec.Body.String())
	}
	var resp struct{ Slug string }
	decodeJSON(t, rec, &resp)
	return resp.Slug
}

func asUploader() map[string]string {
	return map[string]string{upload.RequestKeyHeader: testRequestKey}
}
func asCollector() map[string]string {
	return map[string]string{collectTokenHeader: testCollectToken}
}

func sealedKey(fill byte) string {
	return base64.StdEncoding.EncodeToString(bytes.Repeat([]byte{fill}, share.SealedKeyBytes))
}

// send uploads blob with tus and attaches it to the request.
func (e *testEnv) send(t *testing.T, now func() time.Time, slug string, blob []byte, headers map[string]string) *httptest.ResponseRecorder {
	t.Helper()
	id := e.makeTusUpload(t, blob)
	return e.do(t, now, http.MethodPost, "/api/r/"+slug+"/uploads",
		map[string]any{"uploadId": id, "sealedKey": sealedKey(7)}, headers)
}

type collectList struct {
	ExpiresAt  *int64 `json:"expiresAt"`
	MaxUploads *int64 `json:"maxUploads"`
	MaxSize    *int64 `json:"maxSize"`
	Uploads    []struct {
		ID        string `json:"id"`
		Size      int64  `json:"size"`
		CreatedAt int64  `json:"createdAt"`
		SealedKey string `json:"sealedKey"`
	} `json:"uploads"`
}

func TestCreateRequest_StoresTheKeyAndTheHashOnly(t *testing.T) {
	e := newTestEnv(t)
	slug := e.openRequest(t, fixedNow(1000), map[string]any{"maxUploads": 3, "maxSize": 50_000})
	rec, err := store.GetRequest(e.db, slug)
	if err != nil || rec == nil {
		t.Fatalf("request not stored: %v", err)
	}
	if rec.PublicKey != testRequestKey || rec.CollectTokenHash != share.HashCollectToken(testCollectToken) {
		t.Errorf("stored %+v", rec)
	}
	if deref(rec.ExpiresAt) != 1000+24*60*60*1000 || deref(rec.MaxUploads) != 3 || deref(rec.MaxSize) != 50_000 {
		t.Errorf("limits %+v", rec)
	}
}

func TestCreateRequest_RefusesBadInput(t *testing.T) {
	e := newTestEnv(t)
	e.cfg.MaxExpiry = "7d"
	good := map[string]any{"publicKey": testRequestKey, "collectTokenHash": share.HashCollectToken(testCollectToken)}
	with := func(k string, v any) map[string]any {
		m := map[string]any{}
		for a, b := range good {
			m[a] = b
		}
		m[k] = v
		return m
	}
	for name, body := range map[string]map[string]any{
		"short public key":   with("publicKey", "abc"),
		"no public key":      with("publicKey", nil),
		"bad collect hash":   with("collectTokenHash", "not a hash"),
		"unknown expiry":     with("expiry", "2w"),
		"expiry over cap":    with("expiry", "30d"),
		"negative size":      with("maxSize", -1),
		"non-numeric limits": with("maxUploads", "five"),
	} {
		t.Run(name, func(t *testing.T) {
			if rec := e.do(t, nil, http.MethodPost, "/api/requests", body, nil); rec.Code != http.StatusBadRequest {
				t.Errorf("status %d, want 400", rec.Code)
			}
		})
	}
}

func TestCreateRequest_NeedsTheUploadPasswordWhenSet(t *testing.T) {
	e := newTestEnv(t)
	e.cfg.UploadProtected, e.cfg.UploadPassword = true, "letmein"
	body := map[string]any{"publicKey": testRequestKey, "collectTokenHash": share.HashCollectToken(testCollectToken)}
	if rec := e.do(t, nil, http.MethodPost, "/api/requests", body, nil); rec.Code != http.StatusUnauthorized {
		t.Fatalf("without password: %d", rec.Code)
	}
	if rec := e.do(t, nil, http.MethodPost, "/api/requests", body,
		map[string]string{upload.UploadTokenHeader: "letmein"}); rec.Code != http.StatusOK {
		t.Fatalf("with password: %d", rec.Code)
	}
}

func TestRequestInfo_TellsTheUploaderNothingAboutOtherUploads(t *testing.T) {
	e := newTestEnv(t)
	slug := e.openRequest(t, nil, map[string]any{"maxUploads": 5, "maxSize": 1 << 20})
	for range 2 {
		if rec := e.send(t, nil, slug, v4Blob(1064, 4112), asUploader()); rec.Code != http.StatusNoContent {
			t.Fatalf("send: %d %s", rec.Code, rec.Body.String())
		}
	}
	rec := e.do(t, nil, http.MethodGet, "/api/r/"+slug, nil, asUploader())
	if rec.Code != http.StatusOK {
		t.Fatalf("info: %d", rec.Code)
	}
	var fields map[string]any
	decodeJSON(t, rec, &fields)
	if len(fields) != 3 || fields["open"] != true || fields["maxSize"] != float64(1<<20) || fields["expiresAt"] == nil {
		t.Errorf("info = %v, want only expiresAt, maxSize and open", fields)
	}
	send := e.send(t, nil, slug, v4Blob(1064, 4112), asUploader())
	if send.Body.Len() != 0 {
		t.Errorf("sending answered %q", send.Body.String())
	}
}

func TestRequestInfo_RefusesAWrongKeyLikeAMissingRequest(t *testing.T) {
	e := newTestEnv(t)
	slug := e.openRequest(t, fixedNow(0), nil)
	expired := fixedNow(2 * 24 * 60 * 60 * 1000)
	cases := map[string]*httptest.ResponseRecorder{
		"no key":          e.do(t, fixedNow(0), http.MethodGet, "/api/r/"+slug, nil, nil),
		"wrong key":       e.do(t, fixedNow(0), http.MethodGet, "/api/r/"+slug, nil, map[string]string{upload.RequestKeyHeader: testCollectToken}),
		"unknown request": e.do(t, fixedNow(0), http.MethodGet, "/api/r/nosuchreq", nil, asUploader()),
		"expired":         e.do(t, expired, http.MethodGet, "/api/r/"+slug, nil, asUploader()),
	}
	assertUniformRefusal(t, cases)
}

func assertUniformRefusal(t *testing.T, cases map[string]*httptest.ResponseRecorder) {
	t.Helper()
	var want string
	for name, rec := range cases {
		if rec.Code != http.StatusNotFound {
			t.Errorf("%s: status %d, want 404", name, rec.Code)
		}
		if want == "" {
			want = rec.Body.String()
		}
		if rec.Body.String() != want {
			t.Errorf("%s: body %q differs from %q", name, rec.Body.String(), want)
		}
	}
}

func TestSendToRequest_RoundTripsThroughTheCollectLink(t *testing.T) {
	e := newTestEnv(t)
	now := fixedNow(5000)
	slug := e.openRequest(t, now, nil)
	blob := v4Blob(1064, 4112)
	blob[len(blob)-1] = 0x42
	if rec := e.send(t, now, slug, blob, asUploader()); rec.Code != http.StatusNoContent {
		t.Fatalf("send: %d %s", rec.Code, rec.Body.String())
	}

	rec := e.do(t, now, http.MethodGet, "/api/r/"+slug+"/uploads", nil, asCollector())
	if rec.Code != http.StatusOK {
		t.Fatalf("list: %d", rec.Code)
	}
	var list collectList
	decodeJSON(t, rec, &list)
	if len(list.Uploads) != 1 {
		t.Fatalf("listed %d uploads", len(list.Uploads))
	}
	up := list.Uploads[0]
	if up.Size != int64(len(blob)) || up.CreatedAt != 5000 || up.SealedKey != sealedKey(7) {
		t.Errorf("listed %+v", up)
	}

	dl := e.do(t, now, http.MethodGet, "/api/r/"+slug+"/uploads/"+up.ID, nil, asCollector())
	if dl.Code != http.StatusOK || !bytes.Equal(dl.Body.Bytes(), blob) {
		t.Fatalf("download: %d, equal %v", dl.Code, bytes.Equal(dl.Body.Bytes(), blob))
	}
	if dl.Header().Get("Content-Type") != "application/octet-stream" || dl.Header().Get("Cache-Control") != "private, no-store" {
		t.Errorf("headers %v", dl.Header())
	}

	ranged := e.do(t, now, http.MethodGet, "/api/r/"+slug+"/uploads/"+up.ID, nil,
		map[string]string{collectTokenHeader: testCollectToken, "Range": "bytes=10-19"})
	if ranged.Code != http.StatusPartialContent || !bytes.Equal(ranged.Body.Bytes(), blob[10:20]) {
		t.Errorf("range: %d", ranged.Code)
	}

	head := e.do(t, now, http.MethodGet, "/api/r/"+slug+"/uploads/"+up.ID+"/header", nil, asCollector())
	if head.Code != http.StatusOK || !bytes.Equal(head.Body.Bytes(), blob[:5+1064]) {
		t.Errorf("header: %d, %d bytes", head.Code, head.Body.Len())
	}
}

func TestCollect_ARequestLinkCannotCollect(t *testing.T) {
	e := newTestEnv(t)
	slug := e.openRequest(t, nil, nil)
	if rec := e.send(t, nil, slug, v4Blob(1064, 4112), asUploader()); rec.Code != http.StatusNoContent {
		t.Fatalf("send: %d", rec.Code)
	}
	ups, _ := store.ListRequestUploads(e.db, slug)
	asRequestLink := map[string]string{
		upload.RequestKeyHeader: testRequestKey,
		collectTokenHeader:      testRequestKey,
	}
	for _, path := range []string{"/uploads", "/uploads/" + ups[0].ID, "/uploads/" + ups[0].ID + "/header"} {
		if rec := e.do(t, nil, http.MethodGet, "/api/r/"+slug+path, nil, asRequestLink); rec.Code != http.StatusNotFound {
			t.Errorf("GET %s with the request link: %d", path, rec.Code)
		}
	}
	if rec := e.do(t, nil, http.MethodDelete, "/api/r/"+slug, nil, asRequestLink); rec.Code != http.StatusNotFound {
		t.Errorf("DELETE with the request link: %d", rec.Code)
	}
	if rec, _ := store.GetRequest(e.db, slug); rec == nil {
		t.Error("the request link closed the request")
	}
}

func TestCollect_RefusesEveryWrongProofAlike(t *testing.T) {
	e := newTestEnv(t)
	slug := e.openRequest(t, fixedNow(0), nil)
	if rec := e.send(t, fixedNow(0), slug, v4Blob(1064, 4112), asUploader()); rec.Code != http.StatusNoContent {
		t.Fatalf("send: %d", rec.Code)
	}
	ups, _ := store.ListRequestUploads(e.db, slug)
	other := e.openRequest(t, fixedNow(0), nil)
	wrong := map[string]string{collectTokenHeader: testRequestKey}
	expired := fixedNow(2 * 24 * 60 * 60 * 1000)
	list := "/api/r/" + slug + "/uploads"
	blob := list + "/" + ups[0].ID
	assertUniformRefusal(t, map[string]*httptest.ResponseRecorder{
		"list, no token":          e.do(t, fixedNow(0), http.MethodGet, list, nil, nil),
		"list, wrong token":       e.do(t, fixedNow(0), http.MethodGet, list, nil, wrong),
		"list, unknown request":   e.do(t, fixedNow(0), http.MethodGet, "/api/r/nosuchreq/uploads", nil, asCollector()),
		"list, expired":           e.do(t, expired, http.MethodGet, list, nil, asCollector()),
		"blob, wrong token":       e.do(t, fixedNow(0), http.MethodGet, blob, nil, wrong),
		"blob, unknown upload":    e.do(t, fixedNow(0), http.MethodGet, list+"/NOSUCHUPLOAD", nil, asCollector()),
		"blob, another request":   e.do(t, fixedNow(0), http.MethodGet, "/api/r/"+other+"/uploads/"+ups[0].ID, nil, asCollector()),
		"header, wrong token":     e.do(t, fixedNow(0), http.MethodGet, blob+"/header", nil, wrong),
		"close, wrong token":      e.do(t, fixedNow(0), http.MethodDelete, "/api/r/"+slug, nil, wrong),
		"close, unknown request":  e.do(t, fixedNow(0), http.MethodDelete, "/api/r/nosuchreq", nil, asCollector()),
		"send, wrong request key": e.send(t, fixedNow(0), slug, v4Blob(1064, 4112), wrong),
	})
}

func TestSendToRequest_EnforcesItsLimits(t *testing.T) {
	e := newTestEnv(t)
	slug := e.openRequest(t, fixedNow(0), map[string]any{"maxUploads": 1, "maxSize": 6000})

	if rec := e.send(t, fixedNow(0), slug, v4Blob(1064, 8192), asUploader()); rec.Code != http.StatusRequestEntityTooLarge {
		t.Errorf("over the size cap: %d", rec.Code)
	}
	if rec := e.send(t, fixedNow(0), slug, v4Blob(1064, 4112), asUploader()); rec.Code != http.StatusNoContent {
		t.Fatalf("first upload: %d %s", rec.Code, rec.Body.String())
	}
	if rec := e.send(t, fixedNow(0), slug, v4Blob(1064, 4112), asUploader()); rec.Code != http.StatusGone {
		t.Errorf("past the upload count: %d", rec.Code)
	}
	info := e.do(t, fixedNow(0), http.MethodGet, "/api/r/"+slug, nil, asUploader())
	var fields map[string]any
	decodeJSON(t, info, &fields)
	if fields["open"] != false {
		t.Errorf("a full request still reports open: %v", fields)
	}

	expired := fixedNow(2 * 24 * 60 * 60 * 1000)
	other := e.openRequest(t, fixedNow(0), nil)
	if rec := e.send(t, expired, other, v4Blob(1064, 4112), asUploader()); rec.Code != http.StatusNotFound {
		t.Errorf("after expiry: %d", rec.Code)
	}
	if n, _ := store.ListRequestUploads(e.db, slug); len(n) != 1 {
		t.Errorf("%d uploads stored, want 1", len(n))
	}
}

func TestSendToRequest_RefusesWhatNoCollectorCouldOpen(t *testing.T) {
	e := newTestEnv(t)
	slug := e.openRequest(t, nil, nil)
	for name, body := range map[string]map[string]any{
		"not format 4":     {"uploadId": e.makeTusUpload(t, bytes.Repeat([]byte{1}, 6000)), "sealedKey": sealedKey(1)},
		"short sealed key": {"uploadId": e.makeTusUpload(t, v4Blob(1064, 4112)), "sealedKey": base64.StdEncoding.EncodeToString([]byte("short"))},
		"no sealed key":    {"uploadId": e.makeTusUpload(t, v4Blob(1064, 4112))},
		"unsafe upload id": {"uploadId": "../db.sqlite", "sealedKey": sealedKey(1)},
	} {
		t.Run(name, func(t *testing.T) {
			if rec := e.do(t, nil, http.MethodPost, "/api/r/"+slug+"/uploads", body, asUploader()); rec.Code != http.StatusBadRequest {
				t.Errorf("status %d, want 400", rec.Code)
			}
		})
	}
	if ups, _ := store.ListRequestUploads(e.db, slug); len(ups) != 0 {
		t.Errorf("%d uploads stored", len(ups))
	}
}

func TestSendToRequest_CountsTowardsTheStorageQuota(t *testing.T) {
	e := newTestEnv(t)
	e.cfg.StorageQuota = 6000
	slug := e.openRequest(t, nil, nil)
	if rec := e.send(t, nil, slug, v4Blob(1064, 4112), asUploader()); rec.Code != http.StatusNoContent {
		t.Fatalf("first: %d", rec.Code)
	}
	if rec := e.send(t, nil, slug, v4Blob(1064, 4112), asUploader()); rec.Code != http.StatusInsufficientStorage {
		t.Errorf("second: %d, want 507", rec.Code)
	}
}

func TestCloseRequest_DeletesItsUploads(t *testing.T) {
	e := newTestEnv(t)
	slug := e.openRequest(t, nil, nil)
	if rec := e.send(t, nil, slug, v4Blob(1064, 4112), asUploader()); rec.Code != http.StatusNoContent {
		t.Fatalf("send: %d", rec.Code)
	}
	ups, _ := store.ListRequestUploads(e.db, slug)
	blobPath := filepath.Join(e.cfg.UploadsDir, ups[0].FileID)
	if _, err := os.Stat(blobPath); err != nil {
		t.Fatalf("blob missing before close: %v", err)
	}
	if rec := e.do(t, nil, http.MethodDelete, "/api/r/"+slug, nil, asCollector()); rec.Code != http.StatusNoContent {
		t.Fatalf("close: %d", rec.Code)
	}
	if _, err := os.Stat(blobPath); !os.IsNotExist(err) {
		t.Errorf("blob still there: %v", err)
	}
	if rec, _ := store.GetRequest(e.db, slug); rec != nil {
		t.Error("request row still there")
	}
}

func TestRequestRoutes_UnknownPathsGetTheUniformRefusal(t *testing.T) {
	e := newTestEnv(t)
	slug := e.openRequest(t, nil, nil)
	assertUniformRefusal(t, map[string]*httptest.ResponseRecorder{
		"unknown subpath": e.do(t, nil, http.MethodGet, "/api/r/"+slug+"/elsewhere", nil, asCollector()),
		"wrong method":    e.do(t, nil, http.MethodPut, "/api/r/"+slug, nil, asCollector()),
		"wrong token":     e.do(t, nil, http.MethodGet, "/api/r/"+slug+"/uploads", nil, nil),
	})
	if got := e.do(t, nil, http.MethodGet, "/api/r/"+slug+"/elsewhere", nil, nil).Header().Get("X-Robots-Tag"); got != "noindex, nofollow" {
		t.Errorf("X-Robots-Tag = %q", got)
	}
}

// makeDeferredTusUpload creates a tus upload that declared no length, as
// Upload-Defer-Length does, and writes content to it.
func (e *testEnv) makeDeferredTusUpload(t *testing.T, content []byte) string {
	t.Helper()
	fs := filestore.New(e.cfg.TmpDir)
	up, err := fs.NewUpload(context.Background(), tushandler.FileInfo{SizeIsDeferred: true})
	if err != nil {
		t.Fatalf("new upload: %v", err)
	}
	if _, err := up.WriteChunk(context.Background(), 0, bytes.NewReader(content)); err != nil {
		t.Fatalf("write chunk: %v", err)
	}
	info, _ := up.GetInfo(context.Background())
	return info.ID
}

func TestSendToRequest_RefusesAnUploadWithoutADeclaredLength(t *testing.T) {
	e := newTestEnv(t)
	slug := e.openRequest(t, nil, nil)
	id := e.makeDeferredTusUpload(t, v4Blob(1064, 4112))
	rec := e.do(t, nil, http.MethodPost, "/api/r/"+slug+"/uploads", map[string]any{"uploadId": id, "sealedKey": sealedKey(1)}, asUploader())
	if rec.Code != http.StatusConflict {
		t.Fatalf("status %d, want 409", rec.Code)
	}
	if ups, _ := store.ListRequestUploads(e.db, slug); len(ups) != 0 {
		t.Errorf("%d uploads stored", len(ups))
	}
}

func TestDeleteRequestUpload_RemovesOneUploadForTheCollector(t *testing.T) {
	e := newTestEnv(t)
	slug := e.openRequest(t, nil, nil)
	for range 2 {
		if rec := e.send(t, nil, slug, v4Blob(1064, 4112), asUploader()); rec.Code != http.StatusNoContent {
			t.Fatalf("send: %d", rec.Code)
		}
	}
	ups, _ := store.ListRequestUploads(e.db, slug)
	path := "/api/r/" + slug + "/uploads/" + ups[0].ID
	if rec := e.do(t, nil, http.MethodDelete, path, nil, asUploader()); rec.Code != http.StatusNotFound {
		t.Errorf("uploader deleted an upload: %d", rec.Code)
	}
	if rec := e.do(t, nil, http.MethodDelete, path, nil, asCollector()); rec.Code != http.StatusNoContent {
		t.Fatalf("delete: %d", rec.Code)
	}
	if _, err := os.Stat(filepath.Join(e.cfg.UploadsDir, ups[0].FileID)); !os.IsNotExist(err) {
		t.Errorf("blob still there: %v", err)
	}
	left, _ := store.ListRequestUploads(e.db, slug)
	if len(left) != 1 || left[0].ID != ups[1].ID {
		t.Errorf("left %+v", left)
	}
	if rec := e.do(t, nil, http.MethodDelete, path, nil, asCollector()); rec.Code != http.StatusNotFound {
		t.Errorf("second delete: %d", rec.Code)
	}
}

func TestRequestRoutes_RefuseOversizedBodies(t *testing.T) {
	e := newTestEnv(t)
	huge := map[string]any{"publicKey": testRequestKey, "collectTokenHash": share.HashCollectToken(testCollectToken), "pad": strings.Repeat("x", 1<<20)}
	if rec := e.do(t, nil, http.MethodPost, "/api/requests", huge, nil); rec.Code != http.StatusBadRequest {
		t.Errorf("create with a 1 MiB body: %d", rec.Code)
	}
	slug := e.openRequest(t, nil, nil)
	body := map[string]any{"uploadId": "x", "sealedKey": strings.Repeat("A", 1<<20)}
	if rec := e.do(t, nil, http.MethodPost, "/api/r/"+slug+"/uploads", body, asUploader()); rec.Code != http.StatusBadRequest {
		t.Errorf("send with a 1 MiB body: %d", rec.Code)
	}
}
