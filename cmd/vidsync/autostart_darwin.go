// autostart_darwin.go: macOS stub for the "launch at login" toggle.
//
// Proper macOS implementation: write a LaunchAgent plist to
// ~/Library/LaunchAgents/com.vidsync.app.plist and load it with
// `launchctl bootstrap gui/<uid> …`. Out of scope for the initial
// macOS port — the menu item simply behaves as if autostart is off.

//go:build darwin

package main

func autostartEnable() error  { return nil }
func autostartDisable() error { return nil }
func autostartEnabled() bool  { return false }
