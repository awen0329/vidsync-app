// lastemail.go persists the signed-in account email on the Go side so the
// UI can show it immediately on launch — even when the cloud control plane
// is briefly unreachable and /v1/me hasn't answered yet. The frontend used
// to keep this in webview localStorage, but the macOS WKWebView doesn't
// reliably persist localStorage across launches, so the durable copy lives
// here next to the auth token.
//
// The email isn't a secret (unlike the vsk_ token), so it's a plain 0o600
// file with no DPAPI/Keychain wrapping. It sits in the same per-user state
// dir as auth.bin so uninstall cleans up both, and it's deleted on sign-out
// via the auth bridge (see ClearAuthToken / ClearAuthTokenLocal).

package main

import (
	"errors"
	"log"
	"os"
	"path/filepath"
	"strings"
)

func lastEmailPath() (string, error) {
	dir, err := vidsyncConfigDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(dir, "last-email.txt"), nil
}

// GetLastEmail returns the last persisted account email, or "" if none.
// Wails-bound; the frontend reads it at mount as a fallback for the
// sidebar/account email before /v1/me resolves.
func (a *App) GetLastEmail() string {
	p, err := lastEmailPath()
	if err != nil {
		return ""
	}
	b, err := os.ReadFile(p)
	if err != nil {
		// Not-found is the expected pre-sign-in / first-launch case.
		if !errors.Is(err, os.ErrNotExist) {
			log.Printf("last-email: read: %v", err)
		}
		return ""
	}
	return strings.TrimSpace(string(b))
}

// SetLastEmail persists the account email so it survives a relaunch.
// Wails-bound; the frontend calls it whenever /v1/me returns an email. A
// no-op for the empty string so we never clobber a known address with a
// blank — clearing is done by deleteLastEmail on sign-out.
func (a *App) SetLastEmail(email string) {
	email = strings.TrimSpace(email)
	if email == "" {
		return
	}
	p, err := lastEmailPath()
	if err != nil {
		return
	}
	if err := os.WriteFile(p, []byte(email), 0o600); err != nil {
		log.Printf("last-email: write: %v", err)
	}
}

// deleteLastEmail removes the persisted email. Called from both sign-out
// paths so the next account on this machine never briefly shows the
// previous user's address.
func deleteLastEmail() {
	p, err := lastEmailPath()
	if err != nil {
		return
	}
	if err := os.Remove(p); err != nil && !errors.Is(err, os.ErrNotExist) {
		log.Printf("last-email: delete: %v", err)
	}
}
