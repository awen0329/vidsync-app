// Command vidsync is the desktop application wrapper around the
// Vidsync React UI and the local sync daemon. It bundles both:
// the binary supervises a sync daemon process and displays the
// React UI in a WebView2 window via Wails.
//
// Lifecycle:
//   1. main spins up the App, which during OnStartup discovers (or spawns)
//      the local daemon and caches its REST URL + API key.
//   2. The React frontend, served from the embedded asset filesystem,
//      calls App.GetDaemonURL / GetAPIKey at boot to configure its REST
//      client to talk directly to the daemon on loopback.
//   3. On OnShutdown the App requests a clean daemon shutdown via the
//      daemon's own /rest/system/shutdown endpoint.
//
// Build: see cmd/vidsync/README.md. `wails dev` for live reload,
// `wails build` for a release .exe.
package main

import (
	"embed"
	"log"
	"os"
	"path/filepath"
	rt "runtime"

	"github.com/wailsapp/wails/v2"
	"github.com/wailsapp/wails/v2/pkg/logger"
	"github.com/wailsapp/wails/v2/pkg/options"
	"github.com/wailsapp/wails/v2/pkg/options/assetserver"
	"github.com/wailsapp/wails/v2/pkg/options/windows"
)

// runtimeStack captures the current Go stack trace for the panic
// handler in main(). Sized large enough to cover normal recursion
// while staying out of the way of the actual stack.
func runtimeStack() string {
	buf := make([]byte, 16384)
	n := rt.Stack(buf, true)
	return string(buf[:n])
}

// syncWriter forces an fsync after every log write. The default
// os.File path leaves bytes in the OS page cache, which is fine for
// normal exits but loses the tail of the log on os.Exit / crash —
// exactly the cases we most want to read.
type syncWriter struct{ f *os.File }

func (s *syncWriter) Write(p []byte) (int, error) {
	n, err := s.f.Write(p)
	_ = s.f.Sync()
	return n, err
}

// wailsLogger implements the wails logger.Logger interface but routes
// every line through stdlib log (which we've redirected to our
// fsync-on-each-write syncWriter). Wails' own FileLogger does an
// open-write-close per line, but Close doesn't fsync — so when Wails
// detects a WebView2 process crash and calls os.Exit(-1), its
// `WebView2 process failed with kind N` line never makes it from the
// OS page cache to disk. Routing through our syncWriter fixes that.
type wailsLogger struct{}

func (wailsLogger) Print(m string)   { log.Print("wails: ", m) }
func (wailsLogger) Trace(m string)   { log.Print("wails TRACE: ", m) }
func (wailsLogger) Debug(m string)   { log.Print("wails DEBUG: ", m) }
func (wailsLogger) Info(m string)    { log.Print("wails INFO: ", m) }
func (wailsLogger) Warning(m string) { log.Print("wails WARN: ", m) }
func (wailsLogger) Error(m string)   { log.Print("wails ERROR: ", m) }
func (wailsLogger) Fatal(m string)   { log.Print("wails FATAL: ", m); os.Exit(1) }

// assets is the React build output. The Wails build step copies
// frontend/dist (vite output) into cmd/vidsync/frontend-dist before
// linking, since go:embed can't reach paths outside the package
// directory. frontend-dist is gitignored.
//
//go:embed all:frontend-dist
var assets embed.FS

