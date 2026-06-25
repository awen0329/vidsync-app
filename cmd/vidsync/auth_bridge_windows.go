// auth_bridge_windows.go is the Windows half of the auth bridge:
//
//   1. Cross-instance URI forwarding over a per-user named pipe.
//      When the user clicks `vidsync://auth-callback#token=...`,
//      Windows starts a NEW vidsync.exe with that URL as os.Args[1].
//      The already-running instance owns the WebView2 + daemon
//      supervisor, so we forward the URL to it over a named pipe
//      and exit the new process immediately. Receiving the URL
//      ends up in App.deliverAuthURI in auth_bridge.go.
//
//   2. DPAPI-encrypted token storage. The vsk_ token the bridge
//      hands us lives across launches in %LOCALAPPDATA%\Vidsync\
//      auth.bin, wrapped with CryptProtectData (per-user, machine-
//      bound). DPAPI is the same crypto Windows Credential Manager
//      uses; using it directly saves a dependency.

//go:build windows

package main

import (
	"encoding/hex"
	"errors"
	"io"
	"log"
	"net"
	"os"
	"path/filepath"
	"strings"
	"time"
	"unsafe"

	"github.com/Microsoft/go-winio"
	"golang.org/x/sys/windows"
)

// authPipeName is the per-user named pipe a running vidsync.exe
// listens on for forwarded URI launches. Using \\.\pipe\ (a session-
// global path) plus the username keeps two users on the same machine
// from stepping on each other's auth bridge.
func authPipeName() string {
	u := strings.TrimSpace(os.Getenv("USERNAME"))
	if u == "" {
		u = "vidsync"
	}
	return `\\.\pipe\Vidsync-AuthBridge-` + u
}

// showWindowSignal is the sentinel a second vidsync.exe writes to the
// running instance's pipe to mean "surface your window" — as opposed to
// a vidsync:// auth URI. It can't collide with a real URI: the listener
// matches it exactly before falling through to deliverAuthURI.
const showWindowSignal = "vidsync:show-window"

// forwardURIToRunningInstance is called from main() when this
// process detected another vidsync owns the single-instance mutex AND
// the OS handed us a vidsync:// URL on the command line. We open the
// other instance's pipe, write the URL, and exit. The receiving end
// (startAuthBridgePipeListener) emits a Wails event the React app
// listens for.
func forwardURIToRunningInstance(uri string) bool {
	conn, err := winio.DialPipe(authPipeName(), durationPtr(2*time.Second))
	if err != nil {
		log.Printf("auth bridge: forward failed (DialPipe): %v", err)
		return false
	}
	defer conn.Close()
	_ = conn.SetWriteDeadline(time.Now().Add(2 * time.Second))
	if _, err := io.WriteString(conn, uri); err != nil {
		log.Printf("auth bridge: forward failed (write): %v", err)
		return false
	}
	// Hand our foreground-right over before we exit. This process was
	// just spawned by the browser's "Open in Vidsync?" click, which
	// briefly makes us the foreground process — Windows only lets the
	// current foreground caller grant the "set foreground" privilege
	// to others, so we must do it now. After our exit, the running
	// vidsync can pull its window to the front (see nudgeWindowToFront).
	allowAnyForeground()
	return true
}

// signalShowToRunningInstance is called from main() when this process
// lost the single-instance race on a plain launch (no vidsync:// URI) —
// i.e. the user double-clicked the icon while vidsync was already
// running, possibly hidden to the tray. We write the show-window
// sentinel to the running instance's pipe and hand over our foreground
// right (same dance as forwardURIToRunningInstance) so it can raise its
// window above whatever's in front, then exit.
func signalShowToRunningInstance() bool {
	conn, err := winio.DialPipe(authPipeName(), durationPtr(2*time.Second))
	if err != nil {
		log.Printf("show-window: dial running instance failed: %v", err)
		return false
	}
	defer conn.Close()
	_ = conn.SetWriteDeadline(time.Now().Add(2 * time.Second))
	if _, err := io.WriteString(conn, showWindowSignal); err != nil {
		log.Printf("show-window: write failed: %v", err)
		return false
	}
	allowAnyForeground()
	return true
}

func durationPtr(d time.Duration) *time.Duration { return &d }

// startAuthBridgePipeListener stands up the named pipe listener that
// receives forwarded URIs from secondary vidsync.exe launches. Runs
// for the life of the process.
func startAuthBridgePipeListener(app *App) {
	go func() {
		ln, err := winio.ListenPipe(authPipeName(), nil)
		if err != nil {
			log.Printf("auth bridge: ListenPipe failed: %v — auth forwards disabled", err)
			return
		}
		log.Printf("auth bridge: listening on %s", authPipeName())
		for {
			conn, err := ln.Accept()
			if err != nil {
				if errors.Is(err, winio.ErrPipeListenerClosed) {
					return
				}
				log.Printf("auth bridge: accept: %v", err)
				continue
			}
			go func(c net.Conn) {
				defer c.Close()
				_ = c.SetReadDeadline(time.Now().Add(2 * time.Second))
				buf, err := io.ReadAll(io.LimitReader(c, 8192))
				if err != nil {
					log.Printf("auth bridge: read: %v", err)
					return
				}
				msg := strings.TrimSpace(string(buf))
				if msg == showWindowSignal {
					app.bringWindowToFront()
					return
				}
				app.deliverAuthURI(msg)
			}(conn)
		}
	}()
}

