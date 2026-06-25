import { usePing } from "../api/hooks";

// OfflineBanner shows a thin warning strip when the local sync engine
// isn't responding. The label differs depending on which failure
// mode we're in:
//   - "Starting…" before the daemon has ever answered ping in this
//     session — i.e. cold launch while the bundled binary is being
//     extracted and the daemon process is spinning up its REST API.
//   - "Reconnecting…" if the daemon was reachable at some point but
//     now isn't (mid-session crash, killed via Task Manager, etc.).
//     This is the worrying case and uses the louder amber palette.
//
// React Query's dataUpdatedAt is the timestamp of the most recent
// successful ping, or 0 if there's never been one. That's the
// honest signal for "have we ever connected this session" — checking
// `data` itself doesn't work because client.ping() resolves to void.
// Detail (the underlying error message) lives in the tooltip so the
// banner stays calm — most users don't need the stacktrace.
export function OfflineBanner() {
  const { isError, error, dataUpdatedAt } = usePing();
  if (!isError) return null;
  const hasConnectedBefore = dataUpdatedAt > 0;
  const detail =
    error instanceof Error ? error.message : "no response from local engine";
  return (
    <div
      className={
        "border-b px-4 py-2 text-sm " +
        (hasConnectedBefore
          ? "border-amber-500/30 bg-amber-500/10 text-amber-200"
          : "border-line-strong bg-panel text-fg-soft")
      }
      title={detail}
    >
      {hasConnectedBefore
        ? "Reconnecting to your local workspace…"
        : "Starting your local workspace…"}
    </div>
  );
}
