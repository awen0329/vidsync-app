// tray_icon_windows.go embeds the Windows tray icon. energye/systray
// on Windows requires .ico bytes (PNG silently fails to render).
// Wails' build pipeline already produces a multi-resolution
// build/windows/icon.ico from appicon.png, so we reuse it here.

//go:build windows

package main

import _ "embed"

//go:embed build/windows/icon.ico
var trayIconBytes []byte
