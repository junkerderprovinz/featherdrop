package api

import (
	"bytes"
	"encoding/binary"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/junkerderprovinz/featherdrop/server-go/internal/store"
)

// v4Blob builds a structurally valid format 4 blob: the version byte, a
// big-endian header length, the sealed header and contentLen content bytes.
func v4Blob(headerLen, contentLen int) []byte {
	b := make([]byte, 5+headerLen+contentLen)
	b[0] = 0x02
	binary.BigEndian.PutUint32(b[1:5], uint32(headerLen))
	return b
}

func TestFinalize_Format4StoresBlobUnchanged(t *testing.T) {
	e := newTestEnv(t)
	blob := v4Blob(1064, 4096+16)
	blob[len(blob)-1] = 0x5a
	id := e.makeTusUpload(t, blob)

	rec := e.finalize(t, nil, map[string]any{"uploadId": id, "format": 4, "keyVerifier": goodVerifier}, nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200 (body %s)", rec.Code, rec.Body.String())
	}
	var resp finalizeResponse
	decodeJSON(t, rec, &resp)
	row, _ := store.GetFileBySlug(e.db, resp.Slug)
	if row == nil || row.Format != 4 {
		t.Fatalf("row = %+v, want format 4", row)
	}
	if row.WrappedKey != nil || row.KDFSalt != nil {
		t.Fatalf("format 4 must not store a wrapped key or salt")
	}

	req := httptest.NewRequest(http.MethodGet, "/api/d/"+resp.Slug, nil)
	req.Header.Set(keyVerifierHeader, goodVerifier)
	dl := httptest.NewRecorder()
	e.router(nil).ServeHTTP(dl, req)
	if dl.Code != http.StatusOK || !bytes.Equal(dl.Body.Bytes(), blob) {
		t.Fatalf("download status %d, body equal %v", dl.Code, bytes.Equal(dl.Body.Bytes(), blob))
	}
}

func TestFinalize_Format4RejectsMalformed(t *testing.T) {
	wrongVersion := v4Blob(1064, 4112)
	wrongVersion[0] = 0x01
	cases := map[string]struct {
		blob []byte
		body map[string]any
	}{
		"no verifier":       {v4Blob(1064, 4112), map[string]any{}},
		"wrapped key":       {v4Blob(1064, 4112), map[string]any{"keyVerifier": goodVerifier, "wrappedKey": "q83v", "kdfSalt": "q83v"}},
		"too short":         {[]byte{0x02, 0, 0}, map[string]any{"keyVerifier": goodVerifier}},
		"wrong version":     {wrongVersion, map[string]any{"keyVerifier": goodVerifier}},
		"header too long":   {v4Blob(1064, 4112)[:1064], map[string]any{"keyVerifier": goodVerifier}},
		"header too short":  {v4Blob(1063, 4112), map[string]any{"keyVerifier": goodVerifier}},
		"content too short": {v4Blob(1064, 4111), map[string]any{"keyVerifier": goodVerifier}},
	}
	for name, c := range cases {
		t.Run(name, func(t *testing.T) {
			e := newTestEnv(t)
			c.body["uploadId"] = e.makeTusUpload(t, c.blob)
			c.body["format"] = 4
			rec := e.finalize(t, nil, c.body, nil)
			if rec.Code != http.StatusBadRequest {
				t.Fatalf("status = %d, want 400 (body %s)", rec.Code, rec.Body.String())
			}
		})
	}
}
