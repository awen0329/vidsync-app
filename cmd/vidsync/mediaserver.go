// mediaserver.go stands up a streaming HTTP proxy on a loopback port
// for large-file responses from the daemon (`/rest/folder/file`).
//
// Why a separate server: Wails' AssetServer responsewriter buffers
// every response body in memory before handing it to WebView2 via
// PutByteContent. For a multi-gigabyte video file that means we
// (a) hold the full file in vidsync.exe's RAM and (b) hit
// "Resp.PutByteContent failed: Not enough memory resources" inside
// WebView2 — which then crashes the host process via os.Exit(-1).
// See pkg/assetserver/webview/responsewriter_windows.go in the Wails
// source tree for the buffering. The fix is to bypass AssetServer
// entirely for media URLs: WebView2 can fetch directly from an
// arbitrary loopback URL and gets a real streamed response.
//
// CORS: WebView2 origin is `http://wails.localhost`; our media server
// lives at `http://127.0.0.1:NNNN`. We send permissive CORS headers
// so `<video crossOrigin="anonymous">` and the canvas-based thumbnail
// extractor in lib/thumbnails.ts get clean (non-tainted) frames.

package main

import (
	"context"
	"fmt"
	"io"
	stdlog "log"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"sync"
	"time"
)

type mediaServer struct {
	app *App

	mu       sync.RWMutex
	url      string
	listener net.Listener
	srv      *http.Server
}

func newMediaServer(app *App) *mediaServer { return &mediaServer{app: app} }

// URL returns the http://127.0.0.1:NNNN base, or "" before start.
func (m *mediaServer) URL() string {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return m.url
}

// start binds a random loopback port and begins serving. Safe to
// call from any goroutine; subsequent calls are no-ops.
func (m *mediaServer) start() error {
	m.mu.Lock()
	if m.srv != nil {
		m.mu.Unlock()
		return nil
	}
	m.mu.Unlock()

	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return fmt.Errorf("media server listen: %w", err)
	}

	mux := http.NewServeMux()
	mux.HandleFunc("/file", m.handleFile)
	mux.HandleFunc("/preview", m.handlePreview)

	srv := &http.Server{
		Handler:           mux,
		ReadHeaderTimeout: 10 * time.Second,
		// No write timeout — a 100 GB video over a slow disk could
		// take a long time, and we don't want the server to slam the
		// connection shut mid-stream.
	}

	addr := ln.Addr().String()
	m.mu.Lock()
	m.listener = ln
	m.srv = srv
	m.url = "http://" + addr
	m.mu.Unlock()

	go func() {
		if err := srv.Serve(ln); err != nil && err != http.ErrServerClosed {
			stdlog.Printf("media server: %v", err)
		}
	}()
	return nil
}

func (m *mediaServer) stop() {
	m.mu.RLock()
	srv := m.srv
	m.mu.RUnlock()
	if srv == nil {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	_ = srv.Shutdown(ctx)
}

// handleFile proxies /file?folder=...&path=... to the daemon's
// /rest/folder/file endpoint with the X-API-Key header injected and
// Range/etc passed through. httputil.ReverseProxy streams response
// bodies (it uses io.Copy under the hood), so a 1 GB video round-trips
// without ever being buffered in our memory.
func (m *mediaServer) handleFile(w http.ResponseWriter, r *http.Request) {
	m.proxyTo(w, r, "/rest/folder/file")
}

// handlePreview streams the daemon's transcoded H.264/AAC proxy. A full-length
// proxy can be hundreds of MB, so — like /file — it must go through this
// streaming proxy rather than the buffering Wails AssetServer, and it's
// Range-aware so the player can seek anywhere in the proxy.
func (m *mediaServer) handlePreview(w http.ResponseWriter, r *http.Request) {
	m.proxyTo(w, r, "/rest/folder/preview")
}

// proxyTo reverse-proxies a media request to a daemon REST endpoint, injecting
// the API key and normalizing CORS to a single Access-Control-Allow-Origin.
func (m *mediaServer) proxyTo(w http.ResponseWriter, r *http.Request, restPath string) {
	// Preflight: answer directly with permissive CORS.
	if r.Method == http.MethodOptions {
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Access-Control-Allow-Headers", "Range")
		w.Header().Set("Access-Control-Expose-Headers", "Content-Range, Accept-Ranges, Content-Length")
		w.WriteHeader(http.StatusNoContent)
		return
	}
	// NB: for the proxied GET we deliberately do NOT set CORS headers on
	// w here. The daemon's REST layer already emits its own
	// Access-Control-Allow-Origin, and ReverseProxy *appends* upstream
	// headers to whatever we pre-set — yielding TWO ACAO values, which
	// Chromium/WebView2 treats as an invalid CORS response and rejects.
	// A rejected response taints/aborts <video crossOrigin="anonymous">,
	// which is exactly why canvas thumbnail extraction produced nothing.
	// We instead normalize to a single value in ModifyResponse below.

	info := m.app.daemonSnapshot()
	if info.URL == "" {
		http.Error(w, "vidsync: daemon not ready", http.StatusServiceUnavailable)
		return
	}
	target, err := url.Parse(info.URL)
	if err != nil {
		http.Error(w, "vidsync: bad daemon URL", http.StatusInternalServerError)
		return
	}

	proxy := &httputil.ReverseProxy{
		Director: func(req *http.Request) {
			req.URL.Scheme = target.Scheme
			req.URL.Host = target.Host
			// Translate the media path → the daemon REST endpoint.
			req.URL.Path = restPath
			req.Host = target.Host
			req.Header.Set("X-API-Key", info.APIKey)
		},
		// Stream over the daemon's in-memory listener (no socket); the
		// URL host is cosmetic. ReverseProxy still io.Copy-streams the
		// body, so a multi-GB video round-trips through the pipe without
		// buffering. DisableKeepAlives: this is a one-shot streaming
		// request, no reuse to preserve.
		Transport: &http.Transport{
			DialContext:       m.app.dialDaemon,
			DisableKeepAlives: true,
		},
		// Normalize CORS on the upstream response so the browser sees
		// exactly ONE Access-Control-Allow-Origin. Header.Set collapses
		// any value(s) the daemon already added to a single "*", and we
		// expose the Range-related headers <video> needs for seeking.
		// Without this the response carries duplicate ACAO headers and
		// WebView2 fails the cross-origin fetch → broken thumbnails.
		ModifyResponse: func(resp *http.Response) error {
			resp.Header.Set("Access-Control-Allow-Origin", "*")
			resp.Header.Set("Access-Control-Allow-Headers", "Range")
			resp.Header.Set("Access-Control-Expose-Headers", "Content-Range, Accept-Ranges, Content-Length")
			return nil
		},
		ErrorLog: stdlog.New(io.Discard, "", 0),
	}
	proxy.ServeHTTP(w, r)
}
