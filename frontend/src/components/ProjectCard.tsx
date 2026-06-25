import { useEffect } from "react";
import { useFolderStatus, usePatchFolder } from "../api/hooks";
import { bc } from "../lib/breadcrumb";
import { useFolderState, useTransfersForFolder } from "../realtime/hooks";
import { humanDuration, humanRate, humanRelative, isActiveRate } from "../lib/format";
import { humanStateLabel } from "../lib/projectState";
import { humanHours, useFolderMediaSummary } from "../lib/useFolderMedia";
import { cn } from "../lib/utils";
import { useUnread } from "../api/cloud/useUnread";
import { ProjectCover } from "./ProjectCover";
import { PresenceAvatar, type PresenceState } from "./PresenceAvatar";
import { UnreadBadge } from "./UnreadBadge";
import { DropboxGlyph } from "./DropboxGlyph";
import { useProjectBackup } from "./useProjectBackup";
import type { FolderConfiguration } from "../api/types";
import type { Origin } from "../api/origins";
import type { ProjectModal } from "../App";

// ProjectCard: one tile in the Projects grid.
//
// Layout (top → bottom):
//   - Cover (collage or gradient) carrying a live status pill (top-left)
//     and an origin tag / action toolbar (top-right). At rest the
//     toolbar fades to the OWNED / SHARED tag; on hover/focus the icons
//     take over the same slot.
//   - When syncing, the bottom of the cover shows a thin remaining-work
//     summary ("X files remaining · ~2 min") so the user gets a
//     glanceable ETA without opening the project.
//   - Body: title, secondary stats line, then a footer with the
//     collaborator avatar stack + presence dot and the "edited Nm ago"
//     timestamp. Static "Progress 100%" bar is gone — the bar only
//     reappears (above the footer) while there's real work in flight,
//     which makes movement an actual signal again.
//
// The outer element is a `<div role="button">` rather than a real
// `<button>` so the action icons can be real <button>s without
// breaking the nested-interactive HTML rule.

const MAX_AVATARS = 3;

export interface ProjectMember {
  id: string;
  label: string;
  state: PresenceState;
}

