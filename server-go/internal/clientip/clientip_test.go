package clientip

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestParse(t *testing.T) {
	tests := []struct {
		name    string
		value   string
		wantErr bool
	}{
		{"empty", "", false},
		{"true", "true", false},
		{"false", "false", false},
		{"one CIDR", "10.0.0.0/8", false},
		{"list with spaces", "10.0.0.0/8, 172.16.0.0/12 ,fd00::/8", false},
		{"bare address", "192.168.1.10", false},
		{"stray comma", "10.0.0.0/8,", false},
		{"word", "yes please", true},
		{"prefix too long", "10.0.0.0/33", true},
		{"one bad entry", "10.0.0.0/8, proxy.lan", true},
		{"only commas", ",,", true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			_, err := Parse(tt.value)
			if (err != nil) != tt.wantErr {
				t.Fatalf("Parse(%q) err = %v, wantErr %v", tt.value, err, tt.wantErr)
			}
		})
	}
}

func TestProxies_ClientIP(t *testing.T) {
	tests := []struct {
		name       string
		trust      string
		remoteAddr string
		xff        string
		want       string
	}{
		{"untrusted: peer", "", "10.0.0.9:12345", "", "10.0.0.9"},
		{"untrusted: header ignored", "false", "10.0.0.9:12345", "1.2.3.4", "10.0.0.9"},
		{"trust all: first entry", "true", "10.0.0.9:12345", "1.2.3.4, 5.6.7.8", "1.2.3.4"},
		{"trust all: whitespace trimmed", "true", "10.0.0.9:12345", "  1.2.3.4 , 5.6.7.8", "1.2.3.4"},
		{"trust all: no header", "true", "10.0.0.9:12345", "", "10.0.0.9"},
		{"CIDR: peer inside reads the header", "10.0.0.0/8", "10.0.0.9:12345", "1.2.3.4", "1.2.3.4"},
		{"CIDR: peer outside is the client", "10.0.0.0/8", "203.0.113.7:12345", "1.2.3.4", "203.0.113.7"},
		{"CIDR: forged left entry skipped", "10.0.0.0/8", "10.0.0.9:12345", "6.6.6.6, 1.2.3.4", "1.2.3.4"},
		{"CIDR: proxy chain skipped", "10.0.0.0/8", "10.0.0.9:12345", "1.2.3.4, 10.0.0.3", "1.2.3.4"},
		{"CIDR: chain of proxies only", "10.0.0.0/8", "10.0.0.9:12345", "10.0.0.4, 10.0.0.3", "10.0.0.4"},
		{"CIDR: bare address", "10.0.0.9", "10.0.0.9:12345", "1.2.3.4", "1.2.3.4"},
		{"CIDR: mapped IPv4 peer", "10.0.0.0/8", "[::ffff:10.0.0.9]:12345", "1.2.3.4", "1.2.3.4"},
		{"CIDR: IPv6 proxy", "fd00::/8", "[fd00::1]:12345", "2001:db8::7", "2001:db8::7"},
		{"CIDR: unreadable entry stops the walk", "10.0.0.0/8", "10.0.0.9:12345", "1.2.3.4, junk", "10.0.0.9"},
		{"portless RemoteAddr used verbatim", "", "10.0.0.9", "", "10.0.0.9"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			p, err := Parse(tt.trust)
			if err != nil {
				t.Fatalf("Parse(%q): %v", tt.trust, err)
			}
			r := httptest.NewRequest(http.MethodGet, "/", nil)
			r.RemoteAddr = tt.remoteAddr
			if tt.xff != "" {
				r.Header.Set("X-Forwarded-For", tt.xff)
			}
			if got := p.ClientIP(r); got != tt.want {
				t.Errorf("ClientIP(peer %q, xff %q, trust %q) = %q, want %q",
					tt.remoteAddr, tt.xff, tt.trust, got, tt.want)
			}
		})
	}
}

func TestNetwork(t *testing.T) {
	tests := []struct {
		name, ip, want string
	}{
		{"IPv4 stays whole", "203.0.113.7", "203.0.113.7"},
		{"IPv6 masks to /64", "2001:db8:1:2:3:4:5:6", "2001:db8:1:2::/64"},
		{"IPv4-mapped IPv6 is not masked", "::ffff:203.0.113.7", "::ffff:203.0.113.7"},
		{"no address", "unix-socket", "unix-socket"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := Network(tt.ip); got != tt.want {
				t.Fatalf("Network(%q) = %q, want %q", tt.ip, got, tt.want)
			}
		})
	}
}
