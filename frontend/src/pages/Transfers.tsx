import { useMemo, useState } from "react";
import { useAllTransfers, type TransferRow } from "../realtime/hooks";
import {
  useConfig,
  useConnections,
  usePauseAll,
  useResumeAll,
} from "../api/hooks";
import { useConnectionRates } from "../api/useConnectionRates";
import {
  humanBytes,
  humanDuration,
  humanRate,
  isActiveRate,
} from "../lib/format";
import { useVideoThumb } from "../lib/useVideoThumb";
import { LazyVideoPreviewModal } from "../components/LazyVideoPreviewModal";
import type { VideoPreviewFile } from "../components/VideoPreviewModal";
import { BandwidthChart } from "../components/BandwidthChart";
import { cn } from "../lib/utils";

// Transfers: cross-project view of every in-flight transfer.
// Reorganised into three layers (KPI strip → bandwidth chart →
// active transfers list) so the headline numbers, the live trend,
// and the per-file detail each get their own dedicated slot.
//
// The peer breakdown ("3 direct · 1 LAN") is read from
// /rest/system/connections. The daemon's `type` field is one of
// tcp-*, quic-*, or relay-*; we classify anything non-relay as
// "direct". LAN-only attribution would require checking the address
// for an RFC1918 range — left for a follow-up.

export function Transfers({
  onOpenProject,
}: {
  onOpenProject: (folderID: string) => void;
}) {
  const rows = useAllTransfers();
  const cfg = useConfig();
  const conns = useConnections();
  const { total } = useConnectionRates();
  const pauseAll = usePauseAll();
  const resumeAll = useResumeAll();
  const [preview, setPreview] = useState<VideoPreviewFile | null>(null);

  const folderLabel = useMemo(() => {
    const m: Record<string, string> = {};
    for (const f of cfg.data?.folders ?? []) {
      m[f.id] = f.label || f.id;
    }
    return m;
  }, [cfg.data?.folders]);

  // Peer-connection breakdown for the KPI card.
  const peers = useMemo(() => {
    const map = conns.data?.connections ?? {};
    let connected = 0;
    let direct = 0;
    let relayed = 0;
    for (const c of Object.values(map)) {
      if (!c.connected) continue;
      connected++;
      if (typeof c.type === "string" && c.type.includes("relay")) {
        relayed++;
      } else {
        direct++;
      }
    }
    return { connected, direct, relayed };
  }, [conns.data?.connections]);

  // Globally paused = no device-pause record but no peer connections
  // either. We use the most recent mutation outcome as a hint so the
  // button label flips immediately after a click without waiting for
  // the next /connections poll.
  const isPausedHint =
    pauseAll.isSuccess && !resumeAll.isSuccess
      ? true
      : resumeAll.isSuccess
        ? false
        : null;

  return (
    // Flex column so the KPIs + chart + active-transfers header stay
    // fixed while only the per-file list scrolls inside its panel.
    <div className="mx-auto flex h-full w-full max-w-6xl flex-col px-8 py-10">
      <header className="mb-6 flex shrink-0 flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-3xl font-semibold tracking-tight text-fg-strong">
            Transfers
          </h1>
          <p className="mt-1 text-sm text-fg-soft">
            {rows.length === 0
              ? "Nothing transferring right now."
              : `${rows.length} active`}
            {peers.connected > 0 && (
              <>
                {" · "}
                connected to {peers.connected}{" "}
                peer{peers.connected === 1 ? "" : "s"}
              </>
            )}
          </p>
        </div>
        <PauseAllButton
          isPaused={isPausedHint}
          onPause={() => pauseAll.mutate()}
          onResume={() => resumeAll.mutate()}
          busy={pauseAll.isPending || resumeAll.isPending}
        />
      </header>

      <div className="mb-6 grid shrink-0 grid-cols-1 gap-3 sm:grid-cols-3">
        <KpiCard
          eyebrow="Upload"
          value={humanRate(total.outBytesPerSec)}
          unit="" /* humanRate already includes the unit suffix */
          accent="upload"
          active={isActiveRate(total.outBytesPerSec)}
        />
        <KpiCard
          eyebrow="Download"
          value={humanRate(total.inBytesPerSec)}
          unit=""
          accent="download"
          active={isActiveRate(total.inBytesPerSec)}
        />
        <KpiCard
          eyebrow="Peers"
          value={peers.connected.toString()}
          unit={peers.connected === 1 ? "peer" : "peers"}
          caption={
            peers.connected === 0
              ? "no peers connected"
              : peers.relayed === 0
                ? `${peers.direct} direct`
                : peers.direct === 0
                  ? `${peers.relayed} relayed`
                  : `${peers.direct} direct · ${peers.relayed} relayed`
          }
        />
      </div>

      <div className="mb-6 shrink-0">
        <BandwidthChart />
      </div>

      <section className="flex min-h-0 flex-1 flex-col">
        <header className="mb-3 flex shrink-0 items-center justify-between">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-fg-soft">
            Active transfers
          </h2>
          {rows.length > 0 && (
            <span className="text-xs text-fg-faint">
              {rows.length} file{rows.length === 1 ? "" : "s"}
            </span>
          )}
        </header>
        {rows.length === 0 ? (
          <div className="shrink-0 rounded-xl border border-dashed border-line-strong bg-elevated/40 px-6 py-16 text-center">
            <p className="text-sm text-fg-soft">
              When files are downloading or uploading, you'll see them here with
              live progress.
            </p>
          </div>
        ) : (
          // Only this panel scrolls; the KPIs + chart above stay
          // anchored. min-h-0 lets the flex child shrink below its
          // intrinsic size so overflow-y-auto kicks in.
          <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-line bg-elevated">
            <ul className="min-h-0 flex-1 divide-y divide-line overflow-y-auto">
              {rows.map((row) => (
                <li key={`${row.folderID}:${row.path}`}>
                  <TransferEntry
                    row={row}
                    projectName={folderLabel[row.folderID] ?? row.folderID}
                    onOpenProject={() => onOpenProject(row.folderID)}
                    onPreview={(file) => setPreview(file)}
                  />
                </li>
              ))}
            </ul>
          </div>
        )}
      </section>

      <LazyVideoPreviewModal file={preview} onClose={() => setPreview(null)} />
    </div>
  );
}