export function ProjectCard({
  folder,
  origin,
  members,
  deviceID,
  onOpen,
  onAction,
}: {
  folder: FolderConfiguration;
  origin: Origin;
  // Collaborators on this project (excluding self). Labels resolved
  // by the parent so the card never renders raw device IDs.
  members: ProjectMember[];
  // Local Syncthing device id, needed to enable per-project backup.
  deviceID: string;
  onOpen: () => void;
  // Called when a card-level action icon is clicked. The parent
  // navigates to the project detail and opens the matching modal.
  // Pause is handled inline and doesn't go through here.
  onAction: (modal: ProjectModal) => void;
}) {
  const fs = useFolderState(folder.id);
  const { rates } = useTransfersForFolder(folder.id);
  const media = useFolderMediaSummary(folder.id);
  const patch = usePatchFolder();
  // The realtime store gets populated by FolderSummary events from
  // /rest/events. A settled, idle folder may have had its last
  // FolderSummary flushed out of the daemon's event buffer before we
  // connected — in that case fs is undefined and humanStateLabel
  // collapses to "Offline" even though the daemon knows the folder
  // is idle. We poll /db/status as a fallback so the card always
  // reflects the actual daemon state.
  const status = useFolderStatus(folder.id);
  const stat = status.data;
  // Project-wide unread: any clip in this project with comments newer than seen.
  const hasUnread = useUnread(folder.id).isFolderUnread("");

  useEffect(() => {
    bc(`ProjectCard mount folder=${folder.id}`);
    return () => {
      bc(`ProjectCard unmount folder=${folder.id}`);
    };
  }, [folder.id]);

  const view = humanStateLabel(fs?.state ?? stat?.state, folder.paused);
  const isOwned = origin === "owned";
  const backup = useProjectBackup(folder.id, folder.path, deviceID, isOwned);

  // Aggregate per-file rates into a single project-wide throughput.
  let folderBps = 0;
  for (const r of Object.values(rates)) folderBps += r.bytesPerSec;
  const isSyncing = view.state === "syncing";
  const activeRate = isSyncing && isActiveRate(folderBps);

  // ETA from remaining bytes ÷ current rate. Only meaningful when we
  // actually have a non-trivial rate; otherwise we suppress the time
  // portion of the strip.
  const needBytes = fs?.needBytes ?? stat?.needBytes ?? 0;
  const needFiles = fs?.needFiles ?? stat?.needFiles ?? 0;
  const etaSec =
    activeRate && folderBps > 0 && needBytes > 0 ? needBytes / folderBps : null;

  const onlineCount = members.filter((m) => m.state === "online").length;
  const overflow = Math.max(0, members.length - MAX_AVATARS);

  const togglePause = () =>
    patch.mutate({
      id: folder.id,
      patch: { paused: !folder.paused },
    });

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onOpen();
        }
      }}
      className="group flex cursor-pointer flex-col overflow-hidden rounded-xl border border-line bg-elevated text-left shadow-sm transition-all hover:-translate-y-0.5 hover:border-line-strong hover:shadow-lg focus:outline-none focus:ring-2 focus:ring-accent"
    >
      <ProjectCover folderID={folder.id} className="h-36">
        {/* Top-left: live status pill. Always visible — replaces the
            old always-100% progress bar as the primary "what's this
            project doing right now" read. */}
        <div className="absolute left-3 top-3 flex items-center gap-1.5">
          <StatusPill
            view={view}
            rateBps={activeRate ? folderBps : null}
          />
          {hasUnread && (
            <span
              className="inline-flex items-center rounded-full bg-black/55 px-1.5 py-1 backdrop-blur-sm"
              title="Unread comments"
            >
              <UnreadBadge />
            </span>
          )}
        </div>

        {/* Top-right slot is shared by the origin tag (at rest) and
            the action toolbar (on hover/focus). They swap via opacity
            so the layout never shifts. */}
        <div className="absolute right-3 top-3">
          <span
            className={cn(
              "block transition-opacity duration-150",
              "group-hover:opacity-0 group-focus-within:opacity-0",
            )}
          >
            <OriginTag isOwned={isOwned} />
          </span>
          <div
            className={cn(
              "absolute right-0 top-0 flex gap-1 opacity-0 transition-opacity duration-150",
              "group-hover:opacity-100 group-focus-within:opacity-100",
            )}
          >
            {isOwned && (
              <>
                <CardIconButton
                  ariaLabel="Edit project"
                  onClick={() => onAction("edit")}
                >
                  <EditIcon />
                </CardIconButton>
                <CardIconButton
                  ariaLabel="Invite collaborator"
                  onClick={() => onAction("invite")}
                >
                  <InviteIcon />
                </CardIconButton>
                {backup.available && (
                  <CardIconButton
                    ariaLabel={
                      backup.enabled
                        ? "Dropbox backup on — click to turn off"
                        : "Back up to Dropbox"
                    }
                    onClick={backup.toggle}
                  >
                    <DropboxGlyph
                      className={cn(
                        "h-[14px] w-[14px]",
                        backup.enabled && "text-emerald-300",
                      )}
                    />
                  </CardIconButton>
                )}
              </>
            )}
            <CardIconButton
              ariaLabel={folder.paused ? "Resume project" : "Pause project"}
              onClick={togglePause}
            >
              {folder.paused ? <PlayIcon /> : <PauseIcon />}
            </CardIconButton>
            <CardIconButton
              tone="danger"
              ariaLabel={isOwned ? "Delete project" : "Leave project"}
              onClick={() => onAction("delete")}
            >
              {isOwned ? <TrashIcon /> : <LeaveIcon />}
            </CardIconButton>
          </div>
        </div>

        {/* Bottom strip: in-flight progress when syncing, runtime
            headline when idle. The dark gradient from ProjectCover
            already gives this text contrast. */}
        {isSyncing && needFiles > 0 ? (
          <div className="absolute inset-x-0 bottom-0 px-3 pb-2.5 text-[11px] text-white/85">
            {needFiles.toLocaleString()} file{needFiles === 1 ? "" : "s"} remaining
            {etaSec !== null && etaSec > 0 && etaSec < 60 * 60 * 24
              ? ` · ~${humanDuration(etaSec)}`
              : ""}
          </div>
        ) : !isSyncing && media.totalDurationSec > 0 ? (
          <div className="absolute inset-x-0 bottom-0 px-3 pb-2.5 text-[11px] text-white/85">
            {humanHours(media.totalDurationSec)} of footage
            {media.resolution && media.resolution !== "Mixed"
              ? ` · ${media.resolution}`
              : ""}
          </div>
        ) : null}
      </ProjectCover>

      <div className="flex flex-1 flex-col gap-3 p-4">
        <div className="min-w-0">
          <h3 className="truncate text-[15px] font-medium tracking-tight text-fg-strong">
            {folder.label || folder.id}
          </h3>
          <p className="mt-0.5 truncate text-xs text-fg-soft">
            <SecondaryLine
              isSyncing={isSyncing}
              rateBps={folderBps}
              connectedDevices={onlineCount + 1 /* include self */}
              totalDevices={members.length + 1}
              media={media}
            />
          </p>
        </div>

        {/* Thin progress bar — only while there's actual work to do. */}
        {isSyncing && (
          <div className="h-[3px] w-full overflow-hidden rounded-full bg-hover">
            <div
              className="h-full rounded-full bg-accent transition-[width]"
              style={{
                width: `${Math.max(2, Math.min(100, fs?.completion ?? 0))}%`,
              }}
            />
          </div>
        )}

        <div className="mt-auto flex items-center justify-between gap-2">
          <Avatars
            members={members}
            overflow={overflow}
            onlineCount={onlineCount}
          />
          <span className="shrink-0 text-[11px] text-fg-faint">
            {(() => {
              // Prefer lastSeqChanged — the moment the index recorded
              // an actual edit. stateChanged is the wrong signal here
              // because the daemon's periodic rescans bump it even
              // when nothing in the folder actually changed.
              const t =
                fs?.lastSeqChanged ?? fs?.stateChanged ?? stat?.stateChanged;
              return t ? `edited ${humanRelative(t)}` : "—";
            })()}
          </span>
        </div>
      </div>
    </div>
  );
}

