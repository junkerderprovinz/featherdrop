package share

import (
	"strings"
	"testing"
)

func TestIsValidRequestKey(t *testing.T) {
	tests := []struct {
		name string
		key  string
		want bool
	}{
		{"43 base64url characters", "Zmh6rfhivXdsj8GLjp-OIAiXFIVu4jOzkCpZHQ1fKSU", true},
		{"too short", "Zmh6rfhivXdsj8GLjp-OIAiXFIVu4jOzkCpZHQ1fKS", false},
		{"too long", "Zmh6rfhivXdsj8GLjp-OIAiXFIVu4jOzkCpZHQ1fKSUx", false},
		{"standard base64", "Zmh6rfhivXdsj8GLjp+OIAiXFIVu4jOzkCpZHQ1fKSU", false},
		{"empty", "", false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := IsValidRequestKey(tt.key); got != tt.want {
				t.Errorf("IsValidRequestKey(%q) = %v, want %v", tt.key, got, tt.want)
			}
		})
	}
}

func TestRequestKeyMatches(t *testing.T) {
	const stored = "Zmh6rfhivXdsj8GLjp-OIAiXFIVu4jOzkCpZHQ1fKSU"
	tests := []struct {
		name     string
		provided string
		want     bool
	}{
		{"same key", stored, true},
		{"one character off", "Zmh6rfhivXdsj8GLjp-OIAiXFIVu4jOzkCpZHQ1fKSV", false},
		{"empty", "", false},
		{"prefix", stored[:20], false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := RequestKeyMatches(tt.provided, stored); got != tt.want {
				t.Errorf("RequestKeyMatches(%q) = %v, want %v", tt.provided, got, tt.want)
			}
		})
	}
	if RequestKeyMatches("", "") {
		t.Error("an empty key matched an empty stored key")
	}
}

func TestCollectTokenMatches(t *testing.T) {
	token := NewManageToken()
	hash := HashCollectToken(token)
	if !CollectTokenMatches(token, hash) {
		t.Fatal("the token does not match its own hash")
	}
	for name, provided := range map[string]string{
		"another token":       NewManageToken(),
		"the hash itself":     hash,
		"empty":               "",
		"token with a suffix": token + "x",
	} {
		if CollectTokenMatches(provided, hash) {
			t.Errorf("%s matched", name)
		}
	}
	if CollectTokenMatches("", "") || CollectTokenMatches(token, "") {
		t.Error("an empty stored hash matched")
	}
}

func TestParseMaxUploads(t *testing.T) {
	ptr := func(v int64) *int64 { return &v }
	tests := []struct {
		name  string
		input *int64
		want  int64 // -1 for unlimited
	}{
		{"absent is unlimited", nil, -1},
		{"zero is unlimited", ptr(0), -1},
		{"negative is unlimited", ptr(-4), -1},
		{"one", ptr(1), 1},
		{"capped", ptr(1 << 40), maxUploadsCap},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := ParseMaxUploads(tt.input)
			v := int64(-1)
			if got != nil {
				v = *got
			}
			if v != tt.want {
				t.Errorf("ParseMaxUploads = %d, want %d", v, tt.want)
			}
		})
	}
}

func TestRequestTakesUploads(t *testing.T) {
	two := int64(2)
	tests := []struct {
		name  string
		count int64
		max   *int64
		want  bool
	}{
		{"unlimited", 1000, nil, true},
		{"room left", 1, &two, true},
		{"full", 2, &two, false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := RequestTakesUploads(tt.count, tt.max); got != tt.want {
				t.Errorf("RequestTakesUploads(%d) = %v, want %v", tt.count, got, tt.want)
			}
		})
	}
}

func TestIsValidSealedKey(t *testing.T) {
	if !IsValidSealedKey(make([]byte, SealedKeyBytes)) {
		t.Error("a sealed key of the right length was refused")
	}
	for _, n := range []int{0, SealedKeyBytes - 1, SealedKeyBytes + 1} {
		if IsValidSealedKey(make([]byte, n)) {
			t.Errorf("a sealed key of %d bytes was accepted", n)
		}
	}
}

func TestNewRequestUploadID(t *testing.T) {
	a, b := NewRequestUploadID(), NewRequestUploadID()
	if a == b || !IsSafeID(a) || strings.ContainsAny(a, "/.") {
		t.Errorf("upload ids %q and %q", a, b)
	}
}
