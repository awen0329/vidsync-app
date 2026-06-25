// singleinstance.go prevents a second vidsync.exe from spawning a
// second sync daemon supervisor (and a second tray icon, second
// WebView, etc.) when the user double-clicks while it's already
// running.
//
// Implementation: create a named Windows mutex in the Local\
// namespace (per-session). If the mutex already exists, another
// vidsync owns it and this process exits silently — the user can
// click the existing tray icon to bring the window back.
//
// A more ambitious version would also signal the running instance
// to raise its window via IPC (named pipe / DDE). Worth doing if
// users start complaining that "nothing happens" on a second click;
// the tray-icon path covers the same need with fewer moving parts.

//go:build windows

package main

import (
	"errors"
	"log"

	"golang.org/x/sys/windows"
)

const singleInstanceMutexName = `Local\Vidsync-SingleInstance`

// claimSingleInstance returns true if this process is the first
// vidsync in the current user session. Returns false if another
// instance already owns the named mutex; in that case the caller
// should exit immediately.
//
// The returned handle is intentionally leaked for the lifetime of
// the process — releasing it would let another instance start.
// The OS reaps it on process exit.
func claimSingleInstance() bool {
	name, err := windows.UTF16PtrFromString(singleInstanceMutexName)
	if err != nil {
		log.Printf("singleinstance: name encode failed: %v — skipping check", err)
		return true
	}
	// initialOwner=false: we don't need to own the mutex, just
	// detect whether it exists. The mutex object lives as long as
	// any handle to it is open.
	handle, err := windows.CreateMutex(nil, false, name)
	if errors.Is(err, windows.ERROR_ALREADY_EXISTS) {
		if handle != 0 {
			windows.CloseHandle(handle)
		}
		return false
	}
	if err != nil {
		// CreateMutex failed for some other reason (e.g. permissions).
		// Don't block startup over a diagnostic feature.
		log.Printf("singleinstance: CreateMutex failed: %v — skipping check", err)
		return true
	}
	return true
}
