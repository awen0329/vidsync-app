import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "./App";
import { applyTheme, getStoredTheme } from "./lib/theme";
import "./index.css";

// JS error sink: any uncaught error or unhandled promise rejection
// gets pushed into vidsync.log via the Wails LogJS binding. WebView2
// renderer crashes can take vidsync.exe down before the user has a
// chance to open devtools (F12), so this file-based trail is the
// only thing that survives. No-op in dev/browser mode.
interface WailsLoggerBindings {
  LogJS(level: string, message: string, stack: string): Promise<void>;
}
function jsLogger(): WailsLoggerBindings | null {
  const w = window as unknown as {
    go?: { main?: { App?: WailsLoggerBindings } };
  };
  return w.go?.main?.App?.LogJS ? (w.go.main.App as WailsLoggerBindings) : null;
}
function reportJS(level: string, message: string, stack = "") {
  jsLogger()?.LogJS(level, message, stack);
}

// Breadcrumb sink — for now we expose this on `window` so anywhere in
// the UI can drop a one-liner into vidsync.log. We need this for the
// rapid Files↔Team / Card↔Back crashes: the renderer dies before we
// can see a stack trace, so the only thing that survives is the
// timestamp of the last interaction. Verbose by design.
(window as unknown as { vlog?: (msg: string) => void }).vlog = (msg) => {
  reportJS("breadcrumb", msg);
};
window.addEventListener("error", (e) => {
  reportJS("error", String(e.message), e.error?.stack ?? "");
});
window.addEventListener("unhandledrejection", (e) => {
  const reason = e.reason;
  const msg = reason instanceof Error ? reason.message : String(reason);
  const stack = reason instanceof Error ? reason.stack ?? "" : "";
  reportJS("error", "unhandled rejection: " + msg, stack);
});
// Mirror console.error too — React surfaces component errors there
// before the error boundary triggers.
const origConsoleError = console.error.bind(console);
console.error = (...args: unknown[]) => {
  try {
    reportJS("error", args.map((a) => (a instanceof Error ? a.message : String(a))).join(" "), args.find((a) => a instanceof Error)?.stack ?? "");
  } catch {
    // never let logging break the app
  }
  origConsoleError(...args);
};

// Apply theme synchronously before React mounts so the user never sees
// a flash of the wrong palette. The CSS variables resolve immediately
// once the `data-theme` attribute is set.
applyTheme(getStoredTheme());

// We don't fetch the daemon URL/key here: in both dev (Vite proxy)
// and desktop (Wails AssetServer middleware in cmd/vidsync/proxy.go)
// /rest/* is forwarded same-origin with X-API-Key injected by the
// host, so the frontend stays origin-agnostic.

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