// SecondaryLine: replaces the old "N files · M MiB" stat row. The
// active sync state always wins (rate is the most useful number when
// transfers are in flight); when idle we prefer the media-aware
// runtime/resolution if the indexer has cached enough samples,
// falling back to peer presence so empty / new projects still have
// something meaningful to say.
function SecondaryLine({
  isSyncing,
  rateBps,
  connectedDevices,
  totalDevices,
  media,
}: {
  isSyncing: boolean;
  rateBps: number;
  connectedDevices: number;
  totalDevices: number;
  media: { totalDurationSec: number; indexedCount: number; resolution: string | null };
}) {
  if (isSyncing && isActiveRate(rateBps)) {
    return <>Transferring at {humanRate(rateBps)}</>;
  }
  if (media.totalDurationSec > 0 && media.indexedCount > 0) {
    const clips = `${media.indexedCount} clip${media.indexedCount === 1 ? "" : "s"}`;
    const runtime = humanHours(media.totalDurationSec);
    const res = media.resolution && media.resolution !== "Mixed" ? ` · ${media.resolution}` : "";
    return (
      <>
        {runtime} · {clips}
        {res}
      </>
    );
  }
  if (totalDevices <= 1) {
    return <>Only on this computer</>;
  }
  return (
    <>
      Up to date on {connectedDevices} of {totalDevices} computers
    </>
  );
}

function Avatars({
  members,
  overflow,
  onlineCount,
}: {
  members: ProjectMember[];
  overflow: number;
  onlineCount: number;
}) {
  if (members.length === 0) {
    return <span className="text-[11px] text-fg-faint">No collaborators</span>;
  }
  return (
    <div className="flex items-center gap-2">
      <div className="flex -space-x-2">
        {members.slice(0, MAX_AVATARS).map((m) => (
          <span key={m.id} title={m.label} className="ring-2 ring-elevated rounded-full">
            <PresenceAvatar label={m.label} state={m.state} />
          </span>
        ))}
        {overflow > 0 && (
          <span
            className="flex h-8 w-8 items-center justify-center rounded-full bg-hover text-[10px] font-medium text-fg-soft ring-2 ring-elevated"
            aria-label={`${overflow} more`}
            title={`${overflow} more`}
          >
            +{overflow}
          </span>
        )}
      </div>
      {onlineCount > 0 && (
        <span className="flex items-center gap-1 text-[11px] text-emerald-300">
          <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" aria-hidden />
          {onlineCount} online
        </span>
      )}
    </div>
  );
}

// StatusPill: glassy badge on the cover. When syncing with a live
// rate we append the throughput so the pill becomes the "real" thing
// to look at (replacing the old static progress bar).
function StatusPill({
  view,
  rateBps,
}: {
  view: { state: "ready" | "syncing" | "paused" | "error" | "offline"; label: string };
  rateBps: number | null;
}) {
  const tone =
    view.state === "syncing"
      ? "text-white"
      : view.state === "error"
        ? "text-rose-200"
        : view.state === "paused"
          ? "text-amber-200"
          : view.state === "offline"
            ? "text-slate-200"
            : "text-emerald-300";
  const dot =
    view.state === "syncing"
      ? "bg-indigo-400 animate-pulse"
      : view.state === "error"
        ? "bg-rose-400"
        : view.state === "paused"
          ? "bg-amber-300"
          : view.state === "offline"
            ? "bg-slate-300"
            : "bg-emerald-400";
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full bg-black/55 px-2.5 py-1 text-[11px] font-medium backdrop-blur-sm",
        tone,
      )}
    >
      <span className={cn("h-1.5 w-1.5 rounded-full", dot)} aria-hidden />
      {view.label}
      {rateBps !== null && (
        <>
          <span className="opacity-60">·</span>
          <span className="font-mono">{humanRate(rateBps)}</span>
        </>
      )}
    </span>
  );
}