func main() {
	// File logger so users (and we) can see what happened on a silent
	// failure — Wails apps are linked windowsgui so stdout is dropped.
	logPath := filepath.Join(os.TempDir(), "vidsync.log")

	// Catch any Go-side panic so the user sees a stack trace in
	// vidsync.log instead of just "the app closed". Without this the
	// runtime prints to stderr (a discarded handle under windowsgui)
	// and the OS process exits silently.
	defer func() {
		if r := recover(); r != nil {
			log.Printf("PANIC: %v\n%s", r, runtimeStack())
			panic(r) // re-raise so the OS still reports a failure exit
		}
	}()

	// Redirect stdlib log to the same file so daemon.go's log.Printf
	// calls land alongside Wails' own messages. Open append so we can
	// see startup attempts from multiple runs.
	//
	// Wrap the file in a writer that fsyncs after every log line. When
	// Wails detects a WebView2 browser-process crash it calls os.Exit(-1)
	// immediately, and any buffered log lines never make it to disk —
	// without the sync we end up staring at a log that ends at "starting"
	// no matter how the run actually ended.
	if f, err := os.OpenFile(logPath, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0644); err == nil {
		log.SetOutput(&syncWriter{f: f})
		log.SetFlags(log.LstdFlags | log.Lmicroseconds)
		log.Printf("--- vidsync starting (log: %s) ---", logPath)
	}

	// Was this process started by clicking a `vidsync://auth-callback
	// #token=...` link in the system browser? If so we want to hand
	// the URL to the already-running vidsync (which owns the WebView
	// and the credential storage), not spin up our own.
	startupURI := argURI()

	// Bail out fast if another vidsync is already running in this
	// user session. Prevents two supervisors fighting over the same
	// daemon and two tray icons. The existing instance's tray icon
	// is how the user gets the window back.
	if !claimSingleInstance() {
		if startupURI != "" {
			// Don't log the URI itself — fragments can carry secrets.
			log.Printf("another vidsync already running; forwarding inbound auth URI")
			forwardURIToRunningInstance(startupURI)
		} else {
			// Plain re-launch (icon double-click, Start menu, autostart):
			// don't just vanish — tell the running instance to surface its
			// window. It may have been hidden to the tray via the X button.
			log.Printf("another vidsync already running; signalling it to show its window")
			signalShowToRunningInstance()
		}
		return
	}

	// Register vidsync:// in the user's HKCU classes on every launch.
	// Idempotent — overwriting with the same value is a no-op.
	registerURIScheme()

	app := NewApp()
	// Stash the startup URI so OnStartup can deliver it once the
	// WebView is up. Either nil (normal launch) or the inbound URL
	// (the user just clicked the bridge link in the browser).
	app.pendingStartupURI = startupURI

	// Start the named-pipe listener that receives forwarded URIs from
	// secondary vidsync.exe launches (the click-the-link path above).
	startAuthBridgePipeListener(app)

	// Tray runs on its own goroutine and stays up for the whole
	// program lifetime. It's started before wails.Run so the icon
	// appears as soon as the user launches, and so its menu can
	// reach back into Wails via app.Context() once OnStartup fires.
	startTray(app)

	// Restore last saved window size; falls back to sane defaults
	// when there's nothing on disk yet (first run). Position is
	// applied later in App.OnStartup via runtime.WindowSetPosition
	// since Wails options.App doesn't take X/Y.
	savedSize := loadWindowState()
	width := savedSize.Width
	if width < minSaneWidth {
		width = defaultWidth
	}
	height := savedSize.Height
	if height < minSaneHeight {
		height = defaultHeight
	}

	log.Printf("wails.Run: starting (width=%d height=%d)", width, height)
	opts := &options.App{
		Title:     "Vidsync",
		Width:     width,
		Height:    height,
		MinWidth:  minSaneWidth,
		MinHeight: minSaneHeight,
		// Enable native drag-and-drop so users can drop a folder from
		// Explorer onto the window to start a project. The handler is
		// wired up in App.OnStartup; here we just opt into the feature.
		DragAndDrop: &options.DragAndDrop{
			EnableFileDrop: true,
		},
		AssetServer: &assetserver.Options{
			Assets:     assets,
			Middleware: restProxyMiddleware(app),
		},
		// WebView default-background is white so Stripe's hosted
		// Checkout doesn't expose a black void on the left of its
		// 2-column subscription layout (Stripe leaves the summary
		// column transparent, which falls through to whatever the
		// WebView paints behind it). The cold-start "white flash"
		// concern is handled in frontend/index.html, which sets the
		// dark app background via an inline <style> before any JS or
		// Tailwind has loaded — so the React app still looks dark
		// from the first paint while Stripe's page now renders on a
		// neutral background.
		BackgroundColour: options.NewRGBA(255, 255, 255, 255),
		Logger:           wailsLogger{},
		LogLevel:         logger.DEBUG,
		OnStartup:        app.OnStartup,
		OnBeforeClose:    app.OnBeforeClose,
		OnShutdown:       app.OnShutdown,
		// On Server 2019 (no Desktop Experience pack, headless GPU) the
		// WebView2 GPU process is the first thing to fall over under
		// decoder pressure — when it dies it takes the browser master
		// down with it, and Wails reacts by calling os.Exit(-1), so the
		// whole vidsync.exe disappears. Forcing software rendering
		// trades a little smoothness for a renderer that survives heavy
		// video-thumbnail decoding. (See cmd/vidsync/proxy.go for the
		// REST forwarding the WebView2 leans on.)
		Windows: &windows.Options{
			WebviewGpuIsDisabled: true,
		},
		Bind: []interface{}{
			app,
		},
	}
	// Per-OS hooks (URL scheme on macOS, etc.) live in main_<goos>.go.
	applyPlatformOptions(opts, app)
	err := wails.Run(opts)
	if err != nil {
		log.Fatalf("vidsync: %v", err)
	}
	// wails.Run returns only on a clean quit (tray → RequestQuit →
	// runtime.Quit). A WebView2 process crash takes the host out via
	// os.Exit(-1) inside the Wails internals, so reaching this line
	// means the user really did pick Quit.
	log.Printf("wails.Run: returned cleanly")

	// Clean up the tray after wails.Run returns (i.e. user picked
	// Quit). Without this the tray icon would linger as a ghost
	// until the user mouses over it.
	systrayQuit()
}
