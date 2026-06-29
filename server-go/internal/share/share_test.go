package share

import (
	"crypto/sha256"
	"encoding/base64"
	"strings"
	"testing"
)

func TestIsSafeID(t *testing.T) {
	tests := []struct {
		name string
		id   string
		want bool
	}{
		{"simple", "abc123", true},
		{"with dot dash underscore", "a.b-c_d", true},
		{"uuid-like", "0aF9-zZ.bar_BAZ", true},
		{"empty", "", false},
		{"traversal dotdot", "..", false},
		{"embedded traversal", "a..b", false},
		{"leading traversal path", "../etc/passwd", false},
		{"forward slash", "a/b", false},
		{"backslash", `a\b`, false},
		{"space", "a b", false},
		{"plus sign", "a+b", false},
		{"single dot ok", ".", true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := IsSafeID(tt.id); got != tt.want {
				t.Errorf("IsSafeID(%q) = %v, want %v", tt.id, got, tt.want)
			}
		})
	}
}

func TestNewSlug(t *testing.T) {
	const alphabet = slugAlphabet
	seen := make(map[string]struct{})
	for i := 0; i < 1000; i++ {
		s := NewSlug()
		if len(s) != slugLength {
			t.Fatalf("NewSlug() len = %d, want %d (%q)", len(s), slugLength, s)
		}
		for _, c := range s {
			if !strings.ContainsRune(alphabet, c) {
				t.Fatalf("NewSlug() = %q contains char %q outside alphabet", s, c)
			}
		}
		// Generated slugs must themselves be safe ids (used for paths later).
		if !IsSafeID(s) {
			t.Fatalf("NewSlug() = %q is not a safe id", s)
		}
		seen[s] = struct{}{}
	}
	// 1000 draws from a 56^8 space must be effectively collision-free.
	if len(seen) != 1000 {
		t.Errorf("NewSlug() produced %d unique of 1000 draws", len(seen))
	}
}

func TestIsValidExpiry(t *testing.T) {
	valid := []string{"1h", "6h", "1d", "7d", "30d", "never"}
	for _, v := range valid {
		if !IsValidExpiry(v) {
			t.Errorf("IsValidExpiry(%q) = false, want true", v)
		}
	}
	invalid := []string{"", "2h", "8d", "forever", "1H", "NEVER", " 7d", "7d "}
	for _, v := range invalid {
		if IsValidExpiry(v) {
			t.Errorf("IsValidExpiry(%q) = true, want false", v)
		}
	}
}

func TestExpiryToTimestamp(t *testing.T) {
	const now = int64(1_000_000)
	tests := []struct {
		value   string
		wantTS  int64
		wantOK  bool
		comment string
	}{
		{"1h", now + hourMs, true, "1 hour"},
		{"6h", now + 6*hourMs, true, "6 hours"},
		{"1d", now + dayMs, true, "1 day"},
		{"7d", now + 7*dayMs, true, "7 days"},
		{"30d", now + 30*dayMs, true, "30 days"},
		{"never", 0, false, "never -> NULL"},
		{"", 0, false, "empty unknown -> NULL"},
		{"bogus", 0, false, "unknown key -> NULL"},
	}
	for _, tt := range tests {
		t.Run(tt.comment, func(t *testing.T) {
			ts, ok := ExpiryToTimestamp(tt.value, now)
			if ts != tt.wantTS || ok != tt.wantOK {
				t.Errorf("ExpiryToTimestamp(%q,%d) = (%d,%v), want (%d,%v)",
					tt.value, now, ts, ok, tt.wantTS, tt.wantOK)
			}
		})
	}
}

func ptr64(v int64) *int64 { return &v }

