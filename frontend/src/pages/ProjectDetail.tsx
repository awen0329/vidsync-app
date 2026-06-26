import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { AUTH_ENABLED } from "../App";
import { Modal } from "../components/Modal";
import { Button } from "../components/Button";
import { FolderPicker } from "../components/FolderPicker";
import { PeerStatus } from "../components/PeerStatus";
import { PresenceAvatar } from "../components/PresenceAvatar";
import { MembersHeader } from "../components/MembersHeader";
import { ConflictsBanner } from "../components/ConflictsBanner";
import { ErrorsBanner } from "../components/ErrorsBanner";
import { LocalChangesBanner } from "../components/LocalChangesBanner";
import { ActivityFeed } from "../components/ActivityFeed";
import { FileGrid, type ProjectMemberSummary } from "../components/FileGrid";
import { LazyVideoReviewPanel } from "../components/LazyVideoReviewPanel";
import type { VideoPreviewFile } from "../components/VideoPreviewModal";
import { DropboxModal } from "../components/DropboxModal";
import { BackupCard } from "../components/BackupCard";
import { dropboxAvailable } from "../lib/dropbox";
import { isNativeDialogAvailable, pickFolder } from "../lib/folderDialog";
import {
  queryKeys,
  useConfig,
  useConnections,
  useDeleteFolder,
  useFolderErrors,
  useFolderStatus,
  usePatchFolder,
  usePutFolder,
  useSystemStatus,
  useResyncFolder,
} from "../api/hooks";
import { APIError, client } from "../api/client";
import { useAllPeerStates, useFolderState } from "../realtime/hooks";
import {
  useAccountEmail,
  useCreateInvitation,
  useFolderInvitations,
  useLeaveInvitation,
  useMyAcceptedForFolder,
  useProjectMembers,
  useRevokeInvitation,
} from "../api/cloud/hooks";
import { CloudAPIError, type CloudInvitation } from "../api/cloud/client";
import { useCloudClient } from "../api/cloud/provider";
import {
  forgetAcceptedInvitation,
  lookupAcceptedInvitation,
} from "../api/cloud/acceptedInvitations";
import { origins } from "../api/origins";
import { humanBytes, humanizeFolderError, humanRelative } from "../lib/format";
import { useThumbnailIndexer } from "../lib/useThumbnailIndexer";
import { bc } from "../lib/breadcrumb";
import { cn } from "../lib/utils";
import type { Configuration, FolderConfiguration } from "../api/types";

// ProjectDetail: full-width detail page for a single project. Built
// around a cinematic hero (collage of cached video thumbs), a stats
// row, action toolbar, and a Files / Team / Activity tab strip. The
// list of projects lives on the Projects page; users come here by
// clicking a card and return via the back chevron in the hero.
//
// Owned vs invited projects render the same chrome; only the action
// buttons differ (you can't edit / invite / delete a project someone
// else owns). Origin is read from origins.get(folderID).

type ProjectTab = "files" | "team" | "activity";

// initialModal lets the caller deep-link into a specific modal on
// mount — used by the Projects-page card icons so clicking "Edit" on a
// card lands the user inside the Edit dialog instead of just the detail
// view. The hint is consumed once on mount via Body's useEffect.
export type ProjectInitialModal = "edit" | "invite" | "delete";

export function ProjectDetail({
  folderID,
  onBack,
  initialModal,
  navPath,
  navPreview,
  navSeq,
  projectsNav,
}: {
  folderID: string;
  onBack: () => void;
  initialModal?: ProjectInitialModal;
  // Deep-link from the persistent ProjectsNav: jump the Files browser to
  // `navPath`, or open `navPreview` in the review player. `navSeq` bumps
  // on every nav so a repeat click re-applies the same target.
  navPath?: string;
  navPreview?: VideoPreviewFile | null;
  navSeq?: number;
  // The projects navigator, rendered as the leftmost dock so the top bar
  // can span across it. Hidden by the 1st layout toggle.
  projectsNav?: React.ReactNode;
}) {
  const cfg = useConfig();
  const status = useSystemStatus();
  const myID = status.data?.myID ?? "";

  // Kick off background thumbnail capture for this project so the
  // folder collages have real previews ready, not just on demand.
  useThumbnailIndexer(folderID);

  const folder = cfg.data?.folders.find((f) => f.id === folderID) ?? null;
  const origin = origins.get(folderID);
  const isOwned = origin === "owned";

  if (!folder) {
    return (
      <div className="flex h-full items-center justify-center">
        <p className="text-sm text-fg-soft">Project not found.</p>
      </div>
    );
  }

  return (
    <div className="flex h-full w-full flex-col">
      <Body
        folder={folder}
        myID={myID}
        isOwned={isOwned}
        initialModal={initialModal}
        navPath={navPath}
        navPreview={navPreview}
        navSeq={navSeq}
        projectsNav={projectsNav}
        onBack={onBack}
      />
    </div>
  );
}

