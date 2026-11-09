package api

import (
	"bytes"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"

	"github.com/junkerderprovinz/featherdrop/server-go/internal/share"
	"github.com/junkerderprovinz/featherdrop/server-go/internal/store"
)

func revoke(h http.Handler, slug, token string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(http.MethodDelete, "/api/m/"+slug, nil)
	if token != "" {
		req.Header.Set(manageTokenHeader, token)
	}
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return rec
}

func withManageToken(token string) func(*store.FileRecord) {
	return func(r *store.FileRecord) {
		hash := share.HashManageToken(token)
		r.ManageTokenHash = &hash
	}
}

func TestFinalize_StoresManageTokenHash(t *testing.T) {
	e := newTestEnv(t)
	id := e.makeTusUpload(t, []byte("blob"))
	hash := share.HashManageToken(share.NewManageToken())

	rec := e.finalize(t, nil, map[string]any{"uploadId": id, "format": 2, "manageTokenHash": hash}, nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200 (body %s)", rec.Code, rec.Body.String())
	}
	var resp finalizeResponse
	decodeJSON(t, rec, &resp)
	row, _ := store.GetFileBySlug(e.db, resp.Slug)
	if row == nil || row.ManageTokenHash == nil || *row.ManageTokenHash != hash {
		t.Fatalf("manage_token_hash = %v, want %q", row, hash)
	}
}

func TestFinalize_WithoutManageTokenHashStoresNone(t *testing.T) {
	e := newTestEnv(t)
	id := e.makeTusUpload(t, []byte("blob"))

	rec := e.finalize(t, nil, map[string]any{"uploadId": id, "format": 2}, nil)
	var resp finalizeResponse
	decodeJSON(t, rec, &resp)
	row, _ := store.GetFileBySlug(e.db, resp.Slug)
	if row == nil || row.ManageTokenHash != nil {
		t.Fatalf("row = %+v, want a share without a manage token hash", row)
	}
}

func TestFinalize_BadManageTokenHash_400(t *testing.T) {
	for _, bad := range []any{"short", "padded=====================================", 42} {
		e := newTestEnv(t)
		id := e.makeTusUpload(t, []byte("blob"))

		rec := e.finalize(t, nil, map[string]any{"uploadId": id, "format": 2, "manageTokenHash": bad}, nil)
		if rec.Code != http.StatusBadRequest {
			t.Fatalf("manageTokenHash %v: status = %d, want 400", bad, rec.Code)
		}
		if _, err := os.Stat(filepath.Join(e.cfg.TmpDir, id)); err != nil {
			t.Fatalf("manageTokenHash %v: upload must survive the 400: %v", bad, err)
		}
	}
}

func TestRevoke_DeletesShareAndBlob(t *testing.T) {
	e := newTestEnv(t)
	token := share.NewManageToken()
	slug := e.seedV2(t, []byte("delete me early"), withManageToken(token))
	row, _ := store.GetFileBySlug(e.db, slug)
	h := e.router(nil)

	rec := revoke(h, slug, token)
	if rec.Code != http.StatusNoContent {
		t.Fatalf("status = %d, want 204 (body %s)", rec.Code, rec.Body.String())
	}
	if r, _ := store.GetFileBySlug(e.db, slug); r != nil {
		t.Fatalf("row must be deleted")
	}
	if _, err := os.Stat(filepath.Join(e.cfg.UploadsDir, row.ID)); !os.IsNotExist(err) {
		t.Fatalf("blob must be deleted, stat err = %v", err)
	}
	if rec := revoke(h, slug, token); rec.Code != http.StatusNotFound {
		t.Fatalf("second revoke: status = %d, want 404", rec.Code)
	}
}

func TestRevoke_ExpiredShareIsDeletedToo(t *testing.T) {
	e := newTestEnv(t)
	token := share.NewManageToken()
	past := int64(1000)
	slug := e.seedV2(t, []byte("expired"), func(r *store.FileRecord) {
		withManageToken(token)(r)
		r.ExpiresAt = &past
	})

	if rec := revoke(e.router(fixedNow(2000)), slug, token); rec.Code != http.StatusNoContent {
		t.Fatalf("status = %d, want 204", rec.Code)
	}
}

func TestRevoke_RefusalsAreUniform(t *testing.T) {
	token := share.NewManageToken()
	tests := []struct {
		name   string
		mutate func(*store.FileRecord)
		slug   string
		token  string
	}{
		{"wrong token", withManageToken(token), "", share.NewManageToken()},
		{"missing token", withManageToken(token), "", ""},
		{"hash sent instead of the token", withManageToken(token), "", share.HashManageToken(token)},
		{"share without a management link", nil, "", token},
		{"unknown slug", withManageToken(token), "nonexistent", token},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			e := newTestEnv(t)
			content := []byte("must survive")
			slug := e.seedV2(t, content, tt.mutate)
			target := slug
			if tt.slug != "" {
				target = tt.slug
			}

			rec := revoke(e.router(nil), target, tt.token)
			if rec.Code != http.StatusNotFound || rec.Body.String() != `{"error":"not found"}` {
				t.Fatalf("got %d %s, want the uniform 404", rec.Code, rec.Body.String())
			}
			if rec.Header().Get("X-Robots-Tag") != "noindex, nofollow" {
				t.Fatalf("missing X-Robots-Tag")
			}
			row, _ := store.GetFileBySlug(e.db, slug)
			if row == nil {
				t.Fatalf("share must survive a refused revoke")
			}
			got, err := os.ReadFile(filepath.Join(e.cfg.UploadsDir, row.ID))
			if err != nil || !bytes.Equal(got, content) {
				t.Fatalf("blob must survive a refused revoke (err %v)", err)
			}
		})
	}
}

func TestEndToEnd_FinalizeThenRevoke(t *testing.T) {
	e := newTestEnv(t)
	token := share.NewManageToken()
	id := e.makeTusUpload(t, []byte("round trip"))
	h := e.router(nil)

	fin := e.finalize(t, nil, map[string]any{
		"uploadId": id, "format": 2, "manageTokenHash": share.HashManageToken(token),
	}, nil)
	var resp finalizeResponse
	decodeJSON(t, fin, &resp)

	if rec := revoke(h, resp.Slug, token); rec.Code != http.StatusNoContent {
		t.Fatalf("revoke status = %d, want 204", rec.Code)
	}
	dl := httptest.NewRecorder()
	getShare(t, h, dl, resp.Slug)
	if dl.Code != http.StatusNotFound {
		t.Fatalf("download after revoke: status = %d, want 404", dl.Code)
	}
}
