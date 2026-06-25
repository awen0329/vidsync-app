import { useEffect, useMemo, useState } from "react";
import { useConfig, useFolderStatus, usePatchFolder, useSystemStatus } from "../api/hooks";
import { bc } from "../lib/breadcrumb";
import { useAllFolderStates, useAllPeerStates, useFolderState } from "../realtime/hooks";
import { useAcceptedSince } from "../api/cloud/hooks";
import { useProjectQuota } from "../api/cloud/useProjectQuota";
import { origins, type Origin } from "../api/origins";
import { ProjectCard, type ProjectMember } from "../components/ProjectCard";
import { DropboxGlyph } from "../components/DropboxGlyph";
import {
  useProjectBackup,
  type ProjectBackup,
} from "../components/useProjectBackup";
import { ProjectCover } from "../components/ProjectCover";
import { PresenceAvatar, type PresenceState } from "../components/PresenceAvatar";
import { Button } from "../components/Button";
import { CreateProjectAction } from "../components/CreateProjectAction";
import { humanRelative } from "../lib/format";
import { humanStateLabel } from "../lib/projectState";
import { cn } from "../lib/utils";
import type { FolderConfiguration } from "../api/types";
import type { ProjectModal } from "../App";

// Unified Projects page. Replaces the old Dashboard + YourProjects +
// InvitedProjects split. Projects are filtered by *origin* (mine /
// shared with me) via a chip group, and archived projects are an
// explicit fourth chip rather than a hidden toggle. The user opens a
// project by clicking its card; the parent navigates to ProjectDetail
// via the `onOpen` callback.

type OriginFilter = "all" | "owned" | "invited";

interface OriginChip {
  value: OriginFilter;
  label: string;
}

const CHIPS: OriginChip[] = [
  { value: "all", label: "All" },
  { value: "owned", label: "Owned" },
  { value: "invited", label: "Invited" },
];

type SortKey = "recent" | "name" | "completion";
type ViewMode = "list" | "grid";