function Body({
  folder,
  myID,
  isOwned,
  initialModal,
  navPath,
  navPreview,
  navSeq,
  projectsNav,
  onBack,
}: {
  folder: FolderConfiguration;
  myID: string;
  isOwned: boolean;
  initialModal?: ProjectInitialModal;
  navPath?: string;
  navPreview?: VideoPreviewFile | null;
  navSeq?: number;
  projectsNav?: React.ReactNode;
  onBack: () => void;
}) {
  const cfg = useConfig();
  const fs = useFolderState(folder.id);
  const patch = usePatchFolder();
  const del = useDeleteFolder();
  const put = usePutFolder();
  const leaveInvite = useLeaveInvitation();
  const cloud = useCloudClient();
  const qc = useQueryClient();
  const [editing, setEditing] = useState(initialModal === "edit" && isOwned);
  const [confirmDelete, setConfirmDelete] = useState(
    initialModal === "delete",
  );
  const [inviting, setInviting] = useState(
    initialModal === "invite" && isOwned,
  );
  const [dropboxOpen, setDropboxOpen] = useState(false);
  // Both owned and invited projects open on Files — the content is
  // what users come to see; Team is a click away for owners who want it.
  const [tab, setTab] = useState<ProjectTab>("files");
  // The three top-bar layout toggles: projects sidebar / player / comments.
  const [showProjectsNav, setShowProjectsNav] = useState(true);
  const [showPlayer, setShowPlayer] = useState(true);
  const [showComments, setShowComments] = useState(true);
  // Resizable width of the file-list dock when the player sits beside it.
  const [filePanelWidth, setFilePanelWidth] = useState(440);
  // Shared navigation state for the Files tab: the FileTree (left pane)
  // and FileGrid (right pane) both read/write this so they stay in sync.
  // "" = project root. `showTree` lets the user reclaim the tree's width.
  // Seeded from the ProjectsNav deep-link (navPath) when present.
  const [filesPath, setFilesPath] = useState(navPath ?? "");
  // The video currently open in the inline review player (shared so both
  // the navigator and the grid can open / switch it). null = browsing files.
  const [preview, setPreview] = useState<VideoPreviewFile | null>(
    navPreview ?? null,
  );

  // Re-apply a ProjectsNav deep-link whenever it changes. We key the
  // effect on navSeq alone (it bumps on every nav) so clicking the same
  // folder twice still re-applies — reading navPath/navPreview off the
  // latest render is intentional, hence the exhaustive-deps suppression.
  useEffect(() => {
    if (navSeq === undefined) return;
    setTab("files");
    setFilesPath(navPath ?? "");
    setPreview(navPreview ?? null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [navSeq]);
  // Folder navigation closes any open player and shows the grid at that
  // directory; opening a video is a separate path via openPreview.
  const navigate = (path: string) => {
    setPreview(null);
    setFilesPath(path);
  };
  // Opening a file in the player also moves the browse location to that
  // file's folder, so the tree highlights the file's parent — any folder the
  // user had previously selected/navigated deselects rather than staying
  // highlighted, and closing the player returns to the file's folder. Called
  // with null to close the player (the grid then shows the same folder).
  const openPreview = (file: VideoPreviewFile | null) => {
    if (file) {
      const slash = file.path.lastIndexOf("/");
      setFilesPath(slash >= 0 ? file.path.slice(0, slash) : "");
    }
    setPreview(file);
  };
  // Trace lifecycle of this project page so we can read the log
  // after a crash and see exactly which folder was open + when it
  // was mounted/unmounted relative to the last user interaction.
  useEffect(() => {
    bc(`ProjectDetail mount folder=${folder.id}`);
    return () => {
      bc(`ProjectDetail unmount folder=${folder.id}`);
    };
  }, [folder.id]);

  // Nudge the daemon to scan periodically while this page is open so
  // marker-/path-missing errors surface within seconds instead of
  // waiting for the hourly rescan. The watcher silently drops events
  // for the .vidsync marker directory (it's in the daemon's internals
  // list), so otherwise a user who deletes/moves the project folder
  // gets no UI signal until the next scheduled scan.
  useEffect(() => {
    if (!folder.id) return;
    let cancelled = false;
    const ping = () => {
      if (cancelled) return;
      client.scanFolder(folder.id).catch(() => {
        // Daemon may be paused or briefly unavailable — non-fatal.
      });
    };
    ping();
    const t = setInterval(ping, 30_000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [folder.id]);

  const allDevices = cfg.data?.devices ?? [];
  const members = folder.devices.filter((d) => d.deviceID !== myID);
  const peers = useAllPeerStates();

  // The realtime store only sees a folder once the daemon emits a
  // FolderSummary event for it. On a settled folder the daemon may
  // have already flushed any recent summary out of its event buffer
  // before we connected, so `fs` is undefined until something
  // changes. /rest/db/status returns the same fields directly and
  // is polled by useFolderStatus, so we use it as the fallback —
  // realtime data still wins when it's present.
  const status = useFolderStatus(folder.id);
  const stat = status.data;
  // Project size — still needed for the invite modal's quota math even
  // though the slim header no longer surfaces the per-state counters the
  // old hero did.
  const globalBytes = fs?.globalBytes ?? stat?.globalBytes ?? 0;
  // Activity-tab error indicator combines all three kinds of trouble
  // the daemon can report on a folder. Without this aggregate the
  // badge would only pulse for per-file pull errors and miss the
  // bigger ones — "folder marker missing", "user added files in a
  // receive-only folder", etc.
  const pullErrors = fs?.errors ?? stat?.errors ?? 0;
  // Prefer the REST status payload for error fields — it refreshes
  // on a 5 s poll + on Resync invalidation, while the realtime store
  // can hold stale values when the daemon doesn't emit a fresh
  // FolderSummary on state transition.
  //
  // Marker- and path-missing are excluded from the "has error" count
  // so the Activity tab doesn't grow a red "1" badge — the Resync
  // button next to the tab strip is the one signal we want users to
  // see for those states.
  const rawErrorMsg = (stat?.error || fs?.error || "").toLowerCase();
  const isRecoverableStateError =
    rawErrorMsg.includes("folder marker missing") ||
    rawErrorMsg.includes("folder path missing");
  const hasStateError =
    (!!(stat?.error || fs?.error) && !isRecoverableStateError) ||
    !!(stat?.watchError || fs?.watchError);
  // Sum receive-only edits + deletes — both count as "local changes"
  // the user needs to Override or Revert.
  const roChanged =
    (fs?.receiveOnlyChangedFiles ?? stat?.receiveOnlyChangedFiles ?? 0) +
    (fs?.receiveOnlyChangedDeletes ?? stat?.receiveOnlyChangedDeletes ?? 0);
  const errorCount =
    pullErrors + (hasStateError ? 1 : 0) + (roChanged > 0 ? 1 : 0);
  const isOwnedLabel = isOwned ? "Owned" : "Shared";
  const editors = members.length + 1;
  const statusView = humanStateLabelForHero(
    fs?.state,
    folder.paused,
    fs?.completion,
  );
  // Collaborator avatars for the file toolbar's member stack. Labels come
  // from the daemon's known-devices list; presence from the peer states.
  const memberAvatars: ProjectMemberSummary[] = members.map((m) => {
    const p = peers[m.deviceID];
    const online = !!p && p.connected && !p.paused;
    return {
      id: m.deviceID,
      label: allDevices.find((d) => d.deviceID === m.deviceID)?.name || "Member",
      state: online ? "online" : "offline",
    };
  });
  const lastUpdated =
    fs?.lastSeqChanged ?? fs?.stateChanged ?? stat?.stateChanged;

  // Player dock open ⇢ a clip is selected, on the Files view, and the
  // player toggle is on. When open, the file panel becomes a fixed,
  // resizable width and the player fills the rest.
  const playerOpen = tab === "files" && !!preview && showPlayer;
  const startFilePanelResize = (e: React.PointerEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = filePanelWidth;
    const onMove = (ev: PointerEvent) => {
      const next = Math.min(720, Math.max(280, startW + (ev.clientX - startX)));
      setFilePanelWidth(next);
    };
    const onUp = () => {
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", onUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", onUp);
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
  };

  const DOCK = "rounded-xl border border-line bg-panel";

  return (
    <div className="flex h-full min-h-0 flex-col gap-1.5">
      {/* Top bar — one dock spanning across the projects sidebar + the
          content docks. Breadcrumb on the left; project info, actions, and
          the three layout toggles on the right. */}
      <div className={cn(DOCK, "flex shrink-0 items-center gap-2 px-2.5 py-1.5")}>
        <button
          type="button"
          onClick={() => navigate("")}
          className="flex shrink-0 items-center gap-2 rounded-md px-1.5 py-1 transition-colors hover:bg-hover"
          title={folder.label || folder.id}
        >
          <span className="flex h-6 w-6 items-center justify-center rounded-md bg-elevated text-fg-soft">
            <FolderGlyph />
          </span>
          <span className="max-w-[180px] truncate text-sm font-semibold text-fg-strong">
            {folder.label || folder.id}
          </span>
        </button>
        <TopBreadcrumb
          path={tab === "files" ? filesPath : ""}
          onNavigate={(p) => {
            setTab("files");
            navigate(p);
          }}
        />

        <div className="ml-auto flex shrink-0 items-center gap-1.5">
          <span className="hidden items-center gap-1.5 rounded-full bg-elevated px-2.5 py-1 text-[11px] font-medium ring-1 ring-line md:inline-flex">
            <span className={cn("h-1.5 w-1.5 rounded-full", statusView.dot)} aria-hidden />
            <span className={statusView.text}>{statusView.label}</span>
          </span>
          <span className="hidden text-[11px] text-fg-soft xl:inline">
            {humanBytes(globalBytes)}
          </span>
          {lastUpdated && (
            <span className="hidden text-[11px] text-fg-faint xl:inline">
              · synced {humanRelative(lastUpdated)}
            </span>
          )}
          <span className="hidden rounded px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-fg-soft ring-1 ring-line lg:inline">
            {isOwnedLabel}
          </span>
          <TabActions
            folderID={folder.id}
            errorCount={errorCount}
            onOpenActivity={() => setTab("activity")}
          />
          <div className="mx-0.5 h-5 w-px bg-line" />
          <button
            type="button"
            onClick={() => setTab("activity")}
            title="Activity"
            aria-label="Activity"
            className={cn(
              "flex h-8 w-8 items-center justify-center rounded-lg transition-colors",
              tab === "activity"
                ? "bg-accent/15 text-accent"
                : "text-fg-soft hover:bg-hover hover:text-fg-strong",
            )}
          >
            <ActivityGlyph />
          </button>
          <HeaderIconButton ariaLabel="Edit project" onClick={() => setEditing(true)}>
            <EditIcon />
          </HeaderIconButton>
          {dropboxAvailable() && (
            <HeaderIconButton
              ariaLabel="Dropbox import / export"
              onClick={() => setDropboxOpen(true)}
            >
              <DropboxIcon />
            </HeaderIconButton>
          )}
          <HeaderIconButton
            ariaLabel={folder.paused ? "Resume project" : "Pause project"}
            onClick={() =>
              patch.mutate({ id: folder.id, patch: { paused: !folder.paused } })
            }
          >
            {folder.paused ? <PlayIcon /> : <PauseIcon />}
          </HeaderIconButton>
          <HeaderIconButton
            tone="danger"
            ariaLabel={isOwned ? "Delete project" : "Leave project"}
            onClick={() => setConfirmDelete(true)}
          >
            {isOwned ? <TrashIcon /> : <LeaveIcon />}
          </HeaderIconButton>
          {isOwned && (
            <button
              type="button"
              onClick={() => setInviting(true)}
              className="inline-flex items-center gap-1.5 rounded-lg bg-accent px-3 py-1.5 text-xs font-semibold text-accent-fg shadow-sm transition-colors hover:bg-accent-hover"
            >
              <InviteIcon />
              Share
            </button>
          )}
          <div className="mx-0.5 h-5 w-px bg-line" />
          <div className="inline-flex items-center rounded-lg bg-base p-0.5 ring-1 ring-line">
            <LayoutToggle
              side="left"
              active={showProjectsNav}
              onClick={() => setShowProjectsNav((v) => !v)}
              title={showProjectsNav ? "Hide projects" : "Show projects"}
            />
            <LayoutToggle
              side="center"
              active={playerOpen}
              onClick={() => setShowPlayer((v) => !v)}
              title={showPlayer ? "Hide player" : "Show player"}
            />
            <LayoutToggle
              side="right"
              active={showComments}
              onClick={() => setShowComments((v) => !v)}
              title={showComments ? "Hide comments" : "Show comments"}
            />
          </div>
        </div>
      </div>

      <ConflictsBanner folderID={folder.id} />

      {/* Content docks row: projects sidebar · main panel · player. The
          three main views (files / team / activity) stay mounted and toggle
          via CSS (display) rather than unmount/remount — rapid Files↔Team
          flips otherwise tore down in-flight thumbnail decoders and crashed
          WebView2. */}
      <div className="flex min-h-0 flex-1 gap-1.5">
        {showProjectsNav && projectsNav}

        <div
          className={cn(DOCK, "flex min-w-0 flex-col overflow-hidden")}
          style={
            playerOpen ? { width: filePanelWidth, flexShrink: 0 } : { flex: "1 1 0%" }
          }
        >
          <div className={cn("min-h-0 flex-1", tab === "files" ? "flex flex-col" : "hidden")}>
            <FileGrid
              folderID={folder.id}
              folderPath={folder.path}
              folderType={folder.type as string}
              currentPath={filesPath}
              onNavigate={navigate}
              preview={preview}
              onPreview={openPreview}
              compact={playerOpen}
              members={memberAvatars}
              memberCount={editors}
              onOpenTeam={() => setTab("team")}
            />
          </div>
          <div
            className={cn(
              "min-h-0 flex-1 overflow-y-auto px-4 py-4",
              tab === "team" ? "block" : "hidden",
            )}
          >
            <TeamPanel
              folder={folder}
              members={members}
              allDevices={allDevices}
              isOwned={isOwned}
              myID={myID}
              onInvite={() => setInviting(true)}
              onRemove={(deviceID) => {
                const updated: FolderConfiguration = {
                  ...folder,
                  devices: folder.devices.filter((d) => d.deviceID !== deviceID),
                };
                put.mutate(updated);
              }}
            />
            <div className="pb-6 pt-2">
              <BackupCard folder={folder} isOwned={isOwned} myID={myID} />
            </div>
          </div>
          <div
            className={cn(
              "min-h-0 flex-1 overflow-y-auto px-4 py-4",
              tab === "activity" ? "block" : "hidden",
            )}
          >
            <div className="flex h-full min-h-0 flex-col gap-4">
              <LocalChangesBanner folderID={folder.id} />
              <ErrorsBanner folderID={folder.id} />
              <ActivityFeed folderID={folder.id} />
            </div>
          </div>
        </div>

        {playerOpen && (
          <div
            role="separator"
            aria-orientation="vertical"
            aria-label="Resize file panel"
            onPointerDown={startFilePanelResize}
            className="group flex w-1.5 shrink-0 cursor-col-resize items-center justify-center"
          >
            <span className="h-10 w-1 rounded-full bg-line-strong transition-colors group-hover:bg-accent" />
          </div>
        )}
        {playerOpen && (
          <div className={cn(DOCK, "flex min-w-0 flex-1 flex-col overflow-hidden")}>
            <LazyVideoReviewPanel file={preview} showComments={showComments} />
          </div>
        )}
      </div>


      <EditProjectModal
        open={editing}
        onClose={() => setEditing(false)}
        folder={folder}
        isOwned={isOwned}
      />
      {isOwned && (
        <InviteMemberModal
          open={inviting}
          onClose={() => setInviting(false)}
          folder={folder}
          myID={myID}
          folderSizeBytes={globalBytes}
        />
      )}
      <ConfirmDeleteModal
        open={confirmDelete}
        onClose={() => setConfirmDelete(false)}
        isOwned={isOwned}
        onConfirm={async () => {
          // Recipient-side: tell the cloud we're leaving so the owner's
          // bridge can drop our device from folder.devices. Best-effort
          // — if the cloud call fails we still proceed with the local
          // delete. We try the localStorage cache first; if that misses
          // (accepted on a different browser, or pre-leave-flow), fall
          // back to the by-folder lookup endpoint so users who joined
          // before this code shipped aren't stranded.
          if (!isOwned) {
            let invID = lookupAcceptedInvitation(folder.id);
            if (!invID) {
              try {
                const inv = await cloud.findMyAcceptedForFolder(folder.id);
                if (inv) invID = inv.id;
              } catch (e) {
                console.warn("lookup accepted invitation failed", e);
              }
            }
            if (invID) {
              try {
                await leaveInvite.mutateAsync(invID);
              } catch (e) {
                console.warn("leave invitation failed", e);
              }
              forgetAcceptedInvitation(folder.id);
            }
          }
          // Synchronously strip the folder from the cached
          // Configuration *before* navigating, so the Projects
          // page renders the new quota count on its very first
          // frame. useDeleteFolder's onMutate would do the same
          // thing, but Tanstack Query awaits the cancelQueries
          // call inside onMutate, leaving a microtask gap where
          // the Projects page renders with the old count — long
          // enough for users to see "1 of 1 used" + a disabled
          // CTA and report "the limit still applies after
          // removing". Writing here closes that gap entirely.
          //
          // Optimistic onMutate still runs after this and is a
          // no-op (folder already gone from cache); the
          // mutation's onError handler will roll back from its
          // own snapshot if the daemon rejects the delete.
          const id = folder.id;
          const prevCfg = qc.getQueryData<Configuration>(queryKeys.config);
          if (prevCfg) {
            qc.setQueryData<Configuration>(queryKeys.config, {
              ...prevCfg,
              folders: prevCfg.folders.filter((f) => f.id !== id),
            });
          }
          origins.delete(id);
          setConfirmDelete(false);
          onBack();
          del.mutate(id);
        }}
        folderName={folder.label || folder.id}
      />
      <DropboxModal
        open={dropboxOpen}
        onClose={() => setDropboxOpen(false)}
        folderID={folder.id}
        folderPath={folder.path}
        folderName={folder.label || folder.id}
      />
    </div>
  );
}

// DropboxIcon — the Dropbox glyph (two stacked chevrons), used on the hero
// action button that opens the import/export modal.
function DropboxIcon() {
  return (
    <svg className="h-5 w-5" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <path d="M6 2 1 5.2l5 3.2 5-3.2L6 2Zm12 0-5 3.2 5 3.2 5-3.2L18 2ZM1 11.6l5 3.2 5-3.2-5-3.2-5 3.2Zm17-3.2-5 3.2 5 3.2 5-3.2-5-3.2ZM6 16.5l5 3.2 5-3.2-5-3.2-5 3.2Z" />
    </svg>
  );
}

// TopBreadcrumb renders the "/ folder / subfolder" trail after the project
// name in the top bar. Each segment navigates the file browser to that level.
function TopBreadcrumb({
  path,
  onNavigate,
}: {
  path: string;
  onNavigate: (next: string) => void;
}) {
  const segments = path ? path.split("/") : [];
  if (segments.length === 0) return null;
  return (
    <nav className="flex min-w-0 items-center gap-1 text-sm text-fg-soft" aria-label="Breadcrumb">
      {segments.map((seg, i) => {
        const target = segments.slice(0, i + 1).join("/");
        const isLast = i === segments.length - 1;
        return (
          <span key={target} className="flex min-w-0 items-center gap-1">
            <span className="text-fg-faint">/</span>
            <button
              type="button"
              onClick={() => onNavigate(target)}
              className={cn(
                "truncate rounded-md px-1.5 py-0.5 transition-colors",
                isLast ? "text-fg-strong" : "hover:bg-hover hover:text-fg-strong",
              )}
            >
              {seg}
            </button>
          </span>
        );
      })}
    </nav>
  );
}

// LayoutToggle: one segment of the three-up layout control in the top bar.
// Each draws a window glyph with the relevant region filled — left panel,
// center stage, or right panel — and lights cobalt when its panel is shown.
function LayoutToggle({
  active,
  onClick,
  title,
  side,
}: {
  active: boolean;
  onClick: () => void;
  title: string;
  side: "left" | "center" | "right";
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      aria-label={title}
      aria-pressed={active}
      className={cn(
        "flex h-7 w-8 items-center justify-center rounded-md transition-colors",
        active
          ? "bg-accent/20 text-accent"
          : "text-fg-soft hover:bg-hover hover:text-fg-strong",
      )}
    >
      <svg viewBox="0 0 22 18" fill="none" className="h-4 w-[18px]" aria-hidden>
        <rect x="1.5" y="2" width="19" height="14" rx="2.5" stroke="currentColor" strokeWidth="1.6" />
        {side === "left" && (
          <rect x="1.5" y="2" width="6.5" height="14" rx="2.5" fill="currentColor" fillOpacity="0.55" />
        )}
        {side === "center" && <path d="M9 6.5 13.5 9 9 11.5z" fill="currentColor" />}
        {side === "right" && (
          <rect x="14" y="2" width="6.5" height="14" rx="2.5" fill="currentColor" fillOpacity="0.55" />
        )}
      </svg>
    </button>
  );
}

function FolderGlyph() {
  return (
    <svg
      viewBox="0 0 20 20"
      fill="currentColor"
      className="h-3.5 w-3.5 shrink-0"
      aria-hidden
    >
      <path d="M2 5a2 2 0 0 1 2-2h3.586a2 2 0 0 1 1.414.586l1 1A2 2 0 0 0 11.414 5H16a2 2 0 0 1 2 2v6a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5z" />
    </svg>
  );
}

function PlayIcon() {
  return (
    <svg
      viewBox="0 0 20 20"
      fill="currentColor"
      className="h-4 w-4"
      aria-hidden
    >
      <path d="M5 4.5v11l10-5.5L5 4.5z" />
    </svg>
  );
}

function PauseIcon() {
  return (
    <svg
      viewBox="0 0 20 20"
      fill="currentColor"
      className="h-4 w-4"
      aria-hidden
    >
      <path d="M6 4h3v12H6V4zm5 0h3v12h-3V4z" />
    </svg>
  );
}

function EditIcon() {
  return (
    <svg
      viewBox="0 0 20 20"
      fill="currentColor"
      className="h-4 w-4"
      aria-hidden
    >
      <path d="M13.586 3.586a2 2 0 1 1 2.828 2.828l-9 9a1 1 0 0 1-.39.242l-4 1.5a1 1 0 0 1-1.272-1.272l1.5-4a1 1 0 0 1 .242-.39l9-9z" />
    </svg>
  );
}

function InviteIcon() {
  return (
    <svg
      viewBox="0 0 20 20"
      fill="currentColor"
      className="h-4 w-4"
      aria-hidden
    >
      <path d="M9 6a3 3 0 1 1-6 0 3 3 0 0 1 6 0zM17 11h-2V9a1 1 0 1 0-2 0v2h-2a1 1 0 1 0 0 2h2v2a1 1 0 1 0 2 0v-2h2a1 1 0 1 0 0-2zM2 18a4 4 0 0 1 8 0v1H2v-1z" />
    </svg>
  );
}

function LeaveIcon() {
  // Door + arrow leaving — distinct from TrashIcon so the user reads
  // "I'm stepping out" rather than "I'm destroying this".
  return (
    <svg viewBox="0 0 20 20" fill="currentColor" className="h-4 w-4" aria-hidden>
      <path
        fillRule="evenodd"
        d="M3 4a1 1 0 0 1 1-1h6a1 1 0 1 1 0 2H5v10h5a1 1 0 1 1 0 2H4a1 1 0 0 1-1-1V4zm10.293 2.293a1 1 0 0 1 1.414 0l3 3a1 1 0 0 1 0 1.414l-3 3a1 1 0 0 1-1.414-1.414L14.586 11H8a1 1 0 1 1 0-2h6.586l-1.293-1.293a1 1 0 0 1 0-1.414z"
        clipRule="evenodd"
      />
    </svg>
  );
}

function TrashIcon() {
  return (
    <svg
      viewBox="0 0 20 20"
      fill="currentColor"
      className="h-4 w-4"
      aria-hidden
    >
      <path
        fillRule="evenodd"
        d="M8 3a1 1 0 0 0-1 1v1H4a1 1 0 0 0 0 2h12a1 1 0 1 0 0-2h-3V4a1 1 0 0 0-1-1H8zm6 6H6l.86 8.572A2 2 0 0 0 8.853 19h2.294a2 2 0 0 0 1.993-1.428L14 9z"
        clipRule="evenodd"
      />
    </svg>
  );
}

function humanStateLabelForHero(
  daemonState: string | undefined,
  paused: boolean,
  completion: number | undefined,
): { label: string; dot: string; text: string } {
  // Mirrors humanStateLabel but adds the "complete-but-still-fetching"
  // fixup that SyncStatusPill carried, so this is self-contained.
  if (paused) {
    return { label: "Paused", dot: "bg-amber-300", text: "text-amber-200" };
  }
  if (!daemonState || daemonState === "—") {
    return { label: "Offline", dot: "bg-slate-300", text: "text-slate-200" };
  }
  if (daemonState === "error") {
    return { label: "Error", dot: "bg-rose-400", text: "text-rose-200" };
  }
  if (daemonState !== "idle" || (completion !== undefined && completion < 100)) {
    return { label: "Syncing", dot: "bg-indigo-400 animate-pulse", text: "text-white" };
  }
  return { label: "Ready", dot: "bg-emerald-400", text: "text-emerald-300" };
}

// HeaderIconButton: ghost icon button used in the project header's
// action cluster (Edit / Dropbox / Pause / Delete). Quiet by default,
// tinted on hover; the danger tone reads red for Delete / Leave.
function HeaderIconButton({
  children,
  onClick,
  ariaLabel,
  tone = "default",
}: {
  children: React.ReactNode;
  onClick: () => void;
  ariaLabel: string;
  tone?: "default" | "danger";
}) {
  const cls =
    tone === "danger"
      ? "text-fg-soft hover:bg-rose-500/15 hover:text-rose-300"
      : "text-fg-soft hover:bg-hover hover:text-fg-strong";
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={ariaLabel}
      title={ariaLabel}
      className={cn(
        "flex h-8 w-8 items-center justify-center rounded-lg transition-colors",
        cls,
      )}
    >
      {children}
    </button>
  );
}

function ActivityGlyph() {
  return (
    <svg viewBox="0 0 24 24" fill="none" className="h-[18px] w-[18px]" aria-hidden>
      <path d="M22 12h-4l-3 9L9 3l-3 9H2" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

// TabActions decides what (if anything) renders to the right of the
// tab strip. When the daemon's state error is one of the recoverable
// kinds (folder marker / path missing), the Resync button replaces
// the verbose error pill — the button alone signals "something needs
// attention" and offers the fix in one click. Other errors fall back
// to the existing ActivityErrorPreview so users still see *what's*
// wrong when there's no one-tap remedy.
function TabActions({
  folderID,
  errorCount,
  onOpenActivity,
}: {
  folderID: string;
  errorCount: number;
  onOpenActivity: () => void;
}) {
  const status = useFolderStatus(folderID);
  // Single source of truth: REST /rest/db/status. useResyncFolder
  // forces a refetch on success, so this string mirrors the daemon's
  // actual state within one round-trip. The realtime store's
  // fs.error can persist a stale value after error→idle until the
  // next FolderSummary tick, so we don't consult it here.
  const raw = (status.data?.error || "").toLowerCase();
  const isRecoverable =
    raw.includes("folder marker missing") || raw.includes("folder path missing");

  if (isRecoverable) {
    return <ResyncButton folderID={folderID} />;
  }
  if (errorCount > 0) {
    return (
      <ActivityErrorPreview folderID={folderID} onOpen={onOpenActivity} />
    );
  }
  return null;
}

// ResyncButton recovers a folder from ErrPathMissing / ErrMarkerMissing.
// Renders only when one of those errors is current. For marker-missing
// we just call /rest/folder/resync, which recreates the .vidsync
// marker and triggers a scan. For path-missing we open the OS folder
// picker so the user can repoint the project at its new location,
// PATCH the folder's path, then resync.
function ResyncButton({ folderID }: { folderID: string }) {
  const cfg = useConfig();
  const status = useFolderStatus(folderID);
  const patch = usePatchFolder();
  const resync = useResyncFolder();
  const folder = cfg.data?.folders.find((f) => f.id === folderID);

  // Single source of truth: REST /rest/db/status (see TabActions).
  const raw = (status.data?.error || "").toLowerCase();
  const isMarkerMissing = raw.includes("folder marker missing");
  const isPathMissing = raw.includes("folder path missing");
  if (!folder || (!isMarkerMissing && !isPathMissing)) return null;

  const busy = patch.isPending || resync.isPending;
  const label = busy
    ? "Resyncing…"
    : isPathMissing
      ? "Locate & resync"
      : "Resync";

  return (
    <button
      type="button"
      disabled={busy}
      onClick={async () => {
        try {
          if (isPathMissing) {
            const chosen = await pickFolder(
              "Choose the project folder",
              folder.path,
            );
            if (!chosen) return; // user cancelled the OS dialog
            await patch.mutateAsync({
              id: folderID,
              patch: { path: chosen },
            });
          }
          await resync.mutateAsync({ folderID });
        } catch {
          // Errors land on the mutation objects; nothing extra here —
          // a future improvement would surface them inline, but for
          // now the Activity badge still reflects the state and the
          // user can retry.
        }
      }}
      title={
        isPathMissing
          ? "Pick the project folder's new location, then resync"
          : "Recreate the project marker and resync"
      }
      className="ml-2 self-center rounded-md border border-amber-400/40 bg-amber-500/15 px-3 py-1 text-[11px] font-semibold text-amber-100 transition-colors hover:bg-amber-500/25 disabled:cursor-wait disabled:opacity-60"
    >
      {label}
    </button>
  );
}

// ActivityErrorPreview surfaces the first error message right beside
// the Activity badge so the user can see *what* is wrong without
// clicking into the tab. There are three flavors of "wrong" the
// daemon reports, in roughly decreasing severity:
//
//   1. Folder-level state error — the daemon can't run the folder
//      at all (path missing, marker gone, permission denied on the
//      root, name renamed on disk, ...). Reported on the FolderState
//      `error` field.
//   2. Receive-only local changes — for an invited folder in
//      receive-only mode, the user touched files locally and now
//      they conflict with the master. Reported via
//      `receiveOnlyChangedFiles`.
//   3. Per-file pull errors — individual files couldn't be synced
//      (permission, disk full, etc.). Reported by /db/errors.
//
// Clicking the preview navigates to the Activity tab where the full
// ErrorsBanner + folder-status details show every row.
function ActivityErrorPreview({
  folderID,
  onOpen,
}: {
  folderID: string;
  onOpen: () => void;
}) {
  const fs = useFolderState(folderID);
  const status = useFolderStatus(folderID);
  const errors = useFolderErrors(folderID);

  const stateError = fs?.error ?? status.data?.error ?? "";
  const watchError = fs?.watchError ?? status.data?.watchError ?? "";
  const roChanged =
    (fs?.receiveOnlyChangedFiles ?? status.data?.receiveOnlyChangedFiles ?? 0) +
    (fs?.receiveOnlyChangedDeletes ?? status.data?.receiveOnlyChangedDeletes ?? 0);
  const rows = errors.data?.errors ?? [];

  // Pick the most severe surfaceable detail. Folder-level state
  // error wins because syncing is broken entirely; receive-only
  // conflicts come next; per-file pull errors are last.
  let title: string;
  let detail: string;
  let more = 0;
  if (stateError) {
    title = "Folder error";
    detail = humanizeFolderError(stateError);
    // Pull errors + watch error count as extra context.
    more = rows.length + (watchError ? 1 : 0);
  } else if (roChanged > 0) {
    title = "Local changes";
    detail = `${roChanged.toLocaleString()} file${roChanged === 1 ? "" : "s"} modified locally — needs Override or Revert`;
    more = rows.length + (watchError ? 1 : 0);
  } else if (rows.length > 0) {
    title = rows[0].path;
    detail = rows[0].error;
    more = rows.length - 1 + (watchError ? 1 : 0);
  } else if (watchError) {
    title = "Watcher error";
    detail = watchError;
  } else {
    return null;
  }

  return (
    <button
      type="button"
      onClick={onOpen}
      title={`${title}: ${detail}`}
      className="ml-1 flex min-w-0 items-center self-center truncate rounded-md bg-rose-500/10 px-2 py-1 text-[11px] text-rose-200 hover:bg-rose-500/20"
    >
      <span className="truncate">
        <span className="font-medium">{title}</span>
        <span className="text-rose-300/80"> — </span>
        <span className="text-rose-300">{detail}</span>
      </span>
      {more > 0 && (
        <span className="ml-2 shrink-0 rounded bg-rose-500/20 px-1.5 text-[10px] font-semibold text-rose-200">
          +{more}
        </span>
      )}
    </button>
  );
}

// TeamPanel renders the "Team" tab. A single combined list shows the
// connected members (PeerStatus rows) followed by any still-pending
// email invitations. Once an invite is accepted the recipient joins as
// a regular member, so the accepted history is redundant — we hide it.
// Declined/revoked rows are noise and also hidden.
function TeamPanel({
  folder,
  members,
  allDevices,
  isOwned,
  myID,
  onInvite,
  onRemove,
}: {
  folder: FolderConfiguration;
  members: FolderConfiguration["devices"];
  allDevices: { deviceID: string; name: string }[];
  isOwned: boolean;
  myID: string;
  onInvite: () => void;
  onRemove: (deviceID: string) => void;
}) {
  const cloudInvites = useFolderInvitations(
    isOwned && AUTH_ENABLED ? folder.id : null,
  );
  // Recipient side: my accepted invitation labels the owner's device with a
  // person (fallback when the roster endpoint isn't available).
  const myAccepted = useMyAcceptedForFolder(
    !isOwned && AUTH_ENABLED ? folder.id : null,
  );
  // Full roster (owner + accepted members), so everyone — not just the owner —
  // sees all collaborators. Falls back to local folder.devices if unavailable.
  const roster = useProjectMembers(AUTH_ENABLED ? folder.id : null);
  const myEmail = useAccountEmail();
  const revoke = useRevokeInvitation();
  const conns = useConnections();
  const invitations = cloudInvites.data?.invitations ?? [];
  const pending = invitations.filter((i) => i.status === "pending");

  // Label fallbacks for the local-devices path.
  const labelByDevice = new Map<string, string>();
  for (const inv of invitations) {
    if (inv.status === "accepted" && inv.recipientDeviceId) {
      labelByDevice.set(inv.recipientDeviceId, inv.recipientName ?? inv.recipientEmail);
    }
  }
  const ownerInv = myAccepted.data;
  if (ownerInv?.ownerDeviceId) {
    labelByDevice.set(
      ownerInv.ownerDeviceId,
      ownerInv.ownerName ?? ownerInv.ownerEmail ?? ownerInv.ownerDeviceId,
    );
  }
  const memberLabel = (id: string) =>
    labelByDevice.get(id) ??
    allDevices.find((d) => d.deviceID === id)?.name ??
    "Unknown device";

  const youLabel = myEmail || "You";
  const folderDeviceIDs = new Set(folder.devices.map((d) => d.deviceID));

  type TeamRow = {
    deviceID: string;
    label: string;
    email: string;
    role: "owner" | "member";
    isSelf: boolean;
    // Connected = present in the local daemon's device list, so we can show
    // live presence. A recipient isn't peered with sibling collaborators.
    connected: boolean;
  };
  const rosterMembers = roster.data ?? [];
  let rows: TeamRow[];
  if (rosterMembers.length > 0) {
    rows = rosterMembers.map((m) => ({
      deviceID: m.deviceId,
      label: m.name || m.email,
      email: m.email,
      role: m.role,
      isSelf: m.deviceId === myID,
      connected: folderDeviceIDs.has(m.deviceId),
    }));
    if (!rows.some((r) => r.isSelf)) {
      rows.unshift({
        deviceID: myID,
        label: youLabel,
        email: myEmail,
        role: isOwned ? "owner" : "member",
        isSelf: true,
        connected: true,
      });
    }
  } else {
    // Fallback: just what the local daemon knows (self + peered devices).
    rows = [
      {
        deviceID: myID,
        label: youLabel,
        email: myEmail,
        role: isOwned ? "owner" : "member",
        isSelf: true,
        connected: true,
      },
      ...members.map((m) => ({
        deviceID: m.deviceID,
        label: memberLabel(m.deviceID),
        email: "",
        role: "member" as const,
        isSelf: false,
        connected: true,
      })),
    ];
  }

  // A person can be signed in on several devices. We collapse those to a
  // single row showing only their latest/most-active device, so the roster
  // lists each human once instead of one look-alike row per machine. Grouped
  // by email (the stable per-person key); devices without an email fall back
  // to standing alone.
  const groupMap = new Map<string, TeamRow[]>();
  for (const r of rows) {
    const key = r.email ? `email:${r.email.toLowerCase()}` : `dev:${r.deviceID}`;
    const list = groupMap.get(key);
    if (list) list.push(r);
    else groupMap.set(key, [r]);
  }

  // Rank a device so the "latest" one wins: our own device first, then
  // currently-online, then any peered device, then unpeered — tie-broken by
  // most recent connection time.
  const lastSeenMs = (id: string): number => {
    const at = conns.data?.connections[id]?.at;
    const t = at ? Date.parse(at) : NaN;
    return Number.isNaN(t) ? 0 : t;
  };
  const deviceRank = (r: TeamRow): number => {
    if (r.isSelf) return 3;
    if (conns.data?.connections[r.deviceID]?.connected) return 2;
    if (r.connected) return 1;
    return 0;
  };
  const latestDevice = (devices: TeamRow[]): TeamRow =>
    [...devices].sort((a, b) => {
      const ra = deviceRank(a);
      const rb = deviceRank(b);
      if (ra !== rb) return rb - ra;
      return lastSeenMs(b.deviceID) - lastSeenMs(a.deviceID);
    })[0];

  // One representative row per person.
  const people = [...groupMap.values()].map(latestDevice);

  // You first, then owner, then members alphabetically.
  people.sort((a, b) => {
    if (a.isSelf !== b.isSelf) return a.isSelf ? -1 : 1;
    if (a.role !== b.role) return a.role === "owner" ? -1 : 1;
    return a.label.localeCompare(b.label);
  });

  const personDetail = (r: TeamRow): string | undefined =>
    r.email && r.email !== r.label ? r.email : undefined;

  const noOthers =
    people.filter((r) => !r.isSelf).length === 0 && pending.length === 0;

  return (
    <section className="pt-4">
      <MembersHeader
        deviceIDs={people.filter((r) => !r.isSelf).map((r) => r.deviceID)}
        trailing={
          isOwned ? (
            <button
              type="button"
              onClick={onInvite}
              className="inline-flex items-center gap-1.5 rounded-md bg-accent px-3 py-1.5 text-xs font-semibold text-accent-fg shadow-sm transition-colors hover:bg-accent/90"
            >
              <InviteIcon />
              <span>Invite</span>
            </button>
          ) : null
        }
      />
      <ul className="divide-y divide-line rounded-lg border border-line bg-elevated">
        {people.map((row) =>
          row.isSelf ? (
            <li key={row.deviceID} className="flex items-center gap-3 px-4 py-3">
              <PresenceAvatar label={row.label} state="online" />
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium text-fg-strong">
                  You{myEmail ? ` · ${myEmail}` : ""}
                </div>
                <div className="text-xs text-fg-soft">
                  This device{row.role === "owner" ? " · Owner" : ""}
                </div>
              </div>
              <span className="flex shrink-0 items-center gap-1 text-[11px] text-emerald-300">
                <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" aria-hidden />
                Online
              </span>
            </li>
          ) : row.connected ? (
            <li key={row.deviceID}>
              <PeerStatus
                deviceID={row.deviceID}
                name={row.label}
                detail={personDetail(row)}
                folderID={folder.id}
                onRemove={
                  isOwned && row.role !== "owner"
                    ? () => onRemove(row.deviceID)
                    : undefined
                }
              />
            </li>
          ) : (
            // A collaborator we're not directly peered with (e.g. a sibling
            // recipient seen via the roster). Show them without live presence.
            <li key={row.deviceID} className="flex items-center gap-3 px-4 py-3">
              <PresenceAvatar label={row.label} state="offline" />
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium text-fg-strong">
                  {row.label}
                </div>
                {personDetail(row) && (
                  <div className="truncate text-xs text-fg-faint">
                    {personDetail(row)}
                  </div>
                )}
                <div className="text-xs text-fg-soft">
                  {row.role === "owner" ? "Owner" : "Member"} · not connected to you
                </div>
              </div>
            </li>
          ),
        )}
        {pending.map((inv) => (
          <InvitationRow
            key={inv.id}
            inv={inv}
            onRevoke={() => revoke.mutate({ id: inv.id, folderID: folder.id })}
          />
        ))}
      </ul>
      {noOthers && (
        <p className="mt-3 text-center text-xs text-fg-faint">
          {isOwned
            ? "No collaborators yet — invite someone to share this project."
            : "No other collaborators on this project."}
        </p>
      )}
    </section>
  );
}

function InvitationRow({
  inv,
  onRevoke,
}: {
  inv: CloudInvitation;
  onRevoke?: () => void;
}) {
  return (
    <li className="flex items-center justify-between gap-3 px-4 py-3">
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium text-fg-strong">
          {inv.recipientName ?? inv.recipientEmail}
        </div>
        <div className="mt-0.5 text-xs text-fg-soft">
          Invited{" "}
          <span title={new Date(inv.createdAt).toLocaleString()}>
            {humanRelative(inv.createdAt)}
          </span>
          {inv.acceptedAt && (
            <>
              {" · joined "}
              <span title={new Date(inv.acceptedAt).toLocaleString()}>
                {humanRelative(inv.acceptedAt)}
              </span>
            </>
          )}
        </div>
      </div>
      <StatusBadge status={inv.status} />
      {onRevoke && inv.status === "pending" && (
        <button
          type="button"
          onClick={onRevoke}
          className="rounded-md px-2 py-1 text-xs font-medium text-fg-soft hover:bg-hover hover:text-fg-strong"
        >
          Revoke
        </button>
      )}
    </li>
  );
}

function StatusBadge({ status }: { status: CloudInvitation["status"] }) {
  const cls =
    status === "pending"
      ? "bg-amber-500/15 text-amber-300"
      : status === "accepted"
        ? "bg-emerald-500/15 text-emerald-300"
        : status === "declined"
          ? "bg-rose-500/15 text-rose-300"
          : "bg-fg-faint/15 text-fg-soft";
  return (
    <span
      className={cn(
        "shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide",
        cls,
      )}
    >
      {status}
    </span>
  );
}

// --- modals (lifted from the prior YourProjects.tsx) ---

const PULL_ORDERS: { value: string; label: string }[] = [
  { value: "random", label: "Random" },
  { value: "alphabetic", label: "Alphabetical" },
  { value: "smallestFirst", label: "Smallest first (proxies before masters)" },
  { value: "largestFirst", label: "Largest first" },
  { value: "oldestFirst", label: "Oldest first" },
  { value: "newestFirst", label: "Newest first" },
];

const FOLDER_TYPES: { value: string; label: string; help: string }[] = [
  {
    value: "sendreceive",
    label: "Send & receive",
    help: "Both push my changes and accept theirs.",
  },
  {
    value: "sendonly",
    label: "Send only",
    help: "Push my changes; ignore incoming edits.",
  },
  {
    value: "receiveonly",
    label: "Receive only",
    help: "Accept their changes; my edits stay local.",
  },
  {
    value: "receiveencrypted",
    label: "Receive encrypted",
    help: "Cold-storage replica; data isn't readable here.",
  },
];

function EditProjectModal({
  open,
  onClose,
  folder,
  isOwned,
}: {
  open: boolean;
  onClose: () => void;
  folder: FolderConfiguration;
  isOwned: boolean;
}) {
  // Show whatever sync mode the daemon currently has. New folders are
  // created with a role-appropriate default at creation time
  // (NewProjectModal / AcceptFolderModal), so we no longer second-guess
  // the stored value here — coercing a saved "sendreceive" back to the
  // role default was hiding deliberate edits and making the dropdown
  // appear to "revert" after a successful save.
  const defaultType = isOwned ? "sendonly" : "receiveonly";
  const seedType = (folder.type as string) || defaultType;
  const [name, setName] = useState(folder.label);
  const [path, setPath] = useState(folder.path);
  const [type, setType] = useState<string>(seedType);
  const [order, setOrder] = useState<string>(
    (folder.order as string) || "smallestFirst",
  );
  const [picking, setPicking] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const put = usePutFolder();

  useResetOnOpen(open, () => {
    setName(folder.label);
    setPath(folder.path);
    setType(seedType);
    setOrder((folder.order as string) || "smallestFirst");
    setPicking(false);
    setSaveError(null);
  });

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Edit project"
      primaryLabel={put.isPending ? "Saving…" : "Save"}
      primaryDisabled={put.isPending}
      onPrimary={async () => {
        setSaveError(null);
        try {
          await put.mutateAsync({
            ...folder,
            label: name,
            path,
            type,
            order,
          });
          onClose();
        } catch (e) {
          // Surface the daemon's reason (validation, bad path, etc.)
          // instead of letting the rejection swallow silently — the
          // modal would otherwise stay open with no indication of why.
          const msg =
            e instanceof APIError
              ? e.body.trim() || `${e.status} ${e.method} ${e.path}`
              : e instanceof Error
                ? e.message
                : String(e);
          setSaveError(msg || "Save failed");
        }
      }}
    >
      <Field label="Name">
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          className={inputClass}
        />
      </Field>
      <Field label="Path">
        <div className="flex gap-2">
          <input
            value={path}
            onChange={(e) => setPath(e.target.value)}
            className={inputClass}
          />
          <Button
            onClick={async () => {
              const chosen = await pickFolder("Choose a folder for the project", path);
              if (chosen) {
                setPath(chosen);
                return;
              }
              // In Wails the OS dialog handles cancel itself; only fall
              // back to the in-app picker in dev/browser where there's
              // no native dialog to begin with.
              if (!isNativeDialogAvailable()) setPicking(true);
            }}
          >
            Browse…
          </Button>
        </div>
      </Field>
      <Field label="Sync mode">
        <select
          value={type}
          onChange={(e) => setType(e.target.value)}
          className={inputClass}
        >
          {FOLDER_TYPES.map((t) => (
            <option key={t.value} value={t.value}>
              {t.label}
            </option>
          ))}
        </select>
        <p className="mt-1 text-xs text-fg-soft">
          {FOLDER_TYPES.find((t) => t.value === type)?.help ?? ""}
        </p>
      </Field>
      <Field label="Pull order">
        <select
          value={order}
          onChange={(e) => setOrder(e.target.value)}
          className={inputClass}
        >
          {PULL_ORDERS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </Field>
      <FolderPicker
        open={picking}
        onClose={() => setPicking(false)}
        onPick={(p) => setPath(p)}
        initialPath={path}
      />
      {saveError && (
        <p className="mt-3 break-words text-sm text-rose-400">
          Couldn't save the project: {saveError}
        </p>
      )}
    </Modal>
  );
}

// ConfirmDeleteModal: confirmation dialog for two related-but-distinct
// actions. For owners it's "Delete project" — the canonical destructive
// op. For invited recipients it's "Leave project" — only their local
// copy stops syncing; the owner's master and other collaborators are
// unaffected. Underlying daemon call (deleteFolder) is the same.
function ConfirmDeleteModal({
  open,
  onClose,
  onConfirm,
  folderName,
  isOwned,
}: {
  open: boolean;
  onClose: () => void;
  onConfirm: () => void;
  folderName: string;
  isOwned: boolean;
}) {
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={isOwned ? "Delete project" : "Leave project"}
      primaryLabel={isOwned ? "Delete" : "Leave"}
      primaryVariant="danger"
      onPrimary={onConfirm}
    >
      <p className="text-sm">
        {isOwned ? (
          <>
            Stop syncing <strong>{folderName}</strong>? Files on disk are
            not deleted.
          </>
        ) : (
          <>
            Stop syncing <strong>{folderName}</strong> on this device?
            Files on disk stay where they are. The owner and other
            collaborators keep their copies.
          </>
        )}
      </p>
    </Modal>
  );
}

// InviteMemberModal sends a cloud invitation to an email address. The
// recipient will get an email; when they accept inside their copy of
// Vidsync, the owner's InvitationBridge picks it up and shares the
// folder locally. The owner doesn't need to know the recipient's
// device ID at any point — that's the whole point of the cloud layer.
function InviteMemberModal({
  open,
  onClose,
  folder,
  myID,
  folderSizeBytes,
}: {
  open: boolean;
  onClose: () => void;
  folder: FolderConfiguration;
  myID: string;
  // Project total size (globalBytes) stamped onto the invite so the
  // recipient sees the download size before accepting. 0 when unknown.
  folderSizeBytes: number;
}) {
  const [email, setEmail] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const create = useCreateInvitation();

  const close = () => {
    setEmail("");
    setErr(null);
    onClose();
  };

  return (
    <Modal
      open={open}
      onClose={close}
      title="Invite collaborator"
      primaryLabel={create.isPending ? "Sending…" : "Send invite"}
      primaryDisabled={create.isPending || !email.trim() || !myID}
      onPrimary={async () => {
        setErr(null);
        try {
          await create.mutateAsync({
            folderID: folder.id,
            email: email.trim(),
            folderLabel: folder.label || folder.id,
            ownerDeviceId: myID,
            // Only send a positive size; 0 means the folder hasn't been
            // scanned yet, in which case we leave it unknown.
            folderSizeBytes: folderSizeBytes > 0 ? folderSizeBytes : undefined,
          });
          close();
        } catch (e) {
          // Show the backend's clean message (e.g. "That email isn't a
          // registered Vidsync user") rather than the verbose
          // method/path/status form in CloudAPIError.message.
          setErr(
            e instanceof CloudAPIError
              ? e.detail
              : e instanceof Error
                ? e.message
                : String(e),
          );
        }
      }}
    >
      <p className="mb-4 text-sm text-fg-soft">
        Send a project invite to a teammate's email. They'll be prompted
        to sign in and accept — once they do, this project starts
        syncing to their device automatically.
      </p>
      <Field label="Email">
        <input
          autoFocus
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          className={inputClass}
          placeholder="teammate@example.com"
        />
      </Field>
      {err && <p className="mt-2 text-sm text-rose-400">{err}</p>}
    </Modal>
  );
}

// --- small UI helpers ---

const inputClass =
  "w-full rounded border border-line px-2 py-1.5 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500";

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <label className="mb-3 block">
      <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-fg-soft">
        {label}
      </span>
      {children}
    </label>
  );
}

function useResetOnOpen(open: boolean, fn: () => void) {
  const wasOpen = useRef(false);
  useEffect(() => {
    if (open && !wasOpen.current) fn();
    wasOpen.current = open;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
}
