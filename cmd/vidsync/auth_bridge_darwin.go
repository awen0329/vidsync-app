// auth_bridge_darwin.go is the macOS half of the auth bridge.
//
// Minimal stub for the initial macOS port:
//
//   - forwardURIToRunningInstance / startAuthBridgePipeListener are
//     no-ops. macOS routes vidsync:// URLs to a single .app instance
//     via LaunchServices once we ship a proper bundle with the URL
//     scheme declared in Info.plist, so the second-instance forwarding
//     dance Windows needs doesn't apply.
//
//   - Token storage is a plain file at the same path Windows uses
//     (~/Library/Application Support/Vidsync/auth.bin), permission
//     0o600. NOT encrypted. TODO: move to the macOS Keychain
//     (Security.framework) before broad release.

//go:build darwin

package main

import (
	"log"
	"os"
	"path/filepath"
	"strings"
)

// forwardURIToRunningInstance: no-op on macOS. Returns false so
// main.go knows the caller didn't claim delivery — but on darwin
// claimSingleInstance always returns true, so this is never reached.
func forwardURIToRunningInstance(uri string) bool {
	log.Printf("auth bridge: forwardURIToRunningInstance is a no-op on macOS (URL=%q)", strings.SplitN(uri, "?", 2)[0])
	return false
}

// startAuthBridgePipeListener: no-op on macOS for the same reason.
func startAuthBridgePipeListener(_ *App) {}

// signalShowToRunningInstance: no-op on macOS. claimSingleInstance
// always returns true there, so the second-instance path that would
// call this is never reached; LaunchServices reactivates the existing
// .app on a re-open instead.
func signalShowToRunningInstance() bool { return false }

// nudgeWindowToFront: no-op on macOS. Wails' WindowShow already
// raises the window via NSWindow.makeKeyAndOrderFront:, so there's
// nothing extra to do. The Windows counterpart uses win32 to bypass
// the anti-focus-stealing policy after the URI-forwarder hands over
// its foreground right.
func nudgeWindowToFront() {}

func saveAuthToken(token string) error {
	path, err := authTokenPath()
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, []byte(token), 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}

func loadAuthToken() (string, error) {
	path, err := authTokenPath()
	if err != nil {
		return "", err
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		return "", err
	}
	return strings.TrimSpace(string(raw)), nil
}

func deleteAuthToken() error {
	path, err := authTokenPath()
	if err != nil {
		return err
	}
	return os.Remove(path)
}
