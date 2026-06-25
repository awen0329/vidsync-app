// auth_bridge.go owns the cross-platform pieces of the system-browser
// sign-in flow described in cmd/vidsync/uri_scheme.go and the
// website's /auth/desktop route. The OS-specific transport (named
// pipe on Windows, Unix socket on macOS) and the OS-specific crypto
// wrapper around the on-disk token (DPAPI on Windows, plain file on
// macOS for now — Keychain is a TODO) live in:
//
//   auth_bridge_windows.go  — named-pipe IPC + DPAPI
//   auth_bridge_darwin.go   — Unix-socket IPC (stub) + plain-file storage
//
// Responsibilities kept here:
//
//   1. URI parsing (`token=<vsk_...>` out of fragment/query).
//   2. Wails-bound methods (SignIn, GetAuthToken, ClearAuthToken,
//      deliverStartupURI) — frontend auth/AuthProvider.tsx
//      reads/writes through these.
//   3. deliverAuthURI — the single funnel that turns a freshly
//      received URI into persisted state plus a Wails event.

package main

import (
	"context"
	"errors"
	"log"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/wailsapp/wails/v2/pkg/runtime"
)

// authTokenPath returns the on-disk location of the encrypted
// (Windows: DPAPI) or plain (macOS: 0o600 file) vsk_ token. Lives in
// the same per-user Vidsync state directory as the daemon config so
// uninstalling cleans up both at once.
func authTokenPath() (string, error) {
	dir, err := vidsyncConfigDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(dir, "auth.bin"), nil
}

// deliverAuthURI is the single entry point that turns a freshly-
// received URI into app state changes. Called from the pipe/socket
// listener (forwarded URL) and from OnStartup (URL on this process's
// own argv).
//
// The URI is `vidsync://auth-callback#token=<vsk_…>` (fragment, not
// query, to keep the token out of any referrer header). We parse the
// fragment, persist the token, and emit `auth:token-changed` so the
// React app can leave its sign-in screen.
func (a *App) deliverAuthURI(uri string) {
	if uri == "" {
		return
	}
	tok := extractTokenFromURI(uri)
	if tok == "" {
		log.Printf("auth bridge: URI received with no token=… fragment: %q", uri)
		return
	}
	if err := saveAuthToken(tok); err != nil {
		log.Printf("auth bridge: save token failed: %v", err)
		return
	}
	a.bringWindowToFront()
	a.emitAuthChanged()
	log.Printf("auth bridge: token stored, frontend notified")
}

func (a *App) bringWindowToFront() {
	// Clear windowHidden so the tray left-click toggle (ToggleWindow)
	// stays in sync: after the X button hid us to the tray, a re-launch
	// or auth callback that surfaces the window must leave the toggle
	// believing the window is visible, or the next tray click would
	// "show" an already-shown window instead of hiding it.
	a.mu.Lock()
	ctx := a.ctx
	a.windowHidden = false
	a.mu.Unlock()
	if ctx == nil {
		return
	}
	runtime.WindowShow(ctx)
	runtime.WindowUnminimise(ctx)
	// Per-OS final foreground nudge: Wails has no Set-Foreground API in
	// v2, and on Windows the anti-focus-stealing policy blocks
	// WindowShow alone from raising us above whatever the user is
	// currently on. The Windows impl drops to win32 (SetForegroundWindow)
	// after the URI-forwarder has handed us its foreground right; on
	// macOS Wails' WindowShow already raises the window, so the hook
	// is a no-op.
	nudgeWindowToFront()
}

func (a *App) emitAuthChanged() {
	a.mu.RLock()
	ctx := a.ctx
	a.mu.RUnlock()
	if ctx == nil {
		return
	}
	runtime.EventsEmit(ctx, "auth:token-changed")
}

