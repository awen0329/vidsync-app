// notify.go shows Windows 10+ toast notifications via the system's
// XML-toast facility (under the hood: gopkg.in/toast.v1 generates a
// toast XML manifest and feeds it to PowerShell, which dispatches it
// to the Toast Notification Manager).
//
// This is the "native" path the JS hook in
// frontend/src/api/useDesktopNotifications.ts prefers over the
// browser Notification API, which doesn't reliably surface OS-level
// toasts inside WebView2.
//
// Trade-off: each notify call spawns PowerShell (~200-500ms once).
// Fine for sync-complete events; if it ever becomes too chatty we
// can move to a persistent helper or shell_NotifyIcon balloons.

//go:build windows

package main

import (
	"log"

	toast "gopkg.in/toast.v1"
)

// ShowNotification posts a Windows toast. Bound into JS as
// window.go.main.App.ShowNotification(title, body). Best-effort:
// errors are logged but never propagated to the caller, since a
// missing notification shouldn't break the sync flow that triggered
// it.
func (a *App) ShowNotification(title, body string) {
	n := toast.Notification{
		AppID:   "Vidsync",
		Title:   title,
		Message: body,
		// Audio defaults to the standard new-message sound; that
		// matches what users expect from sync-complete pings.
		Audio: toast.Default,
	}
	if err := n.Push(); err != nil {
		log.Printf("notify: %v", err)
	}
}
