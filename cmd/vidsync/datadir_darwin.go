// datadir_darwin.go resolves the per-user app-data root on macOS.
// We use ~/Library/Application Support (os.UserConfigDir) rather
// than ~/Library/Caches because the daemon's config.xml + device
// cert are not regenerable — Caches can be purged by the OS or by
// users running CleanMyMac / similar.

//go:build darwin

package main

import "os"

func vidsyncDataRoot() (string, error) { return os.UserConfigDir() }