export function Projects({
  onOpen,
  onCreate,
  onOpenBilling,
}: {
  // modal is set when the user clicked a card-level action icon
  // (Edit / Invite / Delete) — ProjectDetail then opens the matching
  // modal on mount.
  onOpen: (folderID: string, modal?: ProjectModal) => void;
  onCreate: () => void;
  // Undefined when auth is disabled (no Billing destination).
  onOpenBilling?: () => void;
}) {
  const cfg = useConfig();
  const sys = useSystemStatus();
  const folderStates = useAllFolderStates();
  const peers = useAllPeerStates();
  const quota = useProjectQuota();
  // Pull every accepted invite once. We use the resulting map to give
  // each remote device a person-shaped label (recipientName ▸
  // recipientEmail) on the card's avatar stack. Without this we'd
  // fall back to the device's hostname, which violates the
  // never-show-raw-device-IDs guidance for shared projects.
  const accepted = useAcceptedSince(null);

  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<SortKey>("recent");
  const [originFilter, setOriginFilter] = useState<OriginFilter>("all");
  const [view, setView] = useState<ViewMode>("list");

  useEffect(() => {
    bc(`Projects mount folders=${cfg.data?.folders.length ?? 0}`);
    return () => {
      bc("Projects unmount");
    };
    // We intentionally read folders count only on first mount; the
    // breadcrumb is a one-shot signal, not a live counter.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const folders = cfg.data?.folders ?? [];
  const myID = sys.data?.myID ?? "";

  // Build label resolver once per cfg/accepted change. Priority order:
  // (1) cloud recipient name, (2) cloud recipient email, (3) device
  // hostname from the daemon's known-devices list.
  const labelByDevice = useMemo(() => {
    const map = new Map<string, string>();
    for (const d of cfg.data?.devices ?? []) {
      if (d.name) map.set(d.deviceID, d.name);
    }
    for (const inv of accepted.data?.invitations ?? []) {
      if (!inv.recipientDeviceId) continue;
      const friendly = inv.recipientName || inv.recipientEmail;
      if (friendly) map.set(inv.recipientDeviceId, friendly);
    }
    return map;
  }, [cfg.data?.devices, accepted.data?.invitations]);

  const presenceFor = (deviceID: string): PresenceState => {
    const p = peers[deviceID];
    if (!p) return "offline";
    if (p.paused || !p.connected) return "offline";
    return "online";
  };

  const membersByFolder = useMemo(() => {
    const m = new Map<string, ProjectMember[]>();
    for (const f of folders) {
      const list: ProjectMember[] = [];
      for (const d of f.devices) {
        if (d.deviceID === myID) continue;
        list.push({
          id: d.deviceID,
          label: labelByDevice.get(d.deviceID) || "Unnamed device",
          state: presenceFor(d.deviceID),
        });
      }
      m.set(f.id, list);
    }
    return m;
  }, [folders, myID, labelByDevice, peers]);

  const filtered = useMemo(() => {
    let out = folders.slice();
    if (originFilter !== "all") {
      out = out.filter((f) => origins.get(f.id) === originFilter);
    }
    const q = search.trim().toLowerCase();
    if (q) {
      out = out.filter(
        (f) =>
          (f.label || f.id).toLowerCase().includes(q) ||
          f.path.toLowerCase().includes(q),
      );
    }
    out.sort((a, b) => {
      if (sort === "name") {
        return (a.label || a.id).localeCompare(b.label || b.id);
      }
      if (sort === "completion") {
        const ca = folderStates[a.id]?.completion ?? 0;
        const cb = folderStates[b.id]?.completion ?? 0;
        return cb - ca;
      }
      // recent: by stateChanged DESC
      const ta = folderStates[a.id]?.stateChanged ?? "";
      const tb = folderStates[b.id]?.stateChanged ?? "";
      return tb.localeCompare(ta);
    });
    return out;
  }, [folders, folderStates, search, sort, originFilter]);

  return (
    <div className="mx-auto h-full max-w-7xl overflow-y-auto px-8 py-10">
      <header className="mb-8 flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-3xl font-semibold tracking-tight text-fg-strong">
            Projects
          </h1>
          <p className="mt-1 text-sm text-fg-soft">
            {folders.length} project{folders.length === 1 ? "" : "s"}
          </p>
        </div>
        <CreateProjectAction
          quota={quota}
          onCreate={onCreate}
          onOpenPricing={onOpenBilling}
        />
      </header>

      <div className="mb-6 flex flex-wrap items-center gap-3">
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search projects…"
          className="min-w-[220px] flex-1 rounded-lg border border-line bg-panel px-3 py-2 text-sm text-fg-strong placeholder:text-fg-faint focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent"
        />
        <OriginChips value={originFilter} onChange={setOriginFilter} />
        <select
          value={sort}
          onChange={(e) => setSort(e.target.value as SortKey)}
          className="rounded-lg border border-line bg-panel px-3 py-2 text-sm text-fg-strong focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent"
        >
          <option value="recent">Recent activity</option>
          <option value="name">Name (A–Z)</option>
          <option value="completion">Progress</option>
        </select>
        <div className="inline-flex rounded-lg bg-panel p-0.5 ring-1 ring-line">
          <ViewToggle
            active={view === "list"}
            onClick={() => setView("list")}
            label="List"
            icon={<ListIcon />}
          />
          <ViewToggle
            active={view === "grid"}
            onClick={() => setView("grid")}
            label="Grid"
            icon={<GridIcon />}
          />
        </div>
      </div>

      {filtered.length === 0 ? (
        <EmptyState
          onCreate={onCreate}
          hasSearch={search.length > 0}
          filter={originFilter}
        />
      ) : view === "grid" ? (
        <div className="grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {filtered.map((f) => (
            <ProjectCard
              key={f.id}
              folder={f}
              origin={origins.get(f.id)}
              members={membersByFolder.get(f.id) ?? []}
              deviceID={myID}
              onOpen={() => onOpen(f.id)}
              onAction={(modal) => onOpen(f.id, modal)}
            />
          ))}
        </div>
      ) : (
        <ul className="divide-y divide-line overflow-hidden rounded-xl border border-line bg-elevated">
          {filtered.map((f) => (
            <ProjectListRow
              key={f.id}
              folder={f}
              origin={origins.get(f.id)}
              members={membersByFolder.get(f.id) ?? []}
              deviceID={myID}
              onOpen={() => onOpen(f.id)}
              onAction={(modal) => onOpen(f.id, modal)}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

const MAX_ROW_AVATARS = 3;

// ProjectListRow: compact one-line tile used by the list view. Mirrors
// the data shown on the card (cover thumb, label, status, members,
// last edited) and exposes the same per-project actions
// (edit/invite/pause/delete) at the row's trailing edge so the user
// doesn't have to open the project just to invite a teammate or
// pause sync. Owned projects get the full four icons; shared
// projects get pause + leave only — matching ProjectCard's gating.
function ProjectListRow({
  folder,
  origin,
  members,
  deviceID,
  onOpen,
  onAction,
}: {
  folder: FolderConfiguration;
  origin: Origin;
  members: ProjectMember[];
  deviceID: string;
  onOpen: () => void;
  onAction: (modal: ProjectModal) => void;
}) {
  const fs = useFolderState(folder.id);
  // /db/status fallback keeps the row honest when the realtime store
  // hasn't seen a FolderSummary yet (same fallback used by ProjectCard).
  const status = useFolderStatus(folder.id);
  const stat = status.data;
  const patch = usePatchFolder();
  const view = humanStateLabel(fs?.state ?? stat?.state, folder.paused);
  // lastSeqChanged is "last real index change" (file added/modified/removed).
  // stateChanged also bumps for periodic rescans that found nothing, so
  // it would make the "edited" label creep on idle projects.
  const lastUpdated =
    fs?.lastSeqChanged ?? fs?.stateChanged ?? stat?.stateChanged;
  const onlineCount = members.filter((m) => m.state === "online").length;
  const overflow = Math.max(0, members.length - MAX_ROW_AVATARS);
  const isOwned = origin === "owned";
  const backup = useProjectBackup(folder.id, folder.path, deviceID, isOwned);

  const togglePause = () =>
    patch.mutate({
      id: folder.id,
      patch: { paused: !folder.paused },
    });

  return (
    <li>
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
        className="flex w-full cursor-pointer items-center gap-4 px-4 py-3 text-left transition-colors hover:bg-hover focus:bg-hover focus:outline-none"
      >
        <ProjectCover
          folderID={folder.id}
          className="h-12 w-20 shrink-0 rounded-md"
        />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate text-sm font-medium text-fg-strong">
              {folder.label || folder.id}
            </span>
            <RowOriginTag isOwned={isOwned} />
          </div>
          <div className="mt-0.5 truncate text-xs text-fg-soft" title={folder.path}>
            {folder.path}
          </div>
        </div>
        <RowStatusPill view={view} />
        <RowAvatars
          members={members}
          overflow={overflow}
          onlineCount={onlineCount}
        />
        <span className="hidden w-28 shrink-0 text-right text-xs text-fg-faint md:inline">
          {lastUpdated ? `edited ${humanRelative(lastUpdated)}` : "—"}
        </span>
        <RowActions
          isOwned={isOwned}
          paused={folder.paused}
          backup={backup}
          onEdit={() => onAction("edit")}
          onInvite={() => onAction("invite")}
          onTogglePause={togglePause}
          onDelete={() => onAction("delete")}
        />
      </div>
    </li>
  );
}

// RowActions: trailing-edge toolbar with the same per-project actions
// the grid card exposes. Always visible (the list has horizontal room
// the card overlay didn't), and each button stopPropagation's so the
// click doesn't bubble up to the row's onOpen.
function RowActions({
  isOwned,
  paused,
  backup,
  onEdit,
  onInvite,
  onTogglePause,
  onDelete,
}: {
  isOwned: boolean;
  paused: boolean;
  backup: ProjectBackup;
  onEdit: () => void;
  onInvite: () => void;
  onTogglePause: () => void;
  onDelete: () => void;
}) {
  return (
    <div className="flex shrink-0 items-center gap-1">
      {isOwned && (
        <>
          <RowIconButton ariaLabel="Edit project" onClick={onEdit}>
            <EditIcon />
          </RowIconButton>
          {backup.available && (
            <RowIconButton
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
                  backup.enabled && "text-emerald-400",
                )}
              />
            </RowIconButton>
          )}
          <RowIconButton ariaLabel="Invite collaborator" onClick={onInvite}>
            <InviteIcon />
          </RowIconButton>
        </>
      )}
      <RowIconButton
        ariaLabel={paused ? "Resume project" : "Pause project"}
        onClick={onTogglePause}
      >
        {paused ? <PlayIcon /> : <PauseIcon />}
      </RowIconButton>
      <RowIconButton
        tone="danger"
        ariaLabel={isOwned ? "Delete project" : "Leave project"}
        onClick={onDelete}
      >
        {isOwned ? <TrashIcon /> : <LeaveIcon />}
      </RowIconButton>
    </div>
  );
}

function RowIconButton({
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
      ? "text-rose-300 hover:bg-rose-500/15 hover:text-rose-200"
      : "text-fg-soft hover:bg-hover hover:text-fg-strong";
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
        "flex h-7 w-7 items-center justify-center rounded-md transition-colors",
        cls,
      )}
    >
      {children}
    </button>
  );
}

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

function RowStatusPill({
  view,
}: {
  view: { state: "ready" | "syncing" | "paused" | "error" | "offline"; label: string };
}) {
  const tone =
    view.state === "syncing"
      ? "bg-indigo-500/15 text-indigo-200"
      : view.state === "error"
        ? "bg-rose-500/15 text-rose-200"
        : view.state === "paused"
          ? "bg-amber-500/15 text-amber-200"
          : view.state === "offline"
            ? "bg-fg-faint/15 text-fg-soft"
            : "bg-emerald-500/15 text-emerald-200";
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
        "hidden shrink-0 items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-medium sm:inline-flex",
        tone,
      )}
    >
      <span className={cn("h-1.5 w-1.5 rounded-full", dot)} aria-hidden />
      {view.label}
    </span>
  );
}

