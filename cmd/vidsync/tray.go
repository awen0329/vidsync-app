// tray.go provides the Windows notification-area icon and menu.
// Without it, closing the window would either kill the daemon (bad UX
// for a sync app) or leave a hidden process the user can't reopen.
//
// Wails v2 doesn't ship a built-in tray, so we run energye/systray on
// its own goroutine; the systray init pins itself to its OS thread,
// independent of the Wails message loop on main. Menu callbacks
// reach back into Wails via runtime.* using the ctx the App caches
// during OnStartup.
//
// macOS: the equivalent menu-bar item is provided by tray_darwin.go
// as a no-op stub. energye/systray's Cocoa nativeLoop fights Wails
// for [NSApp run] on the main thread and SIGTRAPs at launch, and the
// natural macOS UX puts the app icon in the Dock anyway — there's no
// X-to-tray idiom to preserve here. Native NSStatusItem support is
// a polish task for later.

//go:build windows

package main

import (
	"log"

	"github.com/energye/systray"
)

// systrayQuit tears the tray icon down. Called by main once
// wails.Run returns, so a closed app doesn't leave a ghost icon in
// the notification area.
func systrayQuit() { systray.Quit() }

// startTray launches the tray on a goroutine and returns immediately.
// Callbacks captured here close over app so they can resolve the
// Wails ctx at click time (it isn't available until OnStartup).
func startTray(app *App) {
	go systray.Run(func() {
		systray.SetIcon(trayIconBytes)
		systray.SetTitle("Vidsync")
		systray.SetTooltip("Vidsync")

		// Left-click on the icon itself toggles visibility — matches
		// what users expect from Slack/Discord/OneDrive-style tray
		// apps. Right-click still drops the menu (default behavior
		// is preserved by not calling SetOnRClick).
		systray.SetOnClick(func(_ systray.IMenu) {
			app.ToggleWindow()
		})

		mOpen := systray.AddMenuItem("Open Vidsync", "Show the main window")
		mAutostart := systray.AddMenuItemCheckbox(
			"Start at login",
			"Launch Vidsync automatically when you sign in",
			autostartEnabled(),
		)
		systray.AddSeparator()
		mQuit := systray.AddMenuItem("Quit", "Stop syncing and exit")

		mOpen.Click(func() {
			app.ShowWindow()
		})
		mAutostart.Click(func() {
			// Toggle based on the *current* registry state rather
			// than the menu's last-known checkmark; otherwise a
			// manual change (regedit, another tool) could leave the
			// two out of sync.
			if autostartEnabled() {
				if err := autostartDisable(); err != nil {
					log.Printf("autostart: disable failed: %v", err)
					return
				}
				mAutostart.Uncheck()
			} else {
				if err := autostartEnable(); err != nil {
					log.Printf("autostart: enable failed: %v", err)
					return
				}
				mAutostart.Check()
			}
		})
		mQuit.Click(func() {
			// Route through App.RequestQuit so OnBeforeClose knows
			// this is a real exit, not the X-button hide-to-tray.
			app.RequestQuit()
		})
	}, func() {})
}
