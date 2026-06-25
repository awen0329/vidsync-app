// main_windows.go: per-OS Wails options hook. Currently a no-op on
// Windows — the Wails-level URL handler isn't needed because main()
// already does the cross-instance URI forwarding via named pipe (see
// auth_bridge_windows.go).

//go:build windows

package main

import "github.com/wailsapp/wails/v2/pkg/options"

func applyPlatformOptions(_ *options.App, _ *App) {}