// extractTokenFromURI pulls a `token=...` value out of a vidsync://
// URL's fragment or query string. We try fragment first (the website
// uses #token=...) and fall back to query (?token=...) so the bridge
// stays compatible with future variants.
func extractTokenFromURI(raw string) string {
	u, err := url.Parse(raw)
	if err != nil {
		return ""
	}
	if frag := u.Fragment; frag != "" {
		if v, err := url.ParseQuery(frag); err == nil {
			if t := strings.TrimSpace(v.Get("token")); t != "" {
				return t
			}
		}
	}
	if t := strings.TrimSpace(u.Query().Get("token")); t != "" {
		return t
	}
	return ""
}

// --- Wails-bound auth methods ---

// SignIn opens the system browser at the bridge URL. Caller is the
// React app's auth provider on its "Sign in" button click. Hard-codes
// the production URL — the desktop client only ever talks to live.
func (a *App) SignIn() {
	a.OpenExternal("https://thevidsync.com/auth/desktop?return=vidsync://auth-callback")
}

// GetAuthToken returns the currently stored vsk_ token, or "" if none.
// Frontend calls this at mount; if "", it shows the sign-in screen,
// otherwise it loads the app shell using this token as Bearer.
func (a *App) GetAuthToken() string {
	tok, err := loadAuthToken()
	if err != nil {
		// Don't log "not found" — that's the expected pre-sign-in case.
		if !errors.Is(err, os.ErrNotExist) {
			log.Printf("auth bridge: load token: %v", err)
		}
		return ""
	}
	return tok
}

// ClearAuthToken is the user-initiated "Sign out": it wipes the local
// vsk_ token AND opens the system browser to /auth/desktop/signout so
// the Clerk session on thevidsync.com is cleared at the same time. A
// full sign-out has to reach the browser — that's where the website
// session cookie lives — so the next sign-in genuinely re-authenticates
// instead of silently reusing a still-valid Clerk cookie. The signout
// page renders its own "Signed out — you can close this tab"
// confirmation, so the browser doesn't land on a blank page.
//
// For the *involuntary* logout (this device was displaced by another
// via the email-code transfer) use ClearAuthTokenLocal, which skips the
// browser: that user is legitimately signed in elsewhere, so popping a
// browser sign-out on the displaced machine would be both surprising
// and wrong.
func (a *App) ClearAuthToken() {
	if err := deleteAuthToken(); err != nil && !errors.Is(err, os.ErrNotExist) {
		log.Printf("auth bridge: delete token: %v", err)
	}
	deleteLastEmail()
	a.OpenExternal("https://thevidsync.com/auth/desktop/signout")
	a.emitAuthChanged()
}

// ClearAuthTokenLocal wipes only the local token and notifies the
// frontend, WITHOUT the Clerk browser sign-out that ClearAuthToken
// does. Used for the involuntary displacement logout (see above) — the
// displaced device drops quietly to the sign-in screen, and the user's
// website session (active on the other machine) is left untouched.
func (a *App) ClearAuthTokenLocal() {
	if err := deleteAuthToken(); err != nil && !errors.Is(err, os.ErrNotExist) {
		log.Printf("auth bridge: delete token (local): %v", err)
	}
	deleteLastEmail()
	a.emitAuthChanged()
}

// startupURIOnce ensures we don't emit auth:token-changed twice for
// the same URI when main passes it to deliverAuthURI before the
// WebView is up — we'd otherwise race the React app's mount.
var startupURIOnce sync.Once

// deliverStartupURI is called by main once after OnStartup completes.
// If the binary was launched with a vidsync:// URL on argv, this
// applies it. Idempotent.
func (a *App) deliverStartupURI(uri string) {
	if uri == "" {
		return
	}
	startupURIOnce.Do(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		for ctx.Err() == nil {
			a.mu.RLock()
			ready := a.ctx != nil
			a.mu.RUnlock()
			if ready {
				break
			}
			time.Sleep(50 * time.Millisecond)
		}
		a.deliverAuthURI(uri)
	})
}
