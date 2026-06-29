package config

import "testing"

func TestResolveBranding_Defaults(t *testing.T) {
	// All blank/whitespace -> the DEFAULT_BRANDING values from lib/branding.ts.
	b := ResolveBranding("", "  ", "")
	if b.AppName != "featherdrop" {
		t.Errorf("appName = %q, want featherdrop", b.AppName)
	}
	if b.LogoURL != "" {
		t.Errorf("logoUrl = %q, want empty (no logo)", b.LogoURL)
	}
	if b.AccentColor != "#d4af37" {
		t.Errorf("accentColor = %q, want #d4af37", b.AccentColor)
	}
}

func TestResolveBranding_TrimsAndKeeps(t *testing.T) {
	b := ResolveBranding("  MyDrop  ", "  https://x/logo.svg  ", "#AABBCC")
	if b.AppName != "MyDrop" {
		t.Errorf("appName = %q, want MyDrop (trimmed)", b.AppName)
	}
	if b.LogoURL != "https://x/logo.svg" {
		t.Errorf("logoUrl = %q, want trimmed URL", b.LogoURL)
	}
	if b.AccentColor != "#aabbcc" {
		t.Errorf("accentColor = %q, want #aabbcc (lowercased)", b.AccentColor)
	}
}

func TestResolveBranding_InvalidHexFallsBack(t *testing.T) {
	for _, bad := range []string{
		"d4af37",   // missing #
		"#d4af3",   // 5 digits
		"#d4af377", // 7 digits
		"#ggghhh",  // non-hex
		"red",      // CSS name
		"",         // blank
	} {
		b := ResolveBranding("App", "", bad)
		if b.AccentColor != "#d4af37" {
			t.Errorf("accentColor for %q = %q, want default #d4af37", bad, b.AccentColor)
		}
	}
}

func TestResolveBranding_ValidHexVariants(t *testing.T) {
	for _, in := range []string{"#d4af37", "#D4AF37", "#abc123"} {
		b := ResolveBranding("App", "", in)
		want := in
		// normaliser lowercases.
		switch in {
		case "#D4AF37":
			want = "#d4af37"
		}
		if b.AccentColor != want {
			t.Errorf("accentColor for %q = %q, want %q", in, b.AccentColor, want)
		}
	}
}

func TestConfig_BrandingMethod(t *testing.T) {
	cfg := Config{AppName: "  Foo  ", AppLogo: "", AccentColor: "#123456"}
	b := cfg.Branding()
	if b.AppName != "Foo" {
		t.Errorf("appName = %q, want Foo", b.AppName)
	}
	if b.AccentColor != "#123456" {
		t.Errorf("accentColor = %q, want #123456", b.AccentColor)
	}
	if b.LogoURL != "" {
		t.Errorf("logoUrl = %q, want empty", b.LogoURL)
	}
}
