// daemon.go owns the Vidsync config directory and launches the
// sync daemon. The daemon runs *in-process* — see inprocess.go
// for the construction sequence; this file only handles the config
// dir (locating it, migrating a legacy standalone install into it,
// and sweeping up old files from before the syncthing→vidsync rename).
//
// Config dir: Vidsync uses its own per-app dir (%LOCALAPPDATA%\Vidsync
// on Windows) so it doesn't share state with a standalone sync-daemon
// install on the same machine. If the user previously ran the
// non-bundled vidsync (which used the default %LOCALAPPDATA%\Syncthing)
// we copy that config in on first launch so they don't lose their
// folders and device pairings.

package main

import (
	"context"
	"errors"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"strings"
)

// daemonInfo carries the REST endpoint the Wails proxies use to reach
// the in-process daemon. URL points at the random loopback port the
// daemon bound this session; APIKey is the per-session key.
type daemonInfo struct {
	URL    string
	APIKey string
}

// ensureDaemon resolves the Vidsync config directory (migrating a
// legacy install and clearing stale files), then starts the embedded
// sync daemon in-process. Returns the REST endpoint info and a
// handle the caller stores for shutdown.
func ensureDaemon(ctx context.Context) (daemonInfo, *daemonHandle, error) {
	confDir, err := vidsyncConfigDir()
	if err != nil {
		return daemonInfo{}, nil, fmt.Errorf("config dir: %w", err)
	}
	if err := maybeMigrateLegacyConfig(confDir); err != nil {
		// Migration failure is non-fatal — worst case, the user has
		// to re-add their folders. Log and continue.
		log.Printf("daemon: legacy config migration: %v", err)
	}
	// Sweep away the previous build's "syncthing.*" files so users
	// who upgrade no longer see the legacy daemon name in their
	// AppData\Vidsync dir. Best-effort — failure is harmless.
	cleanupLegacySyncthingFiles(confDir)
	log.Printf("daemon: using config dir %q", confDir)

	info, handle, err := startInProcessDaemon(ctx, confDir)
	if err != nil {
		return daemonInfo{}, nil, fmt.Errorf("start in-process daemon: %w", err)
	}
	log.Printf("daemon: in-process daemon ready at %s", info.URL)
	return info, handle, nil
}

// vidsyncConfigDir returns the per-user Vidsync state directory:
// %LOCALAPPDATA%\Vidsync on Windows, ~/Library/Application
// Support/Vidsync on macOS. The platform-specific root resolver
// lives in datadir_windows.go / datadir_darwin.go. Created if missing.
//
// We use a Vidsync-named dir so the daemon's state doesn't overlap
// with a standalone sync-daemon install — important for users who
// might run both at once.
func vidsyncConfigDir() (string, error) {
	root, err := vidsyncDataRoot()
	if err != nil {
		return "", err
	}
	dir := filepath.Join(root, "Vidsync")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return "", err
	}
	return dir, nil
}

// maybeMigrateLegacyConfig copies an existing sync-daemon config into
// the Vidsync config dir on first launch, so users coming from the
// older non-bundled vidsync (which used the default location) keep
// their folders, devices, and certs. No-op if the Vidsync dir
// already contains a config or if there's no legacy config to copy.
func maybeMigrateLegacyConfig(vidsyncDir string) error {
	if _, err := os.Stat(filepath.Join(vidsyncDir, "config.xml")); err == nil {
		return nil // already migrated, or fresh config the daemon wrote
	}
	root, err := vidsyncDataRoot()
	if err != nil {
		return err
	}
	legacy := filepath.Join(root, "Syncthing")
	if _, err := os.Stat(filepath.Join(legacy, "config.xml")); err != nil {
		return nil // no legacy config to migrate
	}
	log.Printf("daemon: migrating legacy config %s -> %s", legacy, vidsyncDir)
	return copyConfigTree(legacy, vidsyncDir)
}

// cleanupLegacySyncthingFiles removes leftover files from before the
// "syncthing → vidsync-daemon" rename in lib/locations + extract.go.
// Old log/lock files in confDir, plus any old extracted daemon
// binaries under confDir/bin, all match the previous naming. The
// names are unambiguous (only our embedded daemon ever produced
// them in this directory) so deletion is safe. Errors are swallowed —
// a sticky old file is cosmetic, not load-bearing.
func cleanupLegacySyncthingFiles(confDir string) {
	for _, name := range []string{"syncthing.log", "syncthing.lock"} {
		path := filepath.Join(confDir, name)
		if err := os.Remove(path); err != nil && !errors.Is(err, os.ErrNotExist) {
			log.Printf("daemon: legacy cleanup: %s: %v", name, err)
		}
	}
	// The old spawn-based build extracted the daemon into confDir/bin and
	// ran it as a child process. The in-process build extracts nothing, so
	// every binary in this dir is a relic. Two naming schemes appeared over
	// the build's life: "syncthing-<hash>.exe" before the syncthing→vidsync
	// rename and "vidsync-daemon-<hash>.exe" after it — sweep up both. (An
	// orphaned vidsync-daemon-<hash>.exe holding the DB lock and port 8384
	// is exactly what blocks a fresh in-process launch.)
	binDir := filepath.Join(confDir, "bin")
	entries, err := os.ReadDir(binDir)
	if err != nil {
		return // no bin dir yet; nothing to clean
	}
	for _, e := range entries {
		if e.IsDir() {
			continue
		}
		n := e.Name()
		if (strings.HasPrefix(n, "syncthing-") || strings.HasPrefix(n, "vidsync-daemon-")) &&
			(strings.HasSuffix(n, ".exe") || !strings.Contains(n, ".")) {
			_ = os.Remove(filepath.Join(binDir, n))
		}
	}
	// Drop the dir too once empty; the in-process build never recreates it.
	_ = os.Remove(binDir)
}

// copyConfigTree copies the daemon-relevant files from src to dst.
// We skip the index database (rebuilt from disk on first scan) and
// any rotated logs to keep the migration fast and the new dir tidy.
func copyConfigTree(src, dst string) error {
	keep := map[string]bool{
		"config.xml":      true,
		"cert.pem":        true,
		"key.pem":         true,
		"https-cert.pem":  true,
		"https-key.pem":   true,
	}
	entries, err := os.ReadDir(src)
	if err != nil {
		return err
	}
	for _, e := range entries {
		if e.IsDir() || !keep[e.Name()] {
			continue
		}
		data, err := os.ReadFile(filepath.Join(src, e.Name()))
		if err != nil {
			return fmt.Errorf("read %s: %w", e.Name(), err)
		}
		if err := os.WriteFile(filepath.Join(dst, e.Name()), data, 0o600); err != nil {
			return fmt.Errorf("write %s: %w", e.Name(), err)
		}
	}
	return nil
}
