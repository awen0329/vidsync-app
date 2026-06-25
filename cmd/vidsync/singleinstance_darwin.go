// singleinstance_darwin.go: macOS stub. Initial macOS port relies on
// LaunchServices' default behavior for .app bundles, which already
// routes second launches to the existing instance via NSApplication's
// applicationShouldHandleReopen. A flock-based check could be added
// later if we ship a non-bundled CLI variant.

//go:build darwin

package main

// claimSingleInstance is always true on macOS for now — see file
// header. Returning true means main proceeds with normal startup.
func claimSingleInstance() bool { return true }
