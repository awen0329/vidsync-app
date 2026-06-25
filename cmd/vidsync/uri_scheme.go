// uri_scheme.go registers `vidsync://` as a custom URI scheme in the
// Windows registry under HKCU\Software\Classes, so the OS routes
// `vidsync://auth-callback#token=...` (issued by thevidsync.com/auth/
// desktop after the user signs in) to vidsync.exe.
//
// The registration is per-user (HKCU, not HKLM), so the app doesn't
// need elevation. It's idempotent — safe to run on every launch.
// We do that rather than requiring an installer hook so portable /
// .zip distributions work too.
//
// Layout written:
//
//   HKCU\Software\Classes\vidsync\
//       (Default)        = "URL:Vidsync Protocol"
//       URL Protocol     = ""               (signals "this key handles a URI scheme")
//
//   HKCU\Software\Classes\vidsync\shell\open\command\
//       (Default)        = "\"C:\path\to\vidsync.exe\" \"%1\""
//
// When the user clicks `vidsync://auth-callback#token=...` Windows
// runs the command with %1 replaced by the URL. main.go pulls the URL
// out of os.Args[1].

//go:build windows

package main

import (
	"log"
	"os"
	"path/filepath"
	"strings"

	"golang.org/x/sys/windows/registry"
)

// registerURIScheme writes (or updates) the registry keys so
// `vidsync://...` URLs open this binary. Best-effort: failure logs
// but doesn't abort the launch — the user just won't be able to use
// the system-browser sign-in flow.
func registerURIScheme() {
	exePath, err := os.Executable()
	if err != nil {
		log.Printf("uri scheme: os.Executable failed: %v — skipping registration", err)
		return
	}
	// Resolve symlinks / canonical-case path so the registry value
	// matches what Windows hands back for "%1" expansion.
	exePath = strings.TrimSpace(exePath)
	if exePath == "" {
		return
	}
	// Wails runs our binary during `wails build` via wailsbindings.exe
	// to extract bound-method signatures for the JS runtime. That
	// invocation executes main(), which calls us — and if we just
	// blindly wrote os.Executable() to the registry, the protocol
	// handler would end up pointing at a temp file that gets deleted
	// right after the build finishes. Skip registration for any
	// non-vidsync executable name; the real user-facing launch will
	// overwrite the value correctly.
	base := strings.ToLower(filepath.Base(exePath))
	if base != "vidsync.exe" && base != "vidsync-dev.exe" {
		log.Printf("uri scheme: not registering for %q (only vidsync.exe is the desktop binary)", base)
		return
	}

	// Path quoting: registry stores a single string but shellexec
	// will split on whitespace unless the exe path is double-quoted.
	// We always wrap, even when the path has no spaces, to match the
	// convention used by Microsoft's own protocol handlers.
	cmd := `"` + exePath + `" "%1"`

	root := registry.CURRENT_USER

	if err := writeKey(root, `Software\Classes\`+uriScheme, "", "URL:Vidsync Protocol"); err != nil {
		log.Printf("uri scheme: write root key: %v", err)
		return
	}
	if err := writeKey(root, `Software\Classes\`+uriScheme, "URL Protocol", ""); err != nil {
		log.Printf("uri scheme: write URL Protocol marker: %v", err)
		return
	}
	if err := writeKey(root, `Software\Classes\`+uriScheme+`\shell\open\command`, "", cmd); err != nil {
		log.Printf("uri scheme: write command: %v", err)
		return
	}
	log.Printf("uri scheme: registered %s:// → %s", uriScheme, cmd)
}

// writeKey upserts a single (Default or named) string value under
// HKCU. Creates the key path if it doesn't exist.
func writeKey(root registry.Key, path, valueName, valueData string) error {
	k, _, err := registry.CreateKey(root, path, registry.SET_VALUE)
	if err != nil {
		return err
	}
	defer k.Close()
	return k.SetStringValue(valueName, valueData)
}

