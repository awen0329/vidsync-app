// datadir_windows.go resolves the per-user app-data root on Windows.
// %LOCALAPPDATA% is the right location for non-roamed state like the
// daemon config + DPAPI-wrapped auth token; os.UserCacheDir maps to
// it on Windows.

//go:build windows

package main

import "os"

func vidsyncDataRoot() (string, error) { return os.UserCacheDir() }