// PauseAllButton: toggles between Pause-all and Resume-all based on
// the most recent successful mutation. We don't have a clean "paused
// globally" indicator in the daemon state, so this is a hint-based
// label rather than a derived truth — but it covers the common flow
// (user clicks Pause → they see Resume next).
function PauseAllButton({
  isPaused,
  onPause,
  onResume,
  busy,
}: {
  isPaused: boolean | null;
  onPause: () => void;
  onResume: () => void;
  busy: boolean;
}) {
  const showResume = isPaused === true;
  return (
    <button
      type="button"
      onClick={showResume ? onResume : onPause}
      disabled={busy}
      className={cn(
        "inline-flex items-center gap-2 rounded-lg border px-3 py-2 text-sm font-medium transition-colors disabled:opacity-50",
        showResume
          ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-300 hover:bg-emerald-500/15"
          : "border-rose-500/30 bg-rose-500/10 text-rose-300 hover:bg-rose-500/15",
      )}
    >
      <span
        className={cn(
          "h-1.5 w-1.5 rounded-full",
          showResume ? "bg-emerald-400" : "bg-rose-400",
        )}
        aria-hidden
      />
      {busy ? "Working…" : showResume ? "Resume all" : "Pause all"}
    </button>
  );
}

function KpiCard({
  eyebrow,
  value,
  unit,
  caption,
  accent,
  active,
}: {
  eyebrow: string;
  value: string;
  unit: string;
  caption?: string;
  // upload=purple, download=green — the global convention the rest of
  // the page (chart, row arrows) follows. Default is theme accent.
  accent?: "upload" | "download";
  active?: boolean;
}) {
  const valueColor =
    accent === "upload"
      ? "text-violet-300"
      : accent === "download"
        ? "text-emerald-300"
        : "text-fg-strong";
  return (
    <div className="rounded-xl border border-line bg-panel px-5 py-4">
      <div className="flex items-center gap-2 text-[11px] font-medium uppercase tracking-wide text-fg-soft">
        {accent && (
          <span
            className={cn(
              "h-1.5 w-1.5 rounded-full",
              accent === "upload" ? "bg-violet-400" : "bg-emerald-400",
              active ? "" : "opacity-50",
            )}
            aria-hidden
          />
        )}
        {eyebrow}
      </div>
      <div className="mt-1 flex items-baseline gap-1.5">
        <span className={cn("font-mono text-2xl font-semibold tracking-tight", valueColor)}>
          {value}
        </span>
        {unit && <span className="text-xs text-fg-soft">{unit}</span>}
      </div>
      {caption && <div className="mt-1 text-xs text-fg-soft">{caption}</div>}
    </div>
  );
}

