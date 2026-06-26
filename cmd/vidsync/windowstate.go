// windowstate.go persists the main window's size and position to a
// small JSON file in the Vidsync config dir, so reopening the app
// doesn't dump the user back to the default 1280x800 centered every
// time.
//
// Save points:
//   - on hide-to-tray (X button) — captures the layout the user
//     last interacted with, even if they never explicitly quit.
//   - on shutdown — final state before exit.
//
// Restore point: OnStartup applies the saved position (size is
// already set via Wails options at boot). Bogus / off-screen values
// are clamped by Windows when SetPosition runs.

package main

import (
	"encoding/json"
	"log"
	"os"
	"path/filepath"

	"github.com/wailsapp/wails/v2/pkg/runtime"
)

type windowState struct {
	X      int `json:"x"`
	Y      int `json:"y"`
	Width  int `json:"width"`
	Height int `json:"height"`
}

const (
	defaultWidth  = 1280
	defaultHeight = 800
	// Geometry below these is treated as bogus (a too-small or minimized
	// window) and neither saved nor restored.
	minSaneWidth       = 480
	minSaneHeight      = 360
	minimizedThreshold = -30000 // Windows parks minimized windows at -32000
)

// loadWindowState reads the persisted window geometry. Returns
// zero-value windowState if nothing is saved (caller decides what
// defaults to apply).
func loadWindowState() windowState {
	path, err := windowStatePath()
	if err != nil {
		return windowState{}
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return windowState{} // first run / missing file is normal
	}
	var s windowState
	if err := json.Unmarshal(data, &s); err != nil {
		return windowState{}
	}
	return s
}

// saveWindowState writes the current window geometry. Best-effort —
// logs and swallows errors, since failing to persist layout isn't
// worth interrupting shutdown over.
func saveWindowState(s windowState) {
	path, err := windowStatePath()
	if err != nil {
		log.Printf("windowstate: path: %v", err)
		return
	}
	data, err := json.MarshalIndent(s, "", "  ")
	if err != nil {
		log.Printf("windowstate: marshal: %v", err)
		return
	}
	if err := os.WriteFile(path, data, 0o644); err != nil {
		log.Printf("windowstate: write: %v", err)
	}
}

// captureCurrentWindow reads the live window geometry through the
// Wails runtime and persists it. Called from OnBeforeClose (covers
// both X-button hide and tray Quit) while the window is still mapped.
func (a *App) captureCurrentWindow() {
	a.mu.RLock()
	ctx := a.ctx
	a.mu.RUnlock()
	if ctx == nil {
		return
	}
	w, h := runtime.WindowGetSize(ctx)
	x, y := runtime.WindowGetPosition(ctx)
	// Skip bogus geometry: a hidden/not-yet-mapped window reports zero,
	// and a minimized window reports Windows' off-screen "-32000" position
	// with a tiny size. Persisting either would reopen the app invisible
	// (the bug this guards against).
	if w < minSaneWidth || h < minSaneHeight || x <= minimizedThreshold || y <= minimizedThreshold {
		log.Printf("windowstate: skip capture, bogus geometry (x=%d y=%d w=%d h=%d)", x, y, w, h)
		return
	}
	log.Printf("windowstate: save x=%d y=%d w=%d h=%d", x, y, w, h)
	saveWindowState(windowState{X: x, Y: y, Width: w, Height: h})
}

// applyWindowState moves the window to the saved position, if any.
// Size is handled by Wails options.App at boot; only position
// requires a runtime call. No-op if there's no saved state or the
// values look invalid.
func (a *App) applyWindowState() {
	a.mu.RLock()
	ctx := a.ctx
	a.mu.RUnlock()
	if ctx == nil {
		return
	}
	s := loadWindowState()
	if s.Width < minSaneWidth || s.Height < minSaneHeight {
		return // nothing valid to apply
	}
	// Don't restore an off-screen (minimized) position — that's what left
	// the window invisible. Let Wails center it instead.
	if s.X <= minimizedThreshold || s.Y <= minimizedThreshold {
		return
	}
	runtime.WindowSetPosition(ctx, s.X, s.Y)
}

func windowStatePath() (string, error) {
	dir, err := vidsyncConfigDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(dir, "window.json"), nil
}
