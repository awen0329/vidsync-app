// notify_darwin.go: macOS notifications via osascript / `display
// notification`. The official path on modern macOS is
// UNUserNotificationCenter (Security.framework + an app bundle with
// the right entitlements). osascript is the no-bundle-required
// fallback and is good enough for the initial port — it spawns an
// AppleScript helper, which is slower than the Windows toast path
// but the gap (200ms vs 500ms) is invisible for sync-complete pings.

//go:build darwin

package main

import (
	"log"
	"os/exec"
	"strings"
)

// ShowNotification posts a macOS Notification Center alert. Bound
// into JS as window.go.main.App.ShowNotification(title, body). Best-
// effort: errors are logged but never propagated to the caller.
func (a *App) ShowNotification(title, body string) {
	// AppleScript needs double-quoted strings; escape any embedded
	// double quotes and backslashes so a title with quotes doesn't
	// break the script.
	script := `display notification "` + escapeAppleScript(body) +
		`" with title "` + escapeAppleScript(title) + `"`
	if err := exec.Command("osascript", "-e", script).Run(); err != nil {
		log.Printf("notify: %v", err)
	}
}

func escapeAppleScript(s string) string {
	s = strings.ReplaceAll(s, `\`, `\\`)
	s = strings.ReplaceAll(s, `"`, `\"`)
	return s
}
