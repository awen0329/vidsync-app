// autostart.go installs / removes a per-user "launch at login"
// registry entry pointing at the running vidsync.exe. Uses
// HKCU\Software\Microsoft\Windows\CurrentVersion\Run, which doesn't
// require admin elevation.
//
// We don't reuse internal/gui/autostart because that package's
// appName ("SyncthingGUI") would collide with a standalone
// sync-daemon GUI install. Vidsync owns its own entry name.

//go:build windows

package main

import (
	"errors"
	"os"

	"golang.org/x/sys/windows/registry"
)

const (
	autostartRunKey  = `Software\Microsoft\Windows\CurrentVersion\Run`
	autostartAppName = "Vidsync"
)

func autostartEnable() error {
	exe, err := os.Executable()
	if err != nil {
		return err
	}
	k, _, err := registry.CreateKey(registry.CURRENT_USER, autostartRunKey, registry.SET_VALUE)
	if err != nil {
		return err
	}
	defer k.Close()
	// Quote the path so spaces in C:\Program Files\... survive.
	return k.SetStringValue(autostartAppName, `"`+exe+`"`)
}

func autostartDisable() error {
	k, err := registry.OpenKey(registry.CURRENT_USER, autostartRunKey, registry.SET_VALUE)
	if errors.Is(err, registry.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	defer k.Close()
	if err := k.DeleteValue(autostartAppName); err != nil && !errors.Is(err, registry.ErrNotExist) {
		return err
	}
	return nil
}

func autostartEnabled() bool {
	k, err := registry.OpenKey(registry.CURRENT_USER, autostartRunKey, registry.QUERY_VALUE)
	if err != nil {
		return false
	}
	defer k.Close()
	_, _, err = k.GetStringValue(autostartAppName)
	return err == nil
}
