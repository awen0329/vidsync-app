import { useConnections } from "../api/hooks";

// MembersHeader: section title with a small "X of Y online" counter
// derived from /rest/system/connections.

export function MembersHeader({
  deviceIDs,
  trailing,
}: {
  deviceIDs: string[];
  trailing?: React.ReactNode;
}) {
  const conns = useConnections();
  const total = deviceIDs.length;
  const online = deviceIDs.filter(
    (id) => conns.data?.connections[id]?.connected,
  ).length;
  return (
    <header className="mb-2 flex items-center justify-between">
      <div className="flex items-baseline gap-3">
        <h3 className="text-sm font-semibold uppercase tracking-wide text-fg-soft">
          Team
        </h3>
        <span className="text-xs text-fg-soft">
          {online} of {total} online
        </span>
      </div>
      {trailing}
    </header>
  );
}
