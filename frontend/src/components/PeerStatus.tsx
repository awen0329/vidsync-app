import { useCompletion, useConnections } from "../api/hooks";
import { useConnectionRates } from "../api/useConnectionRates";
import {
  humanRate,
  humanRelative,
  isActiveRate,
  isUnsetTime,
} from "../lib/format";
import { useTick } from "../lib/useTick";
import { PresenceAvatar, type PresenceState } from "./PresenceAvatar";

// PeerStatus renders a row per collaborator: presence avatar with a
// status dot, the person's name as primary text, and a secondary line
// with current state (online · idle / Syncing / Last seen / etc).
// `name` should already be the human-readable label (email or display
// name) — this component doesn't go look it up.

export function PeerStatus({
  deviceID,
  name,
  detail,
  folderID,
  onRemove,
}: {
  deviceID: string;
  name: string;
  // Optional secondary identifier (e.g. email) shown under the name.
  detail?: string;
  folderID?: string;
  onRemove?: () => void;
}) {
  const conns = useConnections();
  const { rates } = useConnectionRates();
  const completion = useCompletion(folderID ?? null, deviceID);
  useTick(30_000);

  const c = conns.data?.connections[deviceID];
  const online = c?.connected ?? false;
  const paused = c?.paused ?? false;
  const rate = rates[deviceID];
  const pct = completion.data?.completion;

  const transferring =
    online &&
    (isActiveRate(rate?.inBytesPerSec) || isActiveRate(rate?.outBytesPerSec));

  const presence: PresenceState = transferring
    ? "syncing"
    : online
      ? "online"
      : "offline";

  const statusLabel = transferring
    ? "Syncing"
    : online
      ? "Online"
      : paused
        ? "Paused"
        : "Offline";

  return (
    <div className="flex items-center gap-3 px-4 py-3 text-sm text-fg-strong">
      <PresenceAvatar label={name} state={presence} />
      <div className="min-w-0 flex-1">
        <div className="truncate font-medium text-fg-strong">{name}</div>
        {detail && (
          <div className="truncate text-xs text-fg-faint">{detail}</div>
        )}
        <div className="mt-0.5 flex items-center gap-2 text-xs text-fg-soft">
          <span className="font-medium text-fg">{statusLabel}</span>
          {transferring ? (
            <span className="text-fg-faint">
              · ↓ {humanRate(rate?.inBytesPerSec)} · ↑ {humanRate(rate?.outBytesPerSec)}
            </span>
          ) : online ? null : c?.at && !isUnsetTime(c.at) ? (
            <span
              className="text-fg-faint"
              title={new Date(c.at).toLocaleString()}
            >
              · last seen {humanRelative(c.at)}
            </span>
          ) : (
            <span className="text-fg-faint">· never connected</span>
          )}
        </div>
      </div>
      {folderID && pct !== undefined && (
        <span
          className="shrink-0 font-mono text-xs text-fg-soft"
          title={`${pct.toFixed(2)}% in sync`}
        >
          {pct.toFixed(0)}%
        </span>
      )}
      {onRemove && (
        <button
          type="button"
          onClick={onRemove}
          className="shrink-0 rounded px-2 py-1 text-xs text-fg-soft hover:bg-rose-500/15 hover:text-rose-300"
        >
          Remove
        </button>
      )}
    </div>
  );
}
