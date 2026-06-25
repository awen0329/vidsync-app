// app.go defines the App type whose exported methods are bound into
// the JS runtime by Wails. The React frontend accesses them via
// `window.go.main.App.<MethodName>` — see frontend/src/api/client.ts
// for the boot-time call into GetDaemonURL / GetAPIKey.

package main

import (
	"context"
	"errors"
	"fmt"
	"log"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	rt "runtime"
	"strings"
	"sync"

	"github.com/wailsapp/wails/v2/pkg/runtime"
)

// sanitizeDefaultDir prepares a JS-supplied path for use as the
// default location of the OS folder picker. Windows' IFileDialog
// silently refuses to show the dialog when DefaultDirectory points
// at a missing path, so we expand `~` to the real home dir and clear
// the value entirely if the result doesn't exist on disk.
func sanitizeDefaultDir(p string) string {
	p = strings.TrimSpace(p)
	if p == "" {
		return ""
	}
	if p == "~" || strings.HasPrefix(p, "~/") || strings.HasPrefix(p, `~\`) {
		home, err := os.UserHomeDir()
		if err != nil || home == "" {
			return ""
		}
		p = filepath.Join(home, p[1:])
	}
	// Walk up to the nearest directory that does exist — that's what
	// the user is most likely looking for when their typed seed path
	// (e.g. ~/Sync/foo, not yet created) doesn't resolve.
	for p != "" {
		info, err := os.Stat(p)
		if err == nil && info.IsDir() {
			return p
		}
		parent := filepath.Dir(p)
		if parent == p {
			return ""
		}
		p = parent
	}
	return ""
}

// App is the Wails-bound singleton. Its lifecycle hooks run on the
// main goroutine; the bound methods can be invoked concurrently from
// multiple JS callers, so the daemon info is protected by a mutex.
type App struct {
	ctx context.Context

	mu             sync.RWMutex
	daemon         daemonInfo    // populated by OnStartup, read by GetDaemonURL/GetAPIKey
	daemonH        *daemonHandle // in-process daemon, stopped in OnShutdown
	daemonStopping bool          // set before an intentional daemon stop so the watcher stays quiet
	quitting       bool          // set by RequestQuit so OnBeforeClose lets real quits through
	windowHidden   bool          // tracks WindowShow/WindowHide so the tray icon can toggle

	// media is a streaming HTTP proxy for /rest/folder/file. Lives
	// outside the Wails AssetServer because the AssetServer buffers
	// the entire response body before handing it to WebView2, which
	// OOMs on multi-GB video files. See cmd/vidsync/mediaserver.go.
	media *mediaServer

	// backup runs the owner-side Dropbox backup loop. Started in
	// OnStartup once the daemon is up, stopped in OnShutdown. See
	// cmd/vidsync/backup.go.
	backup *backupManager

	// pendingStartupURI is the vidsync:// link this process was
	// launched with (when the user clicked the browser bridge link
	// and the OS started a fresh vidsync.exe rather than forwarding
	// to a running instance). main.go assigns this before wails.Run;
	// OnStartup applies it once the WebView is mounted.
	pendingStartupURI string
}

// NewApp returns an App ready to be passed to wails.Run.
func NewApp() *App {
	a := &App{}
	a.media = newMediaServer(a)
	a.backup = newBackupManager(a)
	return a
}

// OnStartup is called by Wails once the WebView2 window is up. It
// starts (or attaches to) the local sync daemon and caches the
// REST endpoint info for the bound getters.
func (a *App) OnStartup(ctx context.Context) {
	a.mu.Lock()
	a.ctx = ctx
	a.mu.Unlock()

	// Restore last window position. Size was already set via Wails
	// options at boot using loadWindowState; here we just nudge the
	// position since v2's options struct doesn't take an X/Y.
	a.applyWindowState()

	// Drag-and-drop: when the user drops one or more items on the
	// window, the first directory in the batch becomes the seed for
	// "Create project". Frontend listens for "folder:dropped" via
	// the Wails runtime EventsOn helper and opens NewProjectModal
	// with the path pre-filled. We deliberately ignore files (only
	// dirs become Vidsync projects) and additional items in the same
	// drop (the modal only takes one path).
	runtime.OnFileDrop(ctx, func(_, _ int, paths []string) {
		for _, p := range paths {
			if info, err := os.Stat(p); err == nil && info.IsDir() {
				runtime.EventsEmit(ctx, "folder:dropped", p)
				return
			}
		}
	})

	info, handle, err := a.startDaemonSafe(ctx)
	if err != nil {
		// Don't kill the window — leave daemon info blank and let the
		// frontend's OfflineBanner show. A bring-up panic is converted
		// to an error here (startDaemonSafe recovers) so a bad daemon
		// start surfaces as "offline" instead of a vanished window.
		log.Printf("startup: in-process daemon failed to start: %v", err)
		runtime.EventsEmit(ctx, "daemon:failed", err.Error())
		return
	}
	a.mu.Lock()
	a.daemon = info
	a.daemonH = handle
	a.mu.Unlock()

	// Daemon is up — start the Dropbox backup loop. It reads the local
	// index (daemonH.sdb) and uploads changed materials for any project
	// the owner has enabled backup on.
	a.backup.start()

	// Watch for the daemon stopping on its own. The daemon's internal
	// suture supervisor already restarts individual services that
	// panic, so this only fires if the whole app supervisor exits.
	// First watcher is allowed one auto-restart; if the restarted
	// daemon dies too, the next watcher surfaces a fatal event.
	go a.watchDaemon(ctx, handle, true)

	// Stand up the media streaming proxy now that we have a daemon
	// URL. Failures are non-fatal — the frontend falls back to the
	// AssetServer /rest path if GetMediaURL returns "".
	if err := a.media.start(); err != nil {
		log.Printf("media server: failed to start: %v", err)
	} else {
		log.Printf("media server: listening at %s", a.media.URL())
	}

	// If main captured a vidsync:// URL on argv, apply it now —
	// the WebView is up and the React app's auth listener is
	// guaranteed to be mounted. Empty string is a no-op.
	if uri := a.pendingStartupURI; uri != "" {
		a.pendingStartupURI = ""
		go a.deliverStartupURI(uri)
	}
}

// OnBeforeClose runs both when the user clicks the window's X button
// and when something programmatically calls runtime.Quit. Wails
// doesn't distinguish the two via this callback.
//
// On Windows we route around that by using the quitting flag (set by
// RequestQuit from the tray menu) to tell them apart:
//   - X button → quitting is false → hide window, cancel close (true)
//   - tray Quit → RequestQuit set quitting=true → allow real exit (false)
// That keeps the daemon syncing when the user "closes" the window,
// with the tray icon as the way back.
//
// On macOS there is no tray (see tray_darwin.go), so intercepting a
// close into a hide leaves the user no way back AND traps the
// Dock-Quit / ⌘Q / "Vidsync → Quit" paths in the same hide branch
// (Wails fires OnBeforeClose for all of them). We let every close
// through; standard Mac apps quit on window-close anyway when no
// other windows or menu state hold them open.
func (a *App) OnBeforeClose(ctx context.Context) bool {
	// Snapshot the geometry while the window is still mapped —
	// OnShutdown runs after Wails has begun tearing the window
	// down, by which point WindowGetSize returns zeros and we'd
	// drop the save. Doing it here covers both the X-button hide
	// and the tray-Quit paths.
	a.captureCurrentWindow()

	if rt.GOOS == "darwin" {
		return false // always permit close on macOS
	}

	a.mu.RLock()
	quitting := a.quitting
	a.mu.RUnlock()
	if quitting {
		return false // permit the actual quit
	}
	a.HideWindow()
	return true
}

// ShowWindow reveals and unminimises the main window, and clears the
// hidden flag the tray toggle reads. Safe to call before OnStartup
// (no-op until ctx is captured).
func (a *App) ShowWindow() {
	a.mu.Lock()
	ctx := a.ctx
	a.windowHidden = false
	a.mu.Unlock()
	if ctx == nil {
		return
	}
	runtime.WindowShow(ctx)
	runtime.WindowUnminimise(ctx)
}

// HideWindow hides the main window without quitting the app — the
// daemon keeps syncing, the tray icon remains. Sets the hidden flag
// so a subsequent tray-icon click brings the window back. Saves the
// current geometry so the next show restores the same layout even if
// the user later quits without uncovering the window.
func (a *App) HideWindow() {
	a.captureCurrentWindow()
	a.mu.Lock()
	ctx := a.ctx
	a.windowHidden = true
	a.mu.Unlock()
	if ctx == nil {
		return
	}
	runtime.WindowHide(ctx)
}

// ToggleWindow flips visible/hidden. Used by the tray icon's
// left-click handler so the icon doubles as a quick show/hide
// affordance without needing the right-click menu.
func (a *App) ToggleWindow() {
	a.mu.RLock()
	hidden := a.windowHidden
	a.mu.RUnlock()
	if hidden {
		a.ShowWindow()
	} else {
		a.HideWindow()
	}
}

// RequestQuit is invoked by the tray's Quit menu item. It marks the
// app as actually quitting (so OnBeforeClose doesn't intercept) and
// then asks Wails to begin shutdown, which triggers OnShutdown.
func (a *App) RequestQuit() {
	a.mu.Lock()
	a.quitting = true
	ctx := a.ctx
	a.mu.Unlock()
	if ctx != nil {
		runtime.Quit(ctx)
	}
}

// Context returns the Wails ctx once OnStartup has captured it, or
// nil if startup hasn't completed. Used by the tray goroutine to
// call into the Wails runtime safely.
func (a *App) Context() context.Context {
	a.mu.RLock()
	defer a.mu.RUnlock()
	return a.ctx
}

// GetMediaURL exposes the streaming media-proxy base URL to the
// frontend (see lib/fileURL.ts). Returns "" if the proxy hasn't
// started yet; callers should fall through to the AssetServer
// `/rest/folder/file` route in that case.
func (a *App) GetMediaURL() string {
	if a.media == nil {
		return ""
	}
	return a.media.URL()
}

// OnShutdown is called when the user picks Quit from the tray, which
// invokes runtime.Quit and triggers a real shutdown. The daemon now
// runs in-process, so a clean stop is just daemonHandle.stop() — stop
// the app supervisor, wait for it to drain, tear down the event/config
// services, and close the database. No child process to kill.
func (a *App) OnShutdown(_ context.Context) {
	// Stop the backup loop before the daemon goes away — it reads the
	// daemon's database.
	if a.backup != nil {
		a.backup.stop()
	}
	if a.media != nil {
		a.media.stop()
	}
	a.mu.Lock()
	handle := a.daemonH
	a.daemonStopping = true // tell watchDaemon this exit is intentional
	a.mu.Unlock()
	log.Printf("shutdown: starting; in-process daemon=%t", handle != nil)
	if handle == nil {
		log.Printf("shutdown: no daemon handle, nothing to stop")
		return
	}
	handle.stop()
	log.Printf("shutdown: in-process daemon stopped")
}

// startDaemonSafe runs ensureDaemon with a panic recovery so a failure
// deep in the daemon's bring-up (database open, config load, service
// construction) surfaces as an error the caller can show as "offline"
// instead of taking the whole window down with it.
func (a *App) startDaemonSafe(ctx context.Context) (info daemonInfo, handle *daemonHandle, err error) {
	defer func() {
		if r := recover(); r != nil {
			err = fmt.Errorf("daemon bring-up panicked: %v", r)
			handle = nil
		}
	}()
	return ensureDaemon(ctx)
}

// watchDaemon blocks until the in-process daemon stops, then decides
// what to do. handle.app.Wait() returns when the app's supervisor has
// fully stopped. If we asked for that (OnShutdown sets daemonStopping)
// it's a clean quit and we're done. Otherwise the daemon died on its
// own: if allowRestart, try exactly one in-process restart (the Wails
// proxies read the daemon endpoint fresh per request, so a new
// port+key is picked up transparently and the frontend's failed polls
// just retry); if the restart fails — or a second death follows — emit
// a fatal daemon:exited event so the user isn't left with a window
// that looks fine but isn't syncing.
func (a *App) watchDaemon(ctx context.Context, handle *daemonHandle, allowRestart bool) {
	if handle == nil || handle.app == nil {
		return
	}
	status := handle.app.Wait()
	a.mu.RLock()
	intentional := a.daemonStopping
	a.mu.RUnlock()
	if intentional {
		return
	}
	err := handle.app.Error()
	log.Printf("daemon: exited unexpectedly (status=%v err=%v) allowRestart=%t", status, err, allowRestart)

	if !allowRestart {
		runtime.EventsEmit(ctx, "daemon:exited", daemonFatalMsg(err))
		return
	}

	runtime.EventsEmit(ctx, "daemon:restarting", "")
	newInfo, newHandle, rerr := a.startDaemonSafe(ctx)
	if rerr != nil {
		log.Printf("daemon: auto-restart failed: %v", rerr)
		runtime.EventsEmit(ctx, "daemon:exited", daemonFatalMsg(err))
		return
	}
	a.mu.Lock()
	a.daemon = newInfo
	a.daemonH = newHandle
	a.mu.Unlock()
	log.Printf("daemon: auto-restarted, now at %s", newInfo.URL)
	runtime.EventsEmit(ctx, "daemon:recovered", "")
	// Re-arm without restart budget: a second unexpected death is fatal.
	go a.watchDaemon(ctx, newHandle, false)
}

// daemonFatalMsg builds the user-facing message for an unrecoverable
// daemon exit, preferring the daemon's own error when present.
func daemonFatalMsg(err error) string {
	if err != nil {
		return err.Error()
	}
	return "The sync engine stopped unexpectedly. Restart Vidsync to resume syncing."
}

// LogJS forwards JavaScript-side errors into vidsync.log. We use this
// rather than rely on devtools (F12) because the renderer process
// can crash before the user gets a chance to open the inspector; the
// log file survives the process exit and gives us a trail.
//
// level is one of "error" | "warn" | "info"; we prefix the log line
// so a grep for "JS error" surfaces only fatal stuff.
func (a *App) LogJS(level, message, stack string) {
	prefix := "JS " + level
	if stack != "" {
		log.Printf("%s: %s\n%s", prefix, message, stack)
		return
	}
	log.Printf("%s: %s", prefix, message)
}

// OpenExternal hands the URL off to the OS default browser. Used
// by the frontend for Stripe Checkout / Customer Portal so those
// flows don't navigate the embedded WebView2 (which would unmount
// the React app, losing in-memory state and the current view).
func (a *App) OpenExternal(url string) {
	a.mu.RLock()
	ctx := a.ctx
	a.mu.RUnlock()
	if ctx == nil || url == "" {
		return
	}
	runtime.BrowserOpenURL(ctx, url)
}

// OpenInExplorer launches the OS file manager at the given local
// path. Frontend uses it from the project hero so users can jump
// straight from a project to its folder on disk.
//
// Path tolerance: we expand `~` and walk up to the nearest existing
// directory before launching, matching what sanitizeDefaultDir does
// for the folder picker. That keeps the click sensible even when the
// stored folder path no longer points at a real directory (renamed
// or moved on disk) — explorer.exe would otherwise just refuse to
// open silently.
func (a *App) OpenInExplorer(path string) {
	path = sanitizeDefaultDir(path)
	if path == "" {
		return
	}
	// Per-OS file manager: explorer.exe on Windows, open(1) on macOS.
	// exec.Command quotes the path argument for us, so spaces don't
	// need manual escaping. We don't Wait on the child — both file
	// managers detach and outlive vidsync.
	var cmd *exec.Cmd
	switch rt.GOOS {
	case "windows":
		cmd = exec.Command("explorer.exe", path)
	case "darwin":
		cmd = exec.Command("open", path)
	default:
		cmd = exec.Command("xdg-open", path)
	}
	if err := cmd.Start(); err != nil {
		log.Printf("OpenInExplorer: %v", err)
		return
	}
	go func() { _ = cmd.Wait() }()
}

// daemonSnapshot returns the current daemon info atomically. Used
// by the REST reverse proxy (proxy.go) on every forwarded request.
func (a *App) daemonSnapshot() daemonInfo {
	a.mu.RLock()
	defer a.mu.RUnlock()
	return a.daemon
}

// dialDaemon connects to the in-process daemon's in-memory REST
// listener. It's wired into the Wails proxies' http.Transport as
// DialContext so REST traffic reaches the daemon without any socket;
// the network/address arguments are ignored. It reads the current
// daemon handle on every call, so an auto-restart (which swaps in a new
// listener) is picked up transparently with no proxy reconfiguration.
func (a *App) dialDaemon(ctx context.Context, _, _ string) (net.Conn, error) {
	a.mu.RLock()
	h := a.daemonH
	a.mu.RUnlock()
	if h == nil || h.ml == nil {
		return nil, errors.New("vidsync: daemon not ready")
	}
	return h.ml.DialContext(ctx, "", "")
}

// PickFolder opens the OS-native "choose folder" dialog and returns
// the absolute path the user picked. Empty string means the user
// cancelled or the dialog failed. Bound into JS by Wails — see
// frontend/src/lib/folderDialog.ts for the caller.
//
// defaultDir, when set, seeds the dialog at that location. We expand
// a leading `~` to the user's home directory and clear the value
// entirely if the path doesn't actually exist — Windows' IFileDialog
// silently refuses to show when DefaultDirectory points at a missing
// path (e.g. the seed `~/Sync/<folderID>` we hand to AcceptFolderModal
// before the folder has been created), which looks like a broken
// Browse button to the user.
func (a *App) PickFolder(title, defaultDir string) string {
	a.mu.RLock()
	ctx := a.ctx
	a.mu.RUnlock()
	if ctx == nil {
		return ""
	}
	defaultDir = sanitizeDefaultDir(defaultDir)
	dir, err := runtime.OpenDirectoryDialog(ctx, runtime.OpenDialogOptions{
		Title:            title,
		DefaultDirectory: defaultDir,
	})
	if err != nil {
		return ""
	}
	return dir
}
