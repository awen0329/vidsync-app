// tray_darwin.go: macOS stub for the tray/menu-bar item.
//
// energye/systray's Cocoa nativeLoop conflicts with Wails on
// darwin — both want to drive [NSApp run] on the main thread, and
// the systray goroutine crashes with SIGTRAP at startup. We skip
// it entirely; the macOS app shows in the Dock instead, so users
// don't lose a way back to the window when they close it.
//
// startTray is a no-op, and systrayQuit is a no-op so main.go can
// keep calling it unconditionally after wails.Run returns. Native
// NSStatusItem support is a TODO.

//go:build darwin

package main

func startTray(_ *App)  {}
func systrayQuit()      {}