func TestParseMaxDownloads(t *testing.T) {
	tests := []struct {
		name string
		in   *int64
		want *int64
	}{
		{"nil -> nil (unlimited)", nil, nil},
		{"zero -> nil", ptr64(0), nil},
		{"negative -> nil", ptr64(-5), nil},
		{"one -> one", ptr64(1), ptr64(1)},
		{"normal -> same", ptr64(42), ptr64(42)},
		{"at cap -> cap", ptr64(10_000), ptr64(10_000)},
		{"over cap -> clamped", ptr64(99_999), ptr64(10_000)},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := ParseMaxDownloads(tt.in)
			if !eqPtr64(got, tt.want) {
				t.Errorf("ParseMaxDownloads(%v) = %v, want %v", show(tt.in), show(got), show(tt.want))
			}
		})
	}
}

func TestIsExhausted(t *testing.T) {
	tests := []struct {
		count int64
		max   *int64
		want  bool
	}{
		{0, nil, false},      // unlimited never exhausted
		{99999, nil, false},  // unlimited never exhausted
		{0, ptr64(1), false}, // under limit
		{1, ptr64(1), true},  // at limit
		{2, ptr64(1), true},  // over limit (defensive)
		{4, ptr64(5), false},
		{5, ptr64(5), true},
	}
	for _, tt := range tests {
		if got := IsExhausted(tt.count, tt.max); got != tt.want {
			t.Errorf("IsExhausted(%d,%v) = %v, want %v", tt.count, show(tt.max), got, tt.want)
		}
	}
}

func TestDownloadsLeft(t *testing.T) {
	tests := []struct {
		count int64
		max   *int64
		want  *int64
	}{
		{0, nil, nil}, // unlimited
		{5, nil, nil}, // unlimited
		{0, ptr64(3), ptr64(3)},
		{2, ptr64(3), ptr64(1)},
		{3, ptr64(3), ptr64(0)},
		{5, ptr64(3), ptr64(0)}, // never negative
	}
	for _, tt := range tests {
		got := DownloadsLeft(tt.count, tt.max)
		if !eqPtr64(got, tt.want) {
			t.Errorf("DownloadsLeft(%d,%v) = %v, want %v", tt.count, show(tt.max), show(got), show(tt.want))
		}
	}
}

func TestIsValidKeyVerifier(t *testing.T) {
	// A real verifier: base64url(SHA-256(...)) is 43 unpadded chars.
	sum := sha256.Sum256([]byte("content key"))
	good := base64.RawURLEncoding.EncodeToString(sum[:])
	if len(good) != 43 {
		t.Fatalf("test setup: expected 43-char verifier, got %d", len(good))
	}
	if !IsValidKeyVerifier(good) {
		t.Errorf("IsValidKeyVerifier(%q) = false, want true", good)
	}

	bad := []struct {
		name string
		v    string
	}{
		{"empty", ""},
		{"too short", strings.Repeat("a", 42)},
		{"too long", strings.Repeat("a", 44)},
		{"padded base64", good[:42] + "="},
		{"plus and slash (std not url)", strings.Repeat("a", 41) + "+/"},
		{"space", strings.Repeat("a", 42) + " "},
	}
	for _, tt := range bad {
		t.Run(tt.name, func(t *testing.T) {
			if IsValidKeyVerifier(tt.v) {
				t.Errorf("IsValidKeyVerifier(%q) = true, want false", tt.v)
			}
		})
	}
}

func TestVerifierMatches(t *testing.T) {
	const stored = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ" // 43 chars
	tests := []struct {
		name     string
		provided string
		want     bool
	}{
		{"correct", stored, true},
		{"wrong same length", strings.Repeat("z", len(stored)), false},
		{"empty", "", false},
		{"wrong length shorter", stored[:10], false},
		{"wrong length longer", stored + "extra", false},
		{"both empty", "", false}, // provided empty vs non-empty stored
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := VerifierMatches(tt.provided, stored); got != tt.want {
				t.Errorf("VerifierMatches(%q, stored) = %v, want %v", tt.provided, got, tt.want)
			}
		})
	}
	// Two empties match (degenerate but constant-time-consistent).
	if !VerifierMatches("", "") {
		t.Errorf("VerifierMatches(\"\",\"\") = false, want true (equal inputs)")
	}
}

