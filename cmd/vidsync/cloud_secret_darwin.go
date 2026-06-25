// cloud_secret_darwin.go stores arbitrary named secrets (e.g. the Dropbox
// OAuth token) as plain 0600 files in the per-user Vidsync state dir — the
// same not-yet-encrypted approach the macOS auth token uses for the initial
// port (see auth_bridge_darwin.go). TODO: move to the macOS Keychain before
// broad release.

//go:build darwin

package main

import (
	"os"
	"path/filepath"
)

func secretPath(name string) (string, error) {
	dir, err := vidsyncConfigDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(dir, name), nil
}

func storeSecret(name string, data []byte) error {
	path, err := secretPath(name)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, data, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}

func loadSecret(name string) ([]byte, error) {
	path, err := secretPath(name)
	if err != nil {
		return nil, err
	}
	return os.ReadFile(path)
}

func deleteSecret(name string) error {
	path, err := secretPath(name)
	if err != nil {
		return err
	}
	if err := os.Remove(path); err != nil && !os.IsNotExist(err) {
		return err
	}
	return nil
}