// --- DPAPI-wrapped token I/O ---

func saveAuthToken(token string) error {
	path, err := authTokenPath()
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	cipher, err := dpapiProtect([]byte(token))
	if err != nil {
		return err
	}
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, []byte(hex.EncodeToString(cipher)), 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}

func loadAuthToken() (string, error) {
	path, err := authTokenPath()
	if err != nil {
		return "", err
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		return "", err
	}
	cipher, err := hex.DecodeString(strings.TrimSpace(string(raw)))
	if err != nil {
		return "", err
	}
	plain, err := dpapiUnprotect(cipher)
	if err != nil {
		return "", err
	}
	return string(plain), nil
}

func deleteAuthToken() error {
	path, err := authTokenPath()
	if err != nil {
		return err
	}
	return os.Remove(path)
}

// --- raw DPAPI wrappers (CryptProtectData / CryptUnprotectData) ---

var (
	crypt32              = windows.NewLazySystemDLL("crypt32.dll")
	procCryptProtectData = crypt32.NewProc("CryptProtectData")
	procCryptUnprotect   = crypt32.NewProc("CryptUnprotectData")

	user32                       = windows.NewLazySystemDLL("user32.dll")
	procAllowSetForegroundWindow = user32.NewProc("AllowSetForegroundWindow")
	procFindWindowW              = user32.NewProc("FindWindowW")
	procSetForegroundWindow      = user32.NewProc("SetForegroundWindow")
	procBringWindowToTop         = user32.NewProc("BringWindowToTop")
	procIsIconic                 = user32.NewProc("IsIconic")
	procShowWindow               = user32.NewProc("ShowWindow")
)

const (
	asfwAny   = 0xFFFFFFFF // ASFW_ANY — grant foreground rights to any process
	swRestore = 9          // SW_RESTORE — un-minimise the window
)

// allowAnyForeground hands this process's "may set foreground" right
// over to any other process — called by the forwarder before exit so
// the running vidsync instance can pull itself to the front.
func allowAnyForeground() {
	_, _, _ = procAllowSetForegroundWindow.Call(uintptr(uint32(asfwAny)))
}

// nudgeWindowToFront finds the running vidsync top-level window by
// title and forces it to the foreground (and restores it if
// minimised). Works because the forwarder process called
// allowAnyForeground() before exiting, so Windows accepts our
// foreground grab. Called from the cross-platform bringWindowToFront
// after a forwarded URI delivery.
func nudgeWindowToFront() {
	title := "Vidsync"
	t, err := windows.UTF16PtrFromString(title)
	if err != nil {
		return
	}
	hwnd, _, _ := procFindWindowW.Call(0, uintptr(unsafe.Pointer(t)))
	if hwnd == 0 {
		return
	}
	// If the window is minimised, ShowWindow(SW_RESTORE) un-minimises.
	// We call it conditionally so a normal show doesn't trip a no-op
	// path that some shells log loudly.
	iconic, _, _ := procIsIconic.Call(hwnd)
	if iconic != 0 {
		_, _, _ = procShowWindow.Call(hwnd, uintptr(swRestore))
	}
	_, _, _ = procBringWindowToTop.Call(hwnd)
	_, _, _ = procSetForegroundWindow.Call(hwnd)
}

// dataBlob mirrors Win32's DATA_BLOB. Used for both directions.
type dataBlob struct {
	cbData uint32
	pbData *byte
}

func newBlob(b []byte) dataBlob {
	if len(b) == 0 {
		var z [1]byte
		return dataBlob{0, &z[0]}
	}
	return dataBlob{uint32(len(b)), &b[0]}
}

func (b dataBlob) bytes() []byte {
	if b.cbData == 0 {
		return nil
	}
	out := make([]byte, b.cbData)
	src := unsafe.Slice(b.pbData, b.cbData)
	copy(out, src)
	return out
}

func dpapiProtect(plain []byte) ([]byte, error) {
	in := newBlob(plain)
	var out dataBlob
	r, _, err := procCryptProtectData.Call(
		uintptr(unsafe.Pointer(&in)),
		0, 0, 0, 0, 0,
		uintptr(unsafe.Pointer(&out)),
	)
	if r == 0 {
		return nil, err
	}
	cipher := out.bytes()
	if out.pbData != nil {
		windows.LocalFree(windows.Handle(unsafe.Pointer(out.pbData)))
	}
	return cipher, nil
}

func dpapiUnprotect(cipher []byte) ([]byte, error) {
	in := newBlob(cipher)
	var out dataBlob
	r, _, err := procCryptUnprotect.Call(
		uintptr(unsafe.Pointer(&in)),
		0, 0, 0, 0, 0,
		uintptr(unsafe.Pointer(&out)),
	)
	if r == 0 {
		return nil, err
	}
	plain := out.bytes()
	if out.pbData != nil {
		windows.LocalFree(windows.Handle(unsafe.Pointer(out.pbData)))
	}
	return plain, nil
}
