import { useCloudDevices, useDeleteCloudDevice } from "../api/cloud/hooks";
import { humanRelative } from "../lib/format";
import { useSystemStatus } from "../api/hooks";

// MyDevicesPanel: lists every device the account has touched. With
// the new one-active-device model, at most one row will be the
// current active device (no revokedAt) — the rest are historical.
// Removing a revoked row is purely housekeeping; the row is already
// "off". Removing an active row means: next time the daemon boots
// somewhere, registering will succeed without a verification step.

export function MyDevicesPanel() {
  const devices = useCloudDevices();
  const sys = useSystemStatus();
  const del = useDeleteCloudDevice();

  const myID = sys.data?.myID ?? "";

  if (devices.isLoading) {
    return <p className="text-sm text-fg-soft">Loading devices…</p>;
  }
  if (devices.isError) {
    return (
      <p className="text-sm text-rose-600">
        Couldn't load devices: {(devices.error as Error)?.message}
      </p>
    );
  }
  const rows = devices.data?.devices ?? [];
  const active = rows.find((d) => !d.revokedAt);
  const history = rows.filter((d) => !!d.revokedAt);

  return (
    <div>
      <p className="mb-3 text-xs text-fg-soft">
        Vidsync allows one active device per account. Signing in
        somewhere new emails you a code that swaps the active slot.
      </p>

      {active ? (
        <div className="mb-3 rounded-md border border-indigo-500/30 bg-indigo-500/5 px-3 py-2 text-sm">
          <div className="flex items-center gap-2">
            <span className="font-medium text-fg-strong">{active.name}</span>
            {active.syncthingDeviceId === myID && (
              <span className="rounded bg-indigo-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-indigo-800">
                This device
              </span>
            )}
            <span className="ml-auto text-[11px] text-indigo-700">Active</span>
          </div>
          <div className="truncate font-mono text-[11px] text-fg-soft">
            {active.syncthingDeviceId.slice(0, 23)}…
          </div>
          <div className="text-[11px] text-fg-soft">
            Added {humanRelative(active.createdAt)} · Last seen{" "}
            {humanRelative(active.lastSeenAt)}
          </div>
        </div>
      ) : (
        <p className="mb-3 rounded border border-dashed border-line px-4 py-3 text-center text-sm text-fg-soft">
          No active device.
        </p>
      )}

      {history.length > 0 && (
        <div>
          <h4 className="mb-1 text-xs font-medium uppercase tracking-wide text-fg-soft">
            Previously used
          </h4>
          <ul className="divide-y divide-line rounded-md border border-line">
            {history.map((d) => (
              <li
                key={d.id}
                className="flex items-center gap-3 px-3 py-2 text-sm"
              >
                <div className="min-w-0 flex-1">
                  <div className="font-medium text-fg">{d.name}</div>
                  <div className="truncate font-mono text-[11px] text-fg-soft">
                    {d.syncthingDeviceId.slice(0, 23)}…
                  </div>
                  <div className="text-[11px] text-fg-soft">
                    Revoked{" "}
                    {d.revokedAt ? humanRelative(d.revokedAt) : "—"}
                  </div>
                </div>
                <button
                  type="button"
                  disabled={del.isPending}
                  onClick={() => del.mutate(d.id)}
                  className="shrink-0 rounded border border-line px-2 py-1 text-xs text-fg-soft hover:border-rose-400 hover:bg-rose-50 hover:text-rose-700 disabled:opacity-50"
                >
                  Forget
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      {del.isError && (
        <p className="mt-2 text-xs text-rose-700">
          {(del.error as Error).message}
        </p>
      )}
    </div>
  );
}
