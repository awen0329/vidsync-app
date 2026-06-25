// inprocess.go runs the sync daemon inside the vidsync.exe
// process instead of spawning it as a child. It mirrors the
// construction sequence cmd/syncthing's `serve` path uses
// (cert → event logger → config → database → syncthing.App), but
// keeps everything in-process so there's a single binary, a single
// process, and no daemon port that anything outside this process can
// reach:
//
//   - The REST/GUI API binds to a random loopback port chosen at
//     launch and pushed in via STGUIADDRESS, so the address never
//     lands in config.xml — nothing on disk reveals where the daemon
//     is listening this session.
//   - The API key is rotated to a fresh random value on every launch.
//
// Together with the Wails REST proxy (proxy.go) injecting that key
// in-process, the only thing that can drive the daemon is this running
// vidsync.exe.

package main

import (
	"context"
	"fmt"
	"time"

	"github.com/thejerf/suture/v4"

	"github.com/CrownLedger/vidsync/internal/db"
	"github.com/CrownLedger/vidsync/lib/api"
	"github.com/CrownLedger/vidsync/lib/config"
	"github.com/CrownLedger/vidsync/lib/events"
	"github.com/CrownLedger/vidsync/lib/locations"
	"github.com/CrownLedger/vidsync/lib/rand"
	"github.com/CrownLedger/vidsync/lib/svcutil"
	"github.com/CrownLedger/vidsync/lib/syncthing"
)

// Match cmd/syncthing's serve defaults so the embedded daemon behaves
// identically to a standalone one.
const (
	dbMaintenanceInterval     = 8 * time.Hour
	dbDeleteRetentionInterval = 10920 * time.Hour
)

// daemonHandle owns the live in-process daemon and its supporting
// services so OnShutdown can tear everything down in order. Replaces
// the old "REST shutdown + kill child PID" dance.
type daemonHandle struct {
	app      *syncthing.App
	sdb      db.DB
	ml       *memListener       // in-memory REST transport; proxies dial it
	evCancel context.CancelFunc // stops the early supervisor (event logger + config)
}

// stop shuts the daemon down cleanly: stop the app supervisor and wait
// for it to drain, close the in-memory listener, cancel the early
// services, then close the database. Safe to call on a nil handle
// (e.g. if bring-up failed).
func (h *daemonHandle) stop() {
	if h == nil {
		return
	}
	if h.app != nil {
		h.app.Stop(svcutil.ExitSuccess)
		h.app.Wait()
	}
	if h.ml != nil {
		h.ml.shutdown()
	}
	if h.evCancel != nil {
		h.evCancel()
	}
	if h.sdb != nil {
		_ = h.sdb.Close()
	}
}

