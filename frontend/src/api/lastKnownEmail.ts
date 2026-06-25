// Last-known signed-in email, persisted so the UI never blanks to a generic
// "Signed in" while the live /v1/me result is missing — a cold start before
// the first fetch resolves, or a transient failure when the control plane is
// briefly down (it occasionally 502s). The email is always stored
// server-side; this is purely a client display cache.
//
// Two layers:
//   - localStorage — a synchronous fast cache the render path can read
//     without awaiting anything.
//   - the Go side (App.GetLastEmail / SetLastEmail) — the durable backstop,
//     because the macOS WKWebView doesn't reliably persist localStorage
//     across launches. We rehydrate the localStorage cache from Go at
//     startup (see useAccountEmail).
//
// Cleared on sign-out: localStorage here, and the Go-side file via the auth
// bridge's ClearAuthToken / ClearAuthTokenLocal.

const KEY = "vidsync.lastKnownEmail";

interface EmailBindings {
  GetLastEmail?: () => Promise<string>;
  SetLastEmail?: (email: string) => Promise<void>;
}

function goApp(): EmailBindings | null {
  const w = window as unknown as {
    go?: { main?: { App?: EmailBindings } };
  };
  return w.go?.main?.App ?? null;
}

// getLastKnownEmail is the synchronous read used during render.
export function getLastKnownEmail(): string {
  try {
    return localStorage.getItem(KEY) ?? "";
  } catch {
    return "";
  }
}

function writeLocalCache(email: string): void {
  try {
    localStorage.setItem(KEY, email);
  } catch {
    // best-effort; the sticky email is a nicety, not load-bearing
  }
}

// setLastKnownEmail records a freshly-seen email in both layers.
export function setLastKnownEmail(email: string): void {
  if (!email) return;
  writeLocalCache(email);
  // Durable backstop on the Go side (fire-and-forget; missing in dev/browser).
  void goApp()?.SetLastEmail?.(email);
}

// loadDurableEmail reads the Go-persisted email, used at startup to
// rehydrate the localStorage cache when the webview lost it. Returns "" in
// dev/browser where the binding is absent, or on any error.
export async function loadDurableEmail(): Promise<string> {
  try {
    const get = goApp()?.GetLastEmail;
    if (!get) return "";
    return (await get()) ?? "";
  } catch {
    return "";
  }
}

// rehydrateLocalCache mirrors a durable value into the synchronous cache so
// later getLastKnownEmail() reads see it.
export function rehydrateLocalCache(email: string): void {
  if (email) writeLocalCache(email);
}

// clearLastKnownEmail drops the synchronous cache. The Go-side file is
// cleared separately by the auth bridge on sign-out.
export function clearLastKnownEmail(): void {
  try {
    localStorage.removeItem(KEY);
  } catch {
    // ignore
  }
}
