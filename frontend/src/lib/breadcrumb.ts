// Lightweight breadcrumb helper. Drops a one-liner into vidsync.log
// via the App.LogJS Wails binding (exposed by main.tsx as
// window.vlog). Used to trace user interactions just before
// rapid-click crashes that take the renderer down before any stack
// trace can be captured.
//
// No-op in dev / browser builds where the Wails binding isn't
// present, so call sites can sprinkle these freely.
export function bc(message: string): void {
  try {
    const w = window as unknown as { vlog?: (m: string) => void };
    if (w.vlog) w.vlog(message);
  } catch {
    /* never let logging break a render */
  }
}
