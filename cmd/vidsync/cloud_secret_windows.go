// cloud_secret_windows.go stores arbitrary named secrets (e.g. the
// Dropbox OAuth token) in the per-user Vidsync state directory, wrapped
// with DPAPI — the same machine-bound, per-user encryption used for the
// auth token (see auth_bridge_windows.go).

//go:build windows

package main

import (
	"encoding/hex"
	"os"
	"path/filepath"
	"strings"
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
	cipher, err := dpapiProtect(data)
	if err != nil {
		return err
	}
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, []byte(hex.EncodeToString(cipher)), 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}

func loadSecret(name string) ([]byte, error) {
	path, err := secretPath(name)
	if err != nil {
		return nil, err
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	cipher, err := hex.DecodeString(strings.TrimSpace(string(raw)))
	if err != nil {
		return nil, err
	}
	return dpapiUnprotect(cipher)
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