// OriginTag: the OWNED / SHARED chip in the top-right of the cover.
// Replaces the old in-body OriginBadge so the title row stays clean.
function OriginTag({ isOwned }: { isOwned: boolean }) {
  return (
    <span
      className={cn(
        "rounded px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide backdrop-blur-sm",
        isOwned
          ? "bg-accent/25 text-accent-fg ring-1 ring-accent/40"
          : "bg-white/10 text-slate-100 ring-1 ring-white/20",
      )}
    >
      {isOwned ? "Owned" : "Shared"}
    </span>
  );
}

// CardIconButton: small glassy icon button used in the card overlay.
// stopPropagation keeps a click from bubbling up to the card's onOpen
// — without it, every action would also navigate to the detail page.
function CardIconButton({
  children,
  ariaLabel,
  onClick,
  tone = "default",
}: {
  children: React.ReactNode;
  ariaLabel: string;
  onClick: () => void;
  tone?: "default" | "danger";
}) {
  const cls =
    tone === "danger"
      ? "bg-rose-500/20 text-rose-100 ring-rose-400/30 hover:bg-rose-500/40"
      : "bg-black/40 text-white ring-white/10 hover:bg-black/60";
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") e.stopPropagation();
      }}
      aria-label={ariaLabel}
      title={ariaLabel}
      className={cn(
        "flex h-7 w-7 items-center justify-center rounded-md ring-1 backdrop-blur-sm transition-colors",
        cls,
      )}
    >
      {children}
    </button>
  );
}

// --- icons ---

function EditIcon() {
  return (
    <svg viewBox="0 0 20 20" fill="currentColor" className="h-3.5 w-3.5" aria-hidden>
      <path d="M13.586 3.586a2 2 0 1 1 2.828 2.828l-9 9a1 1 0 0 1-.39.242l-4 1.5a1 1 0 0 1-1.272-1.272l1.5-4a1 1 0 0 1 .242-.39l9-9z" />
    </svg>
  );
}

function InviteIcon() {
  return (
    <svg viewBox="0 0 20 20" fill="currentColor" className="h-3.5 w-3.5" aria-hidden>
      <path d="M9 6a3 3 0 1 1-6 0 3 3 0 0 1 6 0zM17 11h-2V9a1 1 0 1 0-2 0v2h-2a1 1 0 1 0 0 2h2v2a1 1 0 1 0 2 0v-2h2a1 1 0 1 0 0-2zM2 18a4 4 0 0 1 8 0v1H2v-1z" />
    </svg>
  );
}

function PlayIcon() {
  return (
    <svg viewBox="0 0 20 20" fill="currentColor" className="h-3.5 w-3.5" aria-hidden>
      <path d="M5 4.5v11l10-5.5L5 4.5z" />
    </svg>
  );
}

function PauseIcon() {
  return (
    <svg viewBox="0 0 20 20" fill="currentColor" className="h-3.5 w-3.5" aria-hidden>
      <path d="M6 4h3v12H6V4zm5 0h3v12h-3V4z" />
    </svg>
  );
}

function TrashIcon() {
  return (
    <svg viewBox="0 0 20 20" fill="currentColor" className="h-3.5 w-3.5" aria-hidden>
      <path
        fillRule="evenodd"
        d="M8 3a1 1 0 0 0-1 1v1H4a1 1 0 0 0 0 2h12a1 1 0 1 0 0-2h-3V4a1 1 0 0 0-1-1H8zm6 6H6l.86 8.572A2 2 0 0 0 8.853 19h2.294a2 2 0 0 0 1.993-1.428L14 9z"
        clipRule="evenodd"
      />
    </svg>
  );
}

function LeaveIcon() {
  return (
    <svg viewBox="0 0 20 20" fill="currentColor" className="h-3.5 w-3.5" aria-hidden>
      <path
        fillRule="evenodd"
        d="M3 4a1 1 0 0 1 1-1h6a1 1 0 1 1 0 2H5v10h5a1 1 0 1 1 0 2H4a1 1 0 0 1-1-1V4zm10.293 2.293a1 1 0 0 1 1.414 0l3 3a1 1 0 0 1 0 1.414l-3 3a1 1 0 0 1-1.414-1.414L14.586 11H8a1 1 0 1 1 0-2h6.586l-1.293-1.293a1 1 0 0 1 0-1.414z"
        clipRule="evenodd"
      />
    </svg>
  );
}