function RowAvatars({
  members,
  overflow,
  onlineCount,
}: {
  members: ProjectMember[];
  overflow: number;
  onlineCount: number;
}) {
  if (members.length === 0) {
    return (
      <span className="hidden shrink-0 text-[11px] text-fg-faint lg:inline">
        Solo
      </span>
    );
  }
  return (
    <div className="hidden shrink-0 items-center gap-2 lg:flex">
      <div className="flex -space-x-2">
        {members.slice(0, MAX_ROW_AVATARS).map((m) => (
          <span
            key={m.id}
            title={m.label}
            className="rounded-full ring-2 ring-elevated"
          >
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
          <span
            className="h-1.5 w-1.5 rounded-full bg-emerald-400"
            aria-hidden
          />
          {onlineCount}
        </span>
      )}
    </div>
  );
}

function RowOriginTag({ isOwned }: { isOwned: boolean }) {
  return (
    <span
      className={cn(
        "shrink-0 rounded px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide",
        isOwned
          ? "bg-accent/15 text-accent"
          : "bg-fg-faint/15 text-fg-soft",
      )}
    >
      {isOwned ? "Owned" : "Shared"}
    </span>
  );
}

function ViewToggle({
  active,
  onClick,
  label,
  icon,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  icon: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={label}
      aria-label={label}
      className={cn(
        "flex h-7 w-7 items-center justify-center rounded-md transition-colors",
        active
          ? "bg-accent/15 text-accent"
          : "text-fg-soft hover:text-fg-strong",
      )}
    >
      {icon}
    </button>
  );
}

function GridIcon() {
  return (
    <svg
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="h-4 w-4"
      aria-hidden
    >
      <rect x="3" y="3" width="6" height="6" rx="1" />
      <rect x="11" y="3" width="6" height="6" rx="1" />
      <rect x="3" y="11" width="6" height="6" rx="1" />
      <rect x="11" y="11" width="6" height="6" rx="1" />
    </svg>
  );
}

function ListIcon() {
  return (
    <svg
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="h-4 w-4"
      aria-hidden
    >
      <path d="M5 5h12M5 10h12M5 15h12" />
    </svg>
  );
}

function OriginChips({
  value,
  onChange,
}: {
  value: OriginFilter;
  onChange: (v: OriginFilter) => void;
}) {
  return (
    <div className="inline-flex rounded-lg bg-panel p-0.5 ring-1 ring-line">
      {CHIPS.map((c) => (
        <button
          key={c.value}
          type="button"
          onClick={() => onChange(c.value)}
          className={
            "rounded-md px-3 py-1.5 text-xs font-medium transition-colors " +
            (c.value === value
              ? "bg-accent/15 text-accent"
              : "text-fg-soft hover:text-fg-strong")
          }
        >
          {c.label}
        </button>
      ))}
    </div>
  );
}

function EmptyState({
  onCreate,
  hasSearch,
  filter,
}: {
  onCreate: () => void;
  hasSearch: boolean;
  filter: OriginFilter;
}) {
  if (hasSearch) {
    return (
      <div className="rounded-xl border border-dashed border-line-strong px-6 py-16 text-center">
        <p className="text-sm text-fg-soft">No projects match your search.</p>
      </div>
    );
  }
  if (filter === "invited") {
    return (
      <div className="rounded-xl border border-dashed border-line-strong px-6 py-16 text-center">
        <p className="text-sm text-fg-soft">
          No one has shared a project with you yet.
        </p>
      </div>
    );
  }
  return (
    <div className="rounded-xl border border-dashed border-line-strong bg-elevated/40 px-6 py-20 text-center">
      <h2 className="text-xl font-semibold tracking-tight text-fg-strong">
        Start your first project
      </h2>
      <p className="mx-auto mt-2 max-w-md text-sm text-fg-soft">
        A project is a folder of footage you sync directly with
        collaborators — no cloud storage, no upload caps.
      </p>
      <div className="mt-6 flex justify-center">
        <Button variant="primary" onClick={onCreate}>
          Create a project
        </Button>
      </div>
    </div>
  );
}
