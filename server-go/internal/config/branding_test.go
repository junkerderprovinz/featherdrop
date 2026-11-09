package config

import "testing"

func TestResolveBranding_Defaults(t *testing.T) {
	b := ResolveBranding("", "  ", "")
	if b.AppName != "CastleParcel" {
		t.Errorf("appName = %q, want CastleParcel", b.AppName)
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

func TestConfig_LogoOrigin(t *testing.T) {
	tests := []struct {
		name string
		logo string
		want string
	}{
		{"no logo", "", ""},
		{"same-origin path", "/icon-512.png", ""},
		{"data URL", "data:image/png;base64,iVBORw0KGgo=", ""},
		{"https URL", "https://cdn.example.com/brand/logo.png", "https://cdn.example.com"},
		{"port kept", "http://10.0.0.5:8080/logo.svg", "http://10.0.0.5:8080"},
		{"scheme lowered", "HTTPS://cdn.example.com/logo.png", "https://cdn.example.com"},
		{"IPv6 host", "https://[2001:db8::1]:8443/logo.png", "https://[2001:db8::1]:8443"},
		{"surrounding space", "  https://cdn.example.com/logo.png ", "https://cdn.example.com"},
		{"host that could break the policy", "https://cdn.example.com;script-src/x.png", ""},
		{"protocol-relative", "//cdn.example.com/logo.png", ""},
		{"other scheme", "ftp://cdn.example.com/logo.png", ""},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := (Config{AppLogo: tt.logo}).LogoOrigin(); got != tt.want {
				t.Errorf("LogoOrigin(%q) = %q, want %q", tt.logo, got, tt.want)
			}
		})
	}
}