function TransferEntry({
  row,
  projectName,
  onOpenProject,
  onPreview,
}: {
  row: TransferRow;
  projectName: string;
  onOpenProject: () => void;
  onPreview: (f: VideoPreviewFile) => void;
}) {
  const fileName = basename(row.path);
  const pct =
    row.progress.bytesTotal > 0
      ? (row.progress.bytesDone / row.progress.bytesTotal) * 100
      : 0;
  const remaining = Math.max(
    0,
    row.progress.bytesTotal - row.progress.bytesDone,
  );
  const ratePerSec = row.rate?.bytesPerSec ?? 0;
  const etaSeconds = row.rate?.etaSeconds;

  // Direction inference: the puller-progress stream represents files
  // *we are pulling*, so every active transfer in this list is a
  // download from this device's perspective. (When the daemon does
  // expose direction we'll thread it through here.)
  const direction: "down" = "down";

  return (
    <div className="flex items-center gap-4 px-4 py-3">
      <TransferThumb folderID={row.folderID} row={row} />
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <DirectionArrow direction={direction} />
          <div
            className="truncate text-sm font-medium text-fg-strong"
            title={row.path}
          >
            {fileName}
          </div>
          <button
            type="button"
            onClick={onOpenProject}
            className="shrink-0 truncate rounded px-1.5 py-0.5 text-[11px] text-fg-soft hover:bg-hover hover:text-fg-strong"
            title={`Open ${projectName}`}
          >
            {projectName}
          </button>
        </div>
        <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-hover">
          <div
            className={cn(
              "h-full transition-[width]",
              direction === "down" ? "bg-emerald-400" : "bg-violet-400",
            )}
            style={{ width: `${Math.max(1, Math.min(100, pct))}%` }}
          />
        </div>
        <div className="mt-1.5 flex flex-wrap items-center gap-x-3 text-xs text-fg-faint">
          <span className="font-mono text-fg-soft">
            {Math.floor(pct)}%
          </span>
          <span aria-hidden>·</span>
          <span>
            {humanBytes(row.progress.bytesDone)} of{" "}
            {humanBytes(row.progress.bytesTotal)}
          </span>
          {isActiveRate(ratePerSec) && (
            <>
              <span aria-hidden>·</span>
              <span className="text-emerald-300">{humanRate(ratePerSec)}</span>
            </>
          )}
          {etaSeconds !== undefined && etaSeconds > 0 && (
            <>
              <span aria-hidden>·</span>
              <span title={`${remaining.toLocaleString()} bytes left`}>
                {humanDuration(etaSeconds)} left
              </span>
            </>
          )}
        </div>
      </div>
      <PreviewButton row={row} onPreview={onPreview} fileName={fileName} />
    </div>
  );
}

function DirectionArrow({ direction }: { direction: "down" | "up" }) {
  // Color-codes direction in line with the rest of the page: green
  // arrow for incoming, purple for outgoing.
  const color = direction === "down" ? "text-emerald-300" : "text-violet-300";
  return (
    <span className={cn("shrink-0", color)} aria-hidden>
      {direction === "down" ? "↓" : "↑"}
    </span>
  );
}

function PreviewButton({
  row,
  onPreview,
  fileName,
}: {
  row: TransferRow;
  onPreview: (f: VideoPreviewFile) => void;
  fileName: string;
}) {
  if (!isVideoExt(fileName)) return null;
  return (
    <button
      type="button"
      onClick={() =>
        onPreview({
          folderID: row.folderID,
          path: row.path,
          name: fileName,
          size: row.progress.bytesTotal,
        })
      }
      title="Preview"
      aria-label="Preview"
      className="shrink-0 rounded-md p-1.5 text-fg-soft hover:bg-hover hover:text-fg-strong"
    >
      <svg
        viewBox="0 0 20 20"
        fill="currentColor"
        className="h-5 w-5"
        aria-hidden
      >
        <path d="M5 4.5v11l10-5.5L5 4.5z" />
      </svg>
    </button>
  );
}

function TransferThumb({
  folderID,
  row,
}: {
  folderID: string;
  row: TransferRow;
}) {
  const fileName = basename(row.path);
  const isVideo = isVideoExt(fileName);
  const key = isVideo
    ? {
        folderID,
        path: row.path,
        size: row.progress.bytesTotal,
        modified: row.path,
      }
    : null;
  // enabled=false: in-flight transfers aren't fully synced, so we never
  // generate here — only show a cached thumb if one already exists.
  const thumb = useVideoThumb(key, false);

  return (
    <div className="h-12 w-20 shrink-0 overflow-hidden rounded bg-black">
      {thumb ? (
        <img
          src={thumb}
          alt=""
          className="h-full w-full object-cover"
          draggable={false}
          aria-hidden
        />
      ) : (
        <div className="flex h-full w-full items-center justify-center bg-elevated">
          <span className="font-mono text-xs uppercase tracking-wider text-fg-faint">
            {extOf(fileName)}
          </span>
        </div>
      )}
    </div>
  );
}

function basename(p: string): string {
  const slash = p.lastIndexOf("/");
  return slash >= 0 ? p.slice(slash + 1) : p;
}

function extOf(name: string): string {
  const dot = name.lastIndexOf(".");
  if (dot < 0) return "";
  const ext = name.slice(dot + 1).toLowerCase();
  return ext.length < 6 ? ext : "";
}

const VIDEO_EXT = ["mp4", "mov", "mkv", "webm", "avi", "m4v", "mpg", "mpeg"];

function isVideoExt(name: string): boolean {
  return VIDEO_EXT.includes(extOf(name));
}