// startInProcessDaemon constructs and starts the embedded sync
// daemon against the given config directory. On success it returns the
// REST endpoint info the Wails proxy needs plus a handle for shutdown.
// app.Start() returns once the API is ready, so the returned URL is
// immediately usable.
func startInProcessDaemon(ctx context.Context, confDir string) (daemonInfo, *daemonHandle, error) {
	// Point every on-disk location (config.xml, cert/key, database,
	// lock file) at the Vidsync dir, replacing the --config flag we
	// used to pass the child process.
	if err := locations.SetBaseDir(locations.ConfigBaseDir, confDir); err != nil {
		return daemonInfo{}, nil, fmt.Errorf("set config base dir: %w", err)
	}
	if err := locations.SetBaseDir(locations.DataBaseDir, confDir); err != nil {
		return daemonInfo{}, nil, fmt.Errorf("set data base dir: %w", err)
	}

	// Serve the REST API over an in-memory listener instead of a socket.
	// api.InjectedListener short-circuits the daemon's getListener so it
	// never calls net.Listen — there is no TCP/unix port at all, so a
	// browser (or any other process) has nothing to connect to. The
	// Wails proxies dial this same listener in-process. Set before
	// app.Start() so the API service picks it up on first Serve.
	ml := newMemListener()
	api.InjectedListener = ml

	cert, err := syncthing.LoadOrGenerateCertificate(
		locations.Get(locations.CertFile),
		locations.Get(locations.KeyFile),
	)
	if err != nil {
		return daemonInfo{}, nil, fmt.Errorf("load/generate certificate: %w", err)
	}

	// earlyService hosts the event logger and config service, just like
	// cmd/syncthing's serve path. It runs for the whole daemon lifetime;
	// evCancel (stored on the handle) tears it down at shutdown.
	evCtx, evCancel := context.WithCancel(context.Background())
	early := suture.New("vidsync-early", svcutil.SpecWithDebugLogger())
	early.ServeBackground(evCtx)

	evLogger := events.NewLogger()
	early.Add(evLogger)

	cfgWrapper, err := syncthing.LoadConfigAtStartup(
		locations.Get(locations.ConfigFile), cert, evLogger,
		false /* allowNewerConfig */, false /* skipPortProbing */)
	if err != nil {
		evCancel()
		return daemonInfo{}, nil, fmt.Errorf("load config: %w", err)
	}
	early.Add(cfgWrapper)

	// Configure the API for in-memory-only access:
	//
	//   * Enabled = true            — the React frontend needs the REST API.
	//   * APIKey  = random          — the Wails proxies inject it from
	//                                 daemonInfo; it satisfies the daemon's
	//                                 CSRF guard and never reaches the bundle.
	//   * InsecureSkipHostCheck     — the daemon's localhost host-header
	//                                 guard defends against DNS rebinding on
	//                                 a real socket. There is no socket here,
	//                                 so it's moot, and in-memory connections
	//                                 don't carry a real remote address for
	//                                 it to validate anyway.
	//   * StartBrowser = false      — never try to pop a browser at a GUI
	//                                 URL; there isn't one.
	//
	// We deliberately do NOT set a GUI user/password anymore: with no
	// socket there's no login surface to protect, and leaving auth
	// disabled keeps the request path simple (the API key alone clears
	// CSRF). Any user/password left in config.xml from an earlier build
	// is cleared here so the daemon doesn't sit behind a dead login.
	apiKey := rand.String(32)
	if _, err := cfgWrapper.Modify(func(cfg *config.Configuration) {
		cfg.GUI.Enabled = true
		cfg.GUI.APIKey = apiKey
		cfg.GUI.InsecureSkipHostCheck = true
		cfg.GUI.User = ""
		cfg.GUI.Password = ""
		cfg.Options.StartBrowser = false
	}); err != nil {
		evCancel()
		return daemonInfo{}, nil, fmt.Errorf("configure gui: %w", err)
	}

	if err := syncthing.TryMigrateDatabase(ctx, dbDeleteRetentionInterval); err != nil {
		evCancel()
		return daemonInfo{}, nil, fmt.Errorf("migrate database: %w", err)
	}
	sdb, err := syncthing.OpenDatabase(locations.Get(locations.Database), dbDeleteRetentionInterval)
	if err != nil {
		evCancel()
		return daemonInfo{}, nil, fmt.Errorf("open database: %w", err)
	}

	app, err := syncthing.New(cfgWrapper, sdb, evLogger, cert, syncthing.Options{
		DBMaintenanceInterval: dbMaintenanceInterval,
	})
	if err != nil {
		_ = sdb.Close()
		evCancel()
		return daemonInfo{}, nil, fmt.Errorf("construct daemon: %w", err)
	}
	if err := app.Start(); err != nil {
		_ = sdb.Close()
		evCancel()
		return daemonInfo{}, nil, fmt.Errorf("start daemon: %w", err)
	}

	// The host in this URL is cosmetic: the proxies' transport dials the
	// in-memory listener regardless of host, and the daemon accepts any
	// Host header (InsecureSkipHostCheck). It only needs to be a valid
	// http URL for the ReverseProxy director to rewrite onto requests.
	info := daemonInfo{URL: "http://vidsync-daemon", APIKey: apiKey}
	handle := &daemonHandle{app: app, sdb: sdb, ml: ml, evCancel: evCancel}
	return info, handle, nil
}
