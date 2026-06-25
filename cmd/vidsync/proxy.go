// proxy.go installs a reverse proxy in the Wails asset server that
// forwards /rest/* requests to the local sync daemon with the
// X-API-Key header injected. This mirrors what Vite's dev proxy
// does, so the React app stays same-origin in both modes and we
// avoid CORS preflight failures the daemon doesn't answer.

package main

import (
	"io"
	stdlog "log"
	"net/http"
	"net/http/httputil"
	"net/url"
	"strings"

	"github.com/wailsapp/wails/v2/pkg/options/assetserver"
)

// restProxyMiddleware returns Wails asset-server middleware that
// proxies /rest/* to the daemon URL cached on app, falling through
// to the static asset handler for everything else. The daemon info
// is read on each request (via app.daemonSnapshot) because the
// daemon isn't yet known when the middleware is constructed —
// OnStartup populates it asynchronously.
func restProxyMiddleware(app *App) assetserver.Middleware {
	return func(next http.Handler) http.Handler {
		proxy := &httputil.ReverseProxy{
			Director: func(req *http.Request) {
				info := app.daemonSnapshot()
				target, _ := url.Parse(info.URL)
				req.URL.Scheme = target.Scheme
				req.URL.Host = target.Host
				req.Host = target.Host
				req.Header.Set("X-API-Key", info.APIKey)
			},
			// The daemon has no socket — it serves the REST API over an
			// in-memory listener (see inprocess.go / memlistener.go).
			// DialContext routes every request to that in-process pipe;
			// the URL host above is cosmetic. DisableKeepAlives keeps
			// each request on a fresh pipe, sidestepping idle-timeout
			// reuse subtleties over net.Pipe at negligible in-process cost.
			Transport: &http.Transport{
				DialContext:       app.dialDaemon,
				DisableKeepAlives: true,
			},
			// Silence ReverseProxy's default per-error logging.
			// Once the daemon exits (clean Quit or crash), every
			// in-flight long-poll in the React app fails and the
			// default logger spams the file with identical
			// "connection refused" lines. The HTTP status returned
			// to the frontend is unchanged; we just drop the
			// duplicated noise.
			ErrorLog: stdlog.New(io.Discard, "", 0),
		}
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if !strings.HasPrefix(r.URL.Path, "/rest/") {
				next.ServeHTTP(w, r)
				return
			}
			info := app.daemonSnapshot()
			if info.URL == "" {
				http.Error(w, "vidsync: daemon not ready", http.StatusServiceUnavailable)
				return
			}
			proxy.ServeHTTP(w, r)
		})
	}
}
