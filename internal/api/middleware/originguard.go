package middleware

import (
	"log/slog"
	"net"
	"net/http"
	"net/url"
	"os"
	"strings"
)

// ClientHeader is sent by the Kizuna frontend on every API call. Requiring it on
// state-changing requests is what stops a foreign web page from driving the API:
// a custom header makes the request non-simple, so the browser must preflight it,
// and we never answer a preflight with permission.
const ClientHeader = "X-Kizuna-Client"

// AllowedHostsEnv lists extra Host values to accept, comma-separated. Needed only
// when Kizuna sits behind a proxy that passes its own hostname through.
const AllowedHostsEnv = "KIZUNA_ALLOWED_HOSTS"

// OriginGuard protects a Kizuna instance from web pages the user did not open
// themselves. It is not authentication — it assumes the port is reachable only
// by this machine — but it closes the two ways a browser can be used as a proxy
// into an unauthenticated local API:
//
//   - Cross-site requests. Kizuna sets no CORS headers, so a foreign page cannot
//     read a response. It can still *send* one: a POST with a simple content type
//     needs no preflight, and no handler here inspects Content-Type. Requiring a
//     custom header on every state-changing request forces a preflight that fails.
//     The Origin check is a second, independent barrier.
//
//   - DNS rebinding. An attacker points their own domain at 127.0.0.1, which makes
//     the browser treat the page as same-origin — CORS and the header check both
//     stop applying. The Host header still carries the attacker's domain, so we
//     accept only loopback names, bare IP literals, and explicitly allowed hosts.
//     A rebound domain is none of those.
func OriginGuard(allowedHosts []string) func(http.Handler) http.Handler {
	allowed := make(map[string]bool, len(allowedHosts))
	for _, h := range allowedHosts {
		if h = strings.ToLower(strings.TrimSpace(h)); h != "" {
			allowed[h] = true
		}
	}

	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			// Health is the liveness probe for Docker and any supervisor in front
			// of it. Those clients are not browsers and cannot be talked into
			// carrying an attack, so keep it reachable without ceremony.
			if !strings.HasPrefix(r.URL.Path, "/api/") || r.URL.Path == "/api/health" {
				next.ServeHTTP(w, r)
				return
			}

			if !hostAllowed(r.Host, allowed) {
				reject(w, r, "unexpected Host header",
					"Kizuna only answers on localhost or a bare IP. If it runs behind a proxy, list the hostname in "+AllowedHostsEnv+".")
				return
			}

			if !isStateChanging(r.Method) {
				next.ServeHTTP(w, r)
				return
			}

			if origin := r.Header.Get("Origin"); origin != "" && !originAllowed(origin, r.Host) {
				reject(w, r, "cross-origin request rejected",
					"This request came from another site. Kizuna only accepts requests from its own page.")
				return
			}

			if r.Header.Get(ClientHeader) == "" {
				reject(w, r, "missing client header",
					"Write requests must carry the "+ClientHeader+" header. Scripts calling this API directly need to send it too.")
				return
			}

			next.ServeHTTP(w, r)
		})
	}
}

// AllowedHostsFromEnv reads the extra-hosts allowlist. Empty by default: the
// loopback and IP-literal rules already cover every normal local setup.
func AllowedHostsFromEnv() []string {
	raw := os.Getenv(AllowedHostsEnv)
	if raw == "" {
		return nil
	}
	return strings.Split(raw, ",")
}

func isStateChanging(method string) bool {
	switch method {
	case http.MethodPost, http.MethodPut, http.MethodPatch, http.MethodDelete:
		return true
	default:
		return false
	}
}

// hostAllowed accepts loopback names and any bare IP address. An IP literal
// cannot be the product of DNS rebinding — that attack needs a name to re-point
// — so allowing it keeps a deliberate KIZUNA_BIND=0.0.0.0 setup working without
// reopening the hole.
func hostAllowed(host string, allowed map[string]bool) bool {
	name := hostname(host)
	if name == "" {
		return false
	}
	if name == "localhost" || strings.HasSuffix(name, ".localhost") {
		return true
	}
	if net.ParseIP(name) != nil {
		return true
	}
	return allowed[name]
}

func originAllowed(origin, requestHost string) bool {
	u, err := url.Parse(origin)
	if err != nil || u.Host == "" {
		return false
	}
	// Same origin as the page itself — the ordinary case once the frontend is
	// served from the binary.
	if strings.EqualFold(u.Host, requestHost) {
		return true
	}
	// Vite serves the dev frontend on another loopback port and proxies /api
	// here, so the Origin legitimately differs during development. Anything on
	// loopback already implies code running on this machine, which is past the
	// point this guard defends.
	return isLoopbackName(hostname(u.Host))
}

func isLoopbackName(name string) bool {
	if name == "localhost" || strings.HasSuffix(name, ".localhost") {
		return true
	}
	if ip := net.ParseIP(name); ip != nil {
		return ip.IsLoopback()
	}
	return false
}

// hostname strips the port from a Host header value, handling the bracketed
// IPv6 form. Values without a port are returned as-is.
func hostname(host string) string {
	host = strings.ToLower(strings.TrimSpace(host))
	if host == "" {
		return ""
	}
	if h, _, err := net.SplitHostPort(host); err == nil {
		return strings.Trim(h, "[]")
	}
	return strings.Trim(host, "[]")
}

func reject(w http.ResponseWriter, r *http.Request, reason, detail string) {
	slog.Warn("request rejected by origin guard",
		"reason", reason,
		"method", r.Method,
		"path", r.URL.Path,
		"host", r.Host,
		"origin", r.Header.Get("Origin"),
	)
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusForbidden)
	_, _ = w.Write([]byte(`{"error":` + jsonString(detail) + `,"code":403}`))
}

// jsonString quotes a fixed message for the hand-built error body above. The
// messages are compile-time constants, so escaping quotes and backslashes is
// enough.
func jsonString(s string) string {
	s = strings.ReplaceAll(s, `\`, `\\`)
	s = strings.ReplaceAll(s, `"`, `\"`)
	return `"` + s + `"`
}
