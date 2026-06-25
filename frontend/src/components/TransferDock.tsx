import { useEffect, useState } from "react";
import { useConfig } from "../api/hooks";
import { useConnectionRates } from "../api/useConnectionRates";
import { useAllTransfers, type TransferRow } from "../realtime/hooks";
import {
  humanBytes,
  humanDuration,
  humanRate,
  isActiveRate,
} from "../lib/format";
import { cn } from "../lib/utils";

// TransferDock: persistent strip pinned to the bottom of the main
// content column whenever there's at least one active file transfer.
// Collapsed by default — shows a single status line with aggregate
// throughput and a count. Click to expand into a scrollable list of
// per-file rows, each with the project label, % complete, rate, and
// an ETA.
//
// Hides itself entirely when there's nothing in flight; we deliberately
// don't keep a "Synced ✓" tail state because the sidebar's transfer
// badge already serves as the at-rest acknowledgement.

const STORAGE_KEY = "vidsync.transferDock.expanded";

function readExpanded(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

function writeExpanded(open: boolean) {
  try {
    localStorage.setItem(STORAGE_KEY, open ? "1" : "0");
  } catch {
    /* private mode — fine */
  }
}

export function TransferDock() {
  const transfers = useAllTransfers();
  const cfg = useConfig();
  const { total } = useConnectionRates();
  const [expanded, setExpanded] = useState<boolean>(readExpanded);

  useEffect(() => {
    writeExpanded(expanded);
  }, [expanded]);

  if (transfers.length === 0) return null;

  const folderLabel = (folderID: string) =>
    cfg.data?.folders.find((f) => f.id === folderID)?.label || folderID;

  const showDown = isActiveRate(total.inBytesPerSec);
  const showUp = isActiveRate(total.outBytesPerSec);

  return (
    <aside className="shrink-0 border-t border-line bg-panel">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="flex w-full items-center gap-3 px-4 py-2 text-left text-sm hover:bg-hover/40"
        aria-expanded={expanded}
        aria-controls="transfer-dock-list"
      >
        <span className="font-medium text-fg-strong">Transfers</span>
        <span className="text-xs text-fg-soft">
          {transfers.length.toLocaleString()} in flight
        </span>
        <span className="ml-auto flex items-center gap-3 font-mono text-xs text-fg-soft">
          {showDown && (
            <span title="received from peers">↓ {humanRate(total.inBytesPerSec)}</span>
          )}
          {showUp && (
            <span title="sent to peers">↑ {humanRate(total.outBytesPerSec)}</span>
          )}
        </span>
        <ChevronIcon
          className={cn(
            "h-4 w-4 text-fg-soft transition-transform",
            expanded ? "rotate-180" : "rotate-0",
          )}
        />
      </button>
      {expanded && (
        <ul
          id="transfer-dock-list"
          className="max-h-64 divide-y divide-line overflow-y-auto border-t border-line"
        >
          {transfers.map((t) => (
            <DockRow
              key={`${t.folderID}:${t.path}`}
              transfer={t}
              folderLabel={folderLabel(t.folderID)}
            />
          ))}
        </ul>
      )}
    </aside>
  );
}

function DockRow({
  transfer,
  folderLabel,
}: {
  transfer: TransferRow;
  folderLabel: string;
}) {
  const { progress, rate, path } = transfer;
  const pct =
    progress.bytesTotal > 0
      ? (progress.bytesDone / progress.bytesTotal) * 100
      : 0;
  const name = path.split("/").pop() ?? path;
  const remainingBytes = Math.max(0, progress.bytesTotal - progress.bytesDone);
  const ratePerSec = rate?.bytesPerSec ?? 0;
  const etaSec = ratePerSec > 0 ? remainingBytes / ratePerSec : null;

  return (
    <li className="px-4 py-2.5">
      <div className="flex items-baseline justify-between gap-3 text-xs">
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium text-fg-strong" title={path}>
            <span className="mr-1.5 text-accent">↓</span>
            {name}
          </div>
          <div className="mt-0.5 truncate text-fg-faint">{folderLabel}</div>
        </div>
        <div className="shrink-0 text-right font-mono text-fg-soft">
          <div>{Math.floor(pct)}%</div>
          <div className="mt-0.5 text-fg-faint">
            {ratePerSec > 0 ? humanRate(ratePerSec) : "—"}
            {etaSec !== null && etaSec > 0 && etaSec < 60 * 60 * 24
              ? ` · ${humanDuration(etaSec)}`
              : ""}
          </div>
        </div>
      </div>
      <div className="mt-1.5 h-1 w-full overflow-hidden rounded-full bg-hover">
        <div
          className="h-1 rounded-full bg-accent transition-[width]"
          style={{ width: `${Math.max(2, Math.min(100, pct))}%` }}
        />
      </div>
      <div className="mt-1 text-[10px] text-fg-faint">
        {humanBytes(progress.bytesDone)} / {humanBytes(progress.bytesTotal)}
      </div>
    </li>
  );
}

function ChevronIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 20 20"
      fill="currentColor"
      className={className}
      aria-hidden
    >
      <path
        fillRule="evenodd"
        d="M14.707 12.707a1 1 0 0 1-1.414 0L10 9.414l-3.293 3.293a1 1 0 0 1-1.414-1.414l4-4a1 1 0 0 1 1.414 0l4 4a1 1 0 0 1 0 1.414z"
        clipRule="evenodd"
      />
    </svg>
  );
}
