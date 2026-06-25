// openExternal routes a URL to the OS default browser when running
// inside Wails (so Stripe Checkout etc. don't replace the React app
// in the embedded WebView2), and falls back to window.location.assign
// in dev / browser builds.
//
// Async because the Wails binding returns a Promise; callers don't
// need to await it but TypeScript will infer the right shape.

interface WailsExternalBindings {
  OpenExternal(url: string): Promise<void>;
}

function bindings(): WailsExternalBindings | null {
  const w = window as unknown as {
    go?: { main?: { App?: WailsExternalBindings } };
  };
  return w.go?.main?.App?.OpenExternal ? (w.go.main.App as WailsExternalBindings) : null;
}

export function openExternal(url: string): void {
  const app = bindings();
  if (app) {
    void app.OpenExternal(url);
    return;
  }
  window.location.assign(url);
}
