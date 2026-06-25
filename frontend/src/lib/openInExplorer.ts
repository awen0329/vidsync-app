// openInExplorer asks the host to launch the OS file manager at the
// given absolute path. No-op in dev / browser builds where the Wails
// binding isn't present. Callers can fire-and-forget — the host
// detaches the explorer process.

interface ExplorerBinding {
  OpenInExplorer(path: string): Promise<void>;
}

function binding(): ExplorerBinding | null {
  const w = window as unknown as {
    go?: { main?: { App?: ExplorerBinding } };
  };
  return w.go?.main?.App?.OpenInExplorer ? (w.go.main.App as ExplorerBinding) : null;
}

export function openInExplorer(path: string): void {
  const b = binding();
  if (!b || !path) return;
  void b.OpenInExplorer(path);
}

// isExplorerAvailable lets UI decide whether to render the
// "click-to-open" affordance. In a web/dev build we hide it.
export function isExplorerAvailable(): boolean {
  return binding() !== null;
}
