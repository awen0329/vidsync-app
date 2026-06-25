// main_darwin.go wires the macOS-only Wails options. The big one is
// Mac.OnUrlOpen, which Wails fires when LaunchServices routes a
// `vidsync://auth-callback#token=…` URL to our .app. We forward into
// app.deliverAuthURI — the same funnel used by the Windows named-pipe
// forwarder — so the React app's auth listener fires the same way on
// both platforms.
//
// The URL scheme itself is declared in Info.plist via the
// `info.protocols` block in wails.json; that's what makes the OS
// route vidsync:// to us in the first place.

//go:build darwin

package main

import (
	"log"

	"github.com/wailsapp/wails/v2/pkg/options"
	"github.com/wailsapp/wails/v2/pkg/options/mac"
)

func applyPlatformOptions(opts *options.App, app *App) {
	opts.Mac = &mac.Options{
		OnUrlOpen: func(url string) {
			log.Printf("auth bridge: macOS OnUrlOpen received URL")
			app.deliverAuthURI(url)
		},
	}
	// Closing the red ("X") button should hide the window to the Dock,
	// not quit the app — matching the standard macOS app convention
	// (Finder, Mail, Slack, etc.) and Windows' tray-hide behavior.
	// Quit still works from the Dock right-click menu, ⌘Q, and the
	// app's menubar Quit item; those go through
	// applicationShouldTerminate → OnBeforeClose, which returns false
	// on darwin and lets the quit proceed.
	//
	// We deliberately do NOT set this on Windows (where HideWindowOnClose
	// unconditionally hides via the X handler and bypasses OnBeforeClose,
	// breaking the tray-Quit flag dance in app.go's OnBeforeClose).
	opts.HideWindowOnClose = true
}