func TestManageToken(t *testing.T) {
	tok := NewManageToken()
	if len(tok) != 43 {
		t.Fatalf("NewManageToken() len = %d, want 43 (%q)", len(tok), tok)
	}
	if !IsValidManageToken(tok) {
		t.Errorf("IsValidManageToken(%q) = false, want true", tok)
	}
	// Two mints differ.
	if NewManageToken() == tok {
		t.Errorf("NewManageToken() produced a duplicate token")
	}

	hash := HashManageToken(tok)
	if len(hash) != 43 {
		t.Fatalf("HashManageToken() len = %d, want 43 (%q)", len(hash), hash)
	}
	if !IsValidManageTokenHash(hash) {
		t.Errorf("IsValidManageTokenHash(%q) = false, want true", hash)
	}
	// Hash is deterministic and matches the canonical computation.
	sum := sha256.Sum256([]byte(tok))
	if want := base64.RawURLEncoding.EncodeToString(sum[:]); hash != want {
		t.Errorf("HashManageToken mismatch: got %q want %q", hash, want)
	}
}

func TestManageTokenMatches(t *testing.T) {
	tok := NewManageToken()
	storedHash := HashManageToken(tok)

	tests := []struct {
		name       string
		provided   string
		storedHash *string
		want       bool
	}{
		{"correct token vs its hash", tok, &storedHash, true},
		{"wrong token", NewManageToken(), &storedHash, false},
		{"empty token", "", &storedHash, false},
		{"nil stored hash (legacy)", tok, nil, false},
		{"empty stored hash", tok, strPtr(""), false},
		{"both empty", "", strPtr(""), false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := ManageTokenMatches(tt.provided, tt.storedHash); got != tt.want {
				t.Errorf("ManageTokenMatches(...) = %v, want %v", got, tt.want)
			}
		})
	}

	// Wrong-length stored hash must still reject (hashes are fixed length, but
	// a corrupted/short stored value must not match and must not panic).
	short := "short"
	if ManageTokenMatches(tok, &short) {
		t.Errorf("ManageTokenMatches with short stored hash = true, want false")
	}
}

func TestIsUploadComplete(t *testing.T) {
	tests := []struct {
		name          string
		onDisk        int64
		declared      int64
		declaredKnown bool
		want          bool
	}{
		{"unknown declared -> accept", 0, 0, false, true},
		{"unknown declared with bytes -> accept", 123, 0, false, true},
		{"exact match", 100, 100, true, true},
		{"over (more on disk) -> complete", 101, 100, true, true},
		{"under -> incomplete", 99, 100, true, false},
		{"empty file declared zero -> complete", 0, 0, true, true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := IsUploadComplete(tt.onDisk, tt.declared, tt.declaredKnown)
			if got != tt.want {
				t.Errorf("IsUploadComplete(%d,%d,%v) = %v, want %v",
					tt.onDisk, tt.declared, tt.declaredKnown, got, tt.want)
			}
		})
	}
}

// --- small test helpers ---

func eqPtr64(a, b *int64) bool {
	if a == nil || b == nil {
		return a == nil && b == nil
	}
	return *a == *b
}

func show(p *int64) string {
	if p == nil {
		return "nil"
	}
	return strconvI(*p)
}

func strconvI(v int64) string {
	// avoid importing strconv just for tests' debug strings
	neg := v < 0
	if neg {
		v = -v
	}
	if v == 0 {
		return "0"
	}
	var b [20]byte
	i := len(b)
	for v > 0 {
		i--
		b[i] = byte('0' + v%10)
		v /= 10
	}
	s := string(b[i:])
	if neg {
		return "-" + s
	}
	return s
}

func strPtr(s string) *string { return &s }
