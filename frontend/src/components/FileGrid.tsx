import { useEffect, useMemo, useRef, useState } from "react";
import { useBringToFront, useFolderBrowse, useFolderNeed } from "../api/hooks";
import { buildFileURL, previewURL, streamingVideoURL, thumbURL } from "../lib/fileURL";
import { bc } from "../lib/breadcrumb";
import { useActivity, useTransfersForFolder } from "../realtime/hooks";
import { humanBytes, humanRate, humanRelative } from "../lib/format";
import {
  AUDIO_EXT,
  IMAGE_EXT,
  isAudioExt,
  isBrowserViewableImage,
  isImageExt,
  isPlayable,
  isPreviewable,
  isVideoExt,
  mediaKind,
  needsTranscode,
  previewNeedsTranscode,
  VIDEO_EXT,
} from "../lib/videoFormats";
import { makeNeedSets } from "../lib/folderAggregate";
import { useFolderCollageThumbs } from "../lib/useFolderThumbs";
import { cn } from "../lib/utils";
import { ContextMenu, type ContextMenuItem } from "./ContextMenu";
import { FileDetailsModal, type FileDetails } from "./FileDetailsModal";
import { UnreadBadge } from "./UnreadBadge";
import { PresenceAvatar, type PresenceState } from "./PresenceAvatar";
import { useUnread } from "../api/cloud/useUnread";
import type { VideoPreviewFile } from "./VideoPreviewModal";

// A collaborator rendered in the toolbar's member stack. Built by the
// project view (it owns device labels + presence) and passed down.
export interface ProjectMemberSummary {
  id: string;
  label: string;
  state: PresenceState;
}

// FileGrid: the file browser inside ProjectDetail's "Files" tab.
// Iconik / Frame.io shape — big thumbnails, status chip overlay, dense
// metadata line under each tile. List view for users who want to scan
// a long flat directory quickly. Right-click for actions.
//
// Data sources:
//   - /rest/db/browse          → file tree (paths, sizes, modtimes)
//   - /rest/db/need            → which paths are progress / queued
//   - realtime puller progress → granular % + rate for live transfers
//
// Anything in the browse tree but absent from the need sets is
// implicitly synced.

type View = "grid" | "list";

// isJunkFile hides OS metadata files that aren't project content —
// macOS Spotlight indexes (.DS_Store), Windows thumbnail caches
// (Thumbs.db), and Windows desktop customization (desktop.ini). These
// often ride along through cross-platform sync but aren't part of the
// user's edit, so we keep them out of the file list.
function isJunkFile(name: string): boolean {
  return (
    name === ".DS_Store" ||
    name === "Thumbs.db" ||
    name === "desktop.ini" ||
    // The review-comments sidecar dir is app data, not project content.
    name === ".vidsync-review"
  );
}

// File sort options exposed in the toolbar. `recent` is the default —
// most useful during an active sync because freshly-arrived clips show
// up at the top. Folders always sort alphabetically and float to the
// top regardless of the chosen key.
type SortKey =
  | "recent"
  | "oldest"
  | "name-asc"
  | "name-desc"
  | "size-desc"
  | "size-asc";

const SORT_LABELS: { value: SortKey; label: string }[] = [
  { value: "recent", label: "Recent" },
  { value: "oldest", label: "Oldest" },
  { value: "name-asc", label: "Name (A–Z)" },
  { value: "name-desc", label: "Name (Z–A)" },
  { value: "size-desc", label: "Largest" },
  { value: "size-asc", label: "Smallest" },
];

// Appearance: per-user grid display preferences, exposed through the
// toolbar's Appearance popover (mirrors Frame.io). Persisted to
// localStorage so the chosen density/aspect sticks across sessions.
type CardSize = "S" | "M" | "L";
type CardAspect = "video" | "square";
type CardScale = "fill" | "fit";

interface Appearance {
  size: CardSize;
  aspect: CardAspect;
  // How the thumbnail fills its frame: "fill" crops to cover, "fit" letterboxes.
  scale: CardScale;
  // Titles = the filename; Card Info = the size·date meta line.
  showNames: boolean;
  showInfo: boolean;
  // Flatten = list every file recursively, hiding folders.
  flatten: boolean;
  hoverToPlay: boolean;
}

const APPEARANCE_KEY = "vidsync.gridAppearance";
const DEFAULT_APPEARANCE: Appearance = {
  size: "M",
  aspect: "video",
  scale: "fill",
  showNames: true,
  showInfo: true,
  flatten: false,
  hoverToPlay: true,
};

function loadAppearance(): Appearance {
  try {
    const raw = localStorage.getItem(APPEARANCE_KEY);
    if (!raw) return DEFAULT_APPEARANCE;
    return { ...DEFAULT_APPEARANCE, ...(JSON.parse(raw) as Partial<Appearance>) };
  } catch {
    return DEFAULT_APPEARANCE;
  }
}

function saveAppearance(a: Appearance) {
  try {
    localStorage.setItem(APPEARANCE_KEY, JSON.stringify(a));
  } catch {
    // localStorage disabled / full — non-fatal.
  }
}

// Grid column counts per card size. Larger cards → fewer columns.
const GRID_COLS: Record<CardSize, string> = {
  S: "grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 2xl:grid-cols-7",
  M: "grid-cols-1 sm:grid-cols-2 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5",
  L: "grid-cols-1 sm:grid-cols-2 md:grid-cols-2 lg:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4",
};

type FileState =
  | { kind: "synced" }
  | { kind: "queued" }
  | { kind: "syncing"; pct: number; ratePerSec: number };

interface FileEntry {
  kind: "file";
  path: string; // full POSIX-style relative path
  name: string; // basename
  size: number;
  modified: string;
  state: FileState;
}

interface FolderEntry {
  kind: "folder";
  path: string;
  name: string;
  // Count of immediate children (files + subfolders) — drives the
  // "X items" subtitle on folder tiles.
  childCount: number;
  // Recursive rollup of every file underneath this folder. Computed
  // once at entries-build time so the row component is render-only.
  aggregate: FolderAggregateInfo;
}

interface FolderAggregateInfo {
  totalFiles: number;
  totalBytes: number;
  syncedFiles: number;
  syncingFiles: number;
  pendingFiles: number;
}

// rollupBrowseSubtree: walk a folder's children in the browse tree
// and classify each file by sync state via the need-sets plus the
// live transfers map. Folders surfaced only by /rest/db/need (no
// local data yet) get a separate codepath in the caller — see
// needList filtering when building entries.
function rollupBrowseSubtree(
  nodes: BrowseEntry[] | undefined,
  prefix: string,
  needSets: { progress: ReadonlySet<string>; pending: ReadonlySet<string> },
  transferPaths: ReadonlySet<string>,
): FolderAggregateInfo {
  const out: FolderAggregateInfo = {
    totalFiles: 0,
    totalBytes: 0,
    syncedFiles: 0,
    syncingFiles: 0,
    pendingFiles: 0,
  };
  if (!nodes) return out;
  for (const node of nodes) {
    const childPath = prefix ? `${prefix}/${node.name}` : node.name;
    if (node.type === "FILE_INFO_TYPE_DIRECTORY") {
      const sub = rollupBrowseSubtree(
        node.children,
        childPath,
        needSets,
        transferPaths,
      );
      out.totalFiles += sub.totalFiles;
      out.totalBytes += sub.totalBytes;
      out.syncedFiles += sub.syncedFiles;
      out.syncingFiles += sub.syncingFiles;
      out.pendingFiles += sub.pendingFiles;
    } else {
      if (isJunkFile(node.name)) continue;
      out.totalFiles += 1;
      out.totalBytes += node.size;
      // Live transfers are the strongest "is downloading right
      // now" signal — needSets can lag by a poll cycle when a pull
      // just started. Prefer that, then fall back to needSets.
      if (transferPaths.has(childPath) || needSets.progress.has(childPath)) {
        out.syncingFiles += 1;
      } else if (needSets.pending.has(childPath)) {
        out.pendingFiles += 1;
      } else {
        out.syncedFiles += 1;
      }
    }
  }
  return out;
}

type Entry = FolderEntry | FileEntry;

export function FileGrid({
  folderID,
  folderPath,
  folderType,
  currentPath: controlledPath,
  onNavigate,
  preview: controlledPreview,
  onPreview,
  compact = false,
  members = [],
  memberCount = 1,
  onOpenTeam,
}: {
  folderID: string;
  folderPath?: string;
  // Folder sync mode. Send-only folders never pull, so we don't augment the
  // grid with not-yet-local "needed" files (they'd show as Queued forever —
  // e.g. a stale name left in the cluster index after a local rename).
  folderType?: string;
  // Optional controlled navigation. When provided, the directory the
  // grid shows is driven from outside (the FileTree pane) so the tree
  // and grid stay in sync; the breadcrumb routes through onNavigate
  // too. When omitted, the grid keeps its own internal path state and
  // behaves exactly as before.
  currentPath?: string;
  onNavigate?: (path: string) => void;
  // Optional controlled preview. When provided, the open video is driven
  // from outside (so the FileTree pane can open / switch it too). When
  // omitted, the grid manages it internally. `null` = no video open.
  preview?: VideoPreviewFile | null;
  onPreview?: (file: VideoPreviewFile | null) => void;
  // Dense layout for when the grid is squeezed next to the player dock.
  compact?: boolean;
  // Collaborators shown in the toolbar's member stack, plus the total
  // (incl. you) and a handler to open the project's Team view.
  members?: ProjectMemberSummary[];
  memberCount?: number;
  onOpenTeam?: () => void;
}) {
  // Global (not local) browse: we want the COMPLETE file list — every
  // file the cluster knows about — so each row can show its own status
  // (synced / downloading / queued) from the moment the index arrives,
  // instead of files popping in only as they finish downloading. With
  // local:true the tree held only already-synced files, so during an
  // active sync the grid showed nothing but the need-overlay's
  // downloading/queued rows. Status is derived per-file below from
  // /rest/db/need + live transfers; anything in the global tree but
  // absent from need is synced. Local-delete lag (a file removed here
  // but still present in the global tree until the deletion propagates)
  // is masked by the recentlyDeleted optimistic filter below — that's
  // precisely what it exists for.
  const browse = useFolderBrowse(folderID);
  const need = useFolderNeed(folderID);
  const transfers = useTransfersForFolder(folderID);
  const activity = useActivity(folderID);

  // recentlyDeleted: optimistic-UI workaround for the lag between
  // "watcher saw the delete locally" (CLIPS counter drops, daemon's
  // local index updated) and "global tree reflects the delete" (which
  // can wait on other peers acking the deletion update). Without this
  // filter the FileGrid keeps rendering files the user just removed
  // from disk. Walk the activity log newest-first; record paths with
  // action="deleted" inside the window, drop them on any later
  // non-deleted action against the same path (the file came back —
  // typical receive-only revert flow).
  const RECENT_DELETE_WINDOW_MS = 60_000;
  const recentlyDeleted = useMemo(() => {
    const out = new Set<string>();
    const cutoff = Date.now() - RECENT_DELETE_WINDOW_MS;
    for (const a of activity) {
      const t = new Date(a.time).getTime();
      if (!Number.isFinite(t) || t < cutoff) break;
      if (a.action === "deleted") {
        if (!out.has(`!${a.name}`)) out.add(a.name);
      } else {
        // Mark as "came back" so any older deletion entry for this
        // path stops hiding it. Sentinel key prevents the later
        // "deleted" branch from re-adding.
        out.delete(a.name);
        out.add(`!${a.name}`);
      }
    }
    // Strip sentinel keys so callers see only paths to hide.
    for (const k of [...out]) if (k.startsWith("!")) out.delete(k);
    return out;
  }, [activity]);

  useEffect(() => {
    bc(`FileGrid mount folder=${folderID}`);
    return () => {
      bc(`FileGrid unmount folder=${folderID}`);
    };
  }, [folderID]);

  const prioritize = useBringToFront();
  const unread = useUnread(folderID);
  const [filter, setFilter] = useState("");
  const [view, setView] = useState<View>("grid");
  const [sort, setSort] = useState<SortKey>("recent");
  const [appearance, setAppearance] = useState<Appearance>(loadAppearance);
  const updateAppearance = (patch: Partial<Appearance>) =>
    setAppearance((a) => {
      const next = { ...a, ...patch };
      saveAppearance(next);
      return next;
    });
  // Multi-select: a set of selected file paths (files only, never
  // folders). Drives the per-card checkbox + accent highlight border.
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const toggleSelect = (path: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  // Empty string = project root. Anything below is a "/"-joined POSIX
  // path matching the keys returned by /rest/db/browse. Controlled by
  // the parent when currentPath/onNavigate props are supplied (tree
  // pane drives navigation); otherwise self-managed.
  const [internalPath, setInternalPath] = useState("");
  const currentPath = controlledPath ?? internalPath;
  const setCurrentPath = onNavigate ?? setInternalPath;
  const [menu, setMenu] = useState<{
    x: number;
    y: number;
    file: FileEntry;
  } | null>(null);
  const [details, setDetails] = useState<FileDetails | null>(null);
  // Controlled by the parent when preview/onPreview are supplied (so the
  // tree pane can open/switch the player); otherwise self-managed.
  const [internalPreview, setInternalPreview] = useState<VideoPreviewFile | null>(
    null,
  );
  const preview = controlledPreview !== undefined ? controlledPreview : internalPreview;
  const setPreview = onPreview ?? setInternalPreview;

  const needSets = useMemo(
    () =>
      makeNeedSets({
        progress: need.data?.progress ?? undefined,
        queued: need.data?.queued ?? undefined,
        rest: need.data?.rest ?? undefined,
      }),
    [need.data],
  );

  // Paths currently being pulled, per the realtime DownloadProgress
  // stream. Used as a "live" syncing signal that complements the
  // poll-based needSets — when the daemon kicks off a pull but
  // /rest/db/need hasn't refreshed yet, this is what surfaces the
  // file as in-flight.
  const transferPaths = useMemo<ReadonlySet<string>>(
    () => new Set(Object.keys(transfers.progress)),
    [transfers.progress],
  );

  // Entries at the *current directory*. Folders come back first
  // (alphabetic), then files (by sync state, then alphabetic). Search
  // is recursive when the user types — finding a file deep in the
  // tree shouldn't require manually drilling into every folder.
  //
  // We start from /rest/db/browse (what's actually on disk) and then
  // augment with files from /rest/db/need that aren't yet local.
  // Without the augmentation, in-flight transfers and queued files
  // wouldn't render until they finished syncing — defeating the
  // point of a "Files" view during the initial sync.
  // Send-only folders never download, so a "needed" file (in the cluster but
  // not local) would linger as a permanent Queued ghost — notably the old
  // name after a local rename. Skip the need-augmentation for them.
  const pullsFiles = folderType !== "sendonly";

  const entries = useMemo<Entry[]>(() => {
    const needList: { path: string; size: number; modified: string }[] = [];
    for (const bucket of pullsFiles
      ? [
          need.data?.progress ?? [],
          need.data?.queued ?? [],
          need.data?.rest ?? [],
        ]
      : []) {
      for (const f of bucket) {
        // /rest/db/need serializes the file type as the protobuf enum
        // name (FileType().String()), so a regular file is
        // "FILE_INFO_TYPE_FILE" — same vocabulary as /rest/db/browse,
        // NOT the bare "FILE" the older REST shape used. Comparing
        // against "FILE" here dropped every queued/downloading entry,
        // leaving the grid showing only already-synced files.
        if (f.type !== "FILE_INFO_TYPE_FILE") continue;
        needList.push({ path: f.name, size: f.size, modified: f.modified });
      }
    }

    const q = filter.trim().toLowerCase();
    if (q) {
      const flat: { path: string; name: string; size: number; modified: string }[] = [];
      if (Array.isArray(browse.data)) {
        flat.push(...flattenFiles(browse.data as BrowseEntry[], ""));
      }
      // Add needed files we haven't already seen locally.
      const seen = new Set(flat.map((f) => f.path));
      for (const n of needList) {
        if (seen.has(n.path)) continue;
        const leaf = n.path.split("/").pop() ?? n.path;
        if (isJunkFile(leaf)) continue;
        seen.add(n.path);
        flat.push({
          path: n.path,
          name: leaf,
          size: n.size,
          modified: n.modified,
        });
      }
      return flat
        .filter((f) => f.path.toLowerCase().includes(q))
        .filter((f) => !recentlyDeleted.has(f.path))
        .map<FileEntry>((f) => ({
          kind: "file",
          ...f,
          state: deriveState(f.path, needSets, transfers),
        }))
        .sort((a, b) => compareEntries(a, b, sort));
    }

    // Flatten Folders (Appearance): list every file under the current path
    // recursively, hiding folders — same flat-file shape as search.
    if (appearance.flatten) {
      const subtree = Array.isArray(browse.data)
        ? nodeAt(browse.data, currentPath)
        : null;
      const flat = subtree ? flattenFiles(subtree, currentPath) : [];
      const prefix = currentPath ? currentPath + "/" : "";
      const seen = new Set(flat.map((f) => f.path));
      for (const n of needList) {
        if (!n.path.startsWith(prefix)) continue;
        if (seen.has(n.path)) continue;
        const leaf = n.path.split("/").pop() ?? n.path;
        if (isJunkFile(leaf)) continue;
        seen.add(n.path);
        flat.push({ path: n.path, name: leaf, size: n.size, modified: n.modified });
      }
      return flat
        .filter((f) => !recentlyDeleted.has(f.path))
        .map<FileEntry>((f) => ({
          kind: "file",
          ...f,
          state: deriveState(f.path, needSets, transfers),
        }))
        .sort((a, b) => compareEntries(a, b, sort));
    }

    const node = Array.isArray(browse.data)
      ? nodeAt(browse.data, currentPath)
      : null;
    const out: Entry[] = [];
    const seenPaths = new Set<string>();
    const seenFolderNames = new Set<string>();
    if (node) {
      for (const item of node) {
        const childPath = currentPath ? `${currentPath}/${item.name}` : item.name;
        // Hide junk + the comments sidecar dir (covers folders too, which the
        // file-only branch below doesn't reach).
        if (isJunkFile(item.name)) continue;
        if (item.type === "FILE_INFO_TYPE_DIRECTORY") {
          seenFolderNames.add(item.name);
          // Roll up everything underneath this folder so the row can
          // show size, file count, and a sync-state chip without an
          // extra round trip.
          const aggregate = rollupBrowseSubtree(
            item.children,
            childPath,
            needSets,
            transferPaths,
          );
          // If files inside this subtree haven't surfaced in the browse
          // tree yet (initial sync), they're in needList. Fold them in
          // so the count and bytes are honest while syncing.
          for (const n of needList) {
            const subPrefix = childPath + "/";
            if (!n.path.startsWith(subPrefix)) continue;
            if (isJunkFile(n.path.split("/").pop() ?? "")) continue;
            aggregate.totalFiles += 1;
            aggregate.totalBytes += n.size;
            if (transferPaths.has(n.path) || needSets.progress.has(n.path)) {
              aggregate.syncingFiles += 1;
            } else if (needSets.pending.has(n.path)) {
              aggregate.pendingFiles += 1;
            } else {
              aggregate.syncedFiles += 1;
            }
          }
          out.push({
            kind: "folder",
            path: childPath,
            name: item.name,
            childCount: item.children?.length ?? 0,
            aggregate,
          });
        } else {
          if (isJunkFile(item.name)) continue;
          if (recentlyDeleted.has(childPath)) continue;
          seenPaths.add(childPath);
          out.push({
            kind: "file",
            path: childPath,
            name: item.name,
            size: item.size,
            modified: item.modTime,
            state: deriveState(childPath, needSets, transfers),
          });
        }
      }
    }

    // Merge needed-but-not-yet-local entries scoped to the current
    // directory. Direct file children render as FileEntry; deeper
    // paths surface a synthesized FolderEntry placeholder if we
    // don't already have that folder locally (so users can drill in
    // even before any file inside has finished syncing).
    const prefix = currentPath ? currentPath + "/" : "";
    for (const n of needList) {
      if (!n.path.startsWith(prefix)) continue;
      const remainder = n.path.slice(prefix.length);
      if (!remainder) continue;
      const slash = remainder.indexOf("/");
      if (slash === -1) {
        // Direct file child.
        if (isJunkFile(remainder)) continue;
        if (recentlyDeleted.has(n.path)) continue;
        if (seenPaths.has(n.path)) continue;
        seenPaths.add(n.path);
        out.push({
          kind: "file",
          path: n.path,
          name: remainder,
          size: n.size,
          modified: n.modified,
          state: deriveState(n.path, needSets, transfers),
        });
      } else {
        // Need lives inside a subdirectory at this level.
        const dirName = remainder.slice(0, slash);
        if (isJunkFile(dirName)) continue;
        if (seenFolderNames.has(dirName)) continue;
        seenFolderNames.add(dirName);
        // Roll up everything in needList that's under this synthesized
        // folder. childCount stays approximate (immediate children
        // would require deduplicating one level deeper) but totals
        // are honest.
        const subPrefix = prefix + dirName + "/";
        const aggregate: FolderAggregateInfo = {
          totalFiles: 0,
          totalBytes: 0,
          syncedFiles: 0,
          syncingFiles: 0,
          pendingFiles: 0,
        };
        for (const nf of needList) {
          if (!nf.path.startsWith(subPrefix)) continue;
          if (isJunkFile(nf.path.split("/").pop() ?? "")) continue;
          aggregate.totalFiles += 1;
          aggregate.totalBytes += nf.size;
          if (transferPaths.has(nf.path) || needSets.progress.has(nf.path)) {
            aggregate.syncingFiles += 1;
          } else if (needSets.pending.has(nf.path)) {
            aggregate.pendingFiles += 1;
          } else {
            aggregate.syncedFiles += 1;
          }
        }
        out.push({
          kind: "folder",
          path: prefix + dirName,
          name: dirName,
          childCount: aggregate.totalFiles,
          aggregate,
        });
      }
    }
    return out.sort((a, b) => compareEntries(a, b, sort));
  }, [browse.data, need.data, currentPath, filter, needSets, transferPaths, transfers, recentlyDeleted, sort, pullsFiles, appearance.flatten]);

  if (browse.isLoading && !Array.isArray(browse.data)) {
    return <p className="text-sm text-fg-soft">Loading files…</p>;
  }
  // Only show the "nothing here yet" empty state if there's truly
  // nothing — no files locally AND nothing queued/in-flight. While
  // an initial sync is running, entries comes from /rest/db/need
  // (downloading + queued rows) and we want those to render.
  const isRootEmpty =
    currentPath === "" && !filter && entries.length === 0;
  if (isRootEmpty) {
    // pt-3 matches the populated grid's toolbar top padding (see below) so
    // the empty-state card sits at the same offset from the tab strip
    // instead of hugging the hero above it.
    return (
      <div className="pt-3">
        <div className="rounded-xl border border-dashed border-line-strong bg-elevated/40 px-6 py-16 text-center">
          <p className="text-sm text-fg-soft">
            No files yet — they'll appear here as soon as syncing starts.
          </p>
        </div>
      </div>
    );
  }

  const buildMenuItems = (file: FileEntry): ContextMenuItem[] => {
    const abs = joinPath(folderPath ?? "", file.path);
    return [
      {
        label: "Prioritize",
        hint:
          file.state.kind === "synced"
            ? "Already synced"
            : "Move to the front of the queue",
        disabled: file.state.kind === "synced" || prioritize.isPending,
        onSelect: () => prioritize.mutate({ folderID, file: file.path }),
      },
      {
        label: "File details",
        separatorBefore: true,
        onSelect: () =>
          setDetails({
            name: file.name,
            relativePath: file.path,
            absolutePath: abs,
            size: file.size,
            modified: file.modified,
            status: stateForLegacy(file.state),
          }),
      },
      { label: "Copy file name", onSelect: () => copyText(file.name) },
      { label: "Copy relative path", onSelect: () => copyText(file.path) },
      {
        label: "Copy full path",
        disabled: !folderPath,
        hint: folderPath ? undefined : "Folder path unavailable",
        onSelect: () => copyText(abs),
      },
    ];
  };

  const openPreview = (f: FileEntry) =>
    setPreview({
      folderID,
      path: f.path,
      name: f.name,
      size: f.size,
      modified: f.modified,
      kind: mediaKind(f.name) ?? "video",
      // Non-browser video/audio plays from a server-transcoded preview.
      transcode: previewNeedsTranscode(f.name),
    });

  const folderCount = entries.filter((e) => e.kind === "folder").length;
  const fileCount = entries.length - folderCount;

  return (
    <div className="flex h-full min-h-0 flex-col px-3 pb-3">
      {/* pt-3 keeps the search row off the dock's top edge. */}
      <div className="shrink-0 space-y-3 pt-3">
        <Toolbar
          filter={filter}
          onFilter={setFilter}
          view={view}
          onView={setView}
          sort={sort}
          onSort={setSort}
          appearance={appearance}
          onAppearance={updateAppearance}
          folderCount={folderCount}
          fileCount={fileCount}
          members={members}
          memberCount={memberCount}
          onOpenTeam={onOpenTeam}
        />
        {!filter && (
          <Breadcrumb path={currentPath} onNavigate={setCurrentPath} />
        )}
      </div>
      {/* Scrollable list region. Toolbar + breadcrumb stay anchored
          above; the entries pane scrolls independently. */}
      <div className="mt-3 min-h-0 flex-1 overflow-y-auto">
        {entries.length === 0 ? (
          <div className="rounded-xl border border-dashed border-line-strong bg-elevated/40 px-6 py-12 text-center">
            <p className="text-sm text-fg-soft">
              {filter ? "No files match your search." : "This folder is empty."}
            </p>
          </div>
        ) : view === "grid" ? (
          <div
            className={cn(
              "grid gap-2.5",
              // When squeezed beside the player, force a dense 2-col grid
              // (Tailwind's responsive cols are viewport- not container-based,
              // so they can't react to the narrowed panel on their own).
              compact ? "grid-cols-2" : GRID_COLS[appearance.size],
            )}
          >
            {entries.map((e) =>
              e.kind === "folder" ? (
                <FolderTile
                  key={e.path}
                  entry={e}
                  unread={unread.isFolderUnread(e.path)}
                  appearance={appearance}
                  onOpen={() => setCurrentPath(e.path)}
                />
              ) : (
                <FileTile
                  key={e.path}
                  file={e}
                  folderID={folderID}
                  unread={unread.isVideoUnread(e.path)}
                  appearance={appearance}
                  selected={selected.has(e.path)}
                  active={preview?.path === e.path}
                  onToggleSelect={() => toggleSelect(e.path)}
                  onContextMenu={(x, y) => setMenu({ x, y, file: e })}
                  onPreview={() => openPreview(e)}
                />
              ),
            )}
          </div>
        ) : (
          <ul className="divide-y divide-line overflow-hidden rounded-xl border border-line bg-elevated">
            {entries.map((e) => (
              <li key={e.path}>
                {e.kind === "folder" ? (
                  <FolderRow
                    entry={e}
                    folderID={folderID}
                    unread={unread.isFolderUnread(e.path)}
                    onOpen={() => setCurrentPath(e.path)}
                  />
                ) : (
                  <FileRow
                    file={e}
                    folderID={folderID}
                    unread={unread.isVideoUnread(e.path)}
                    onContextMenu={(x, y) => setMenu({ x, y, file: e })}
                    onPreview={() => openPreview(e)}
                  />
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          items={buildMenuItems(menu.file)}
          onClose={() => setMenu(null)}
        />
      )}
      <FileDetailsModal
        open={details !== null}
        onClose={() => setDetails(null)}
        file={details}
      />
    </div>
  );
}

function Toolbar({
  filter,
  onFilter,
  view,
  onView,
  sort,
  onSort,
  appearance,
  onAppearance,
  folderCount,
  fileCount,
  members,
  memberCount,
  onOpenTeam,
}: {
  filter: string;
  onFilter: (v: string) => void;
  view: View;
  onView: (v: View) => void;
  sort: SortKey;
  onSort: (s: SortKey) => void;
  appearance: Appearance;
  onAppearance: (patch: Partial<Appearance>) => void;
  folderCount: number;
  fileCount: number;
  members: ProjectMemberSummary[];
  memberCount: number;
  onOpenTeam?: () => void;
}) {
  // Compact summary: "3 folders · 12 files", dropping zero terms.
  const parts: string[] = [];
  if (folderCount > 0) {
    parts.push(`${folderCount.toLocaleString()} folder${folderCount === 1 ? "" : "s"}`);
  }
  if (fileCount > 0 || folderCount === 0) {
    parts.push(`${fileCount.toLocaleString()} file${fileCount === 1 ? "" : "s"}`);
  }
  return (
    <div className="flex items-center gap-3">
      {/* Left: display controls — Appearance (grid only), Sort, View. */}
      {view === "grid" && (
        <AppearanceMenu appearance={appearance} onAppearance={onAppearance} />
      )}
      <label className="flex shrink-0 items-center gap-1.5 text-xs text-fg-soft">
        <span className="hidden sm:inline">Sort</span>
        <select
          value={sort}
          onChange={(e) => onSort(e.target.value as SortKey)}
          className="rounded-md border border-line bg-panel py-1 pl-2 pr-7 text-xs text-fg-strong focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent"
          aria-label="Sort files"
        >
          {SORT_LABELS.map((s) => (
            <option key={s.value} value={s.value}>
              {s.label}
            </option>
          ))}
        </select>
      </label>
      <div className="inline-flex rounded-lg bg-panel p-0.5 ring-1 ring-line">
        <ViewToggle
          active={view === "grid"}
          onClick={() => onView("grid")}
          label="Grid"
          icon={<GridIcon />}
        />
        <ViewToggle
          active={view === "list"}
          onClick={() => onView("list")}
          label="List"
          icon={<ListIcon />}
        />
      </div>
      <span className="shrink-0 text-xs text-fg-faint">{parts.join(" · ")}</span>

      {/* Right: team avatars + search. */}
      <div className="ml-auto flex items-center gap-3">
        <MemberStack
          members={members}
          memberCount={memberCount}
          onOpenTeam={onOpenTeam}
        />
        <div className="relative w-56 shrink-0 lg:w-64">
          <SearchGlyph />
          <input
            value={filter}
            onChange={(e) => onFilter(e.target.value)}
            placeholder="Search files…"
            className="w-full rounded-lg border border-line bg-panel py-2 pl-9 pr-3 text-sm text-fg-strong placeholder:text-fg-faint focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent"
          />
        </div>
      </div>
    </div>
  );
}

// MemberStack: overlapping collaborator avatars + a count, shown beside
// the search box. Clicking opens the project's Team view. Mirrors the
// Frame.io member cluster; the count includes you.
function MemberStack({
  members,
  memberCount,
  onOpenTeam,
}: {
  members: ProjectMemberSummary[];
  memberCount: number;
  onOpenTeam?: () => void;
}) {
  const shown = members.slice(0, 3);
  const overflow = members.length - shown.length;
  return (
    <button
      type="button"
      onClick={onOpenTeam}
      title="Team"
      aria-label={`Team — ${memberCount} member${memberCount === 1 ? "" : "s"}`}
      className="flex shrink-0 items-center gap-2 rounded-lg px-1.5 py-1 transition-colors hover:bg-hover"
    >
      <div className="flex -space-x-2">
        {shown.map((m) => (
          <span key={m.id} className="rounded-full ring-2 ring-base" title={m.label}>
            <PresenceAvatar label={m.label} state={m.state} />
          </span>
        ))}
        {overflow > 0 && (
          <span className="flex h-8 w-8 items-center justify-center rounded-full bg-elevated text-[10px] font-semibold text-fg-soft ring-2 ring-base">
            +{overflow}
          </span>
        )}
        {shown.length === 0 && (
          <span className="flex h-8 w-8 items-center justify-center rounded-full bg-elevated text-fg-soft ring-2 ring-base">
            <svg viewBox="0 0 20 20" fill="currentColor" className="h-4 w-4" aria-hidden>
              <path d="M10 10a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM4 17a6 6 0 0 1 12 0H4z" />
            </svg>
          </span>
        )}
      </div>
      <span className="text-xs font-medium tabular-nums text-fg-soft">{memberCount}</span>
    </button>
  );
}

// AppearanceMenu: the Frame.io-style display popover. Card size and
// aspect change the grid in place; the two toggles control captions and
// hover-to-play. All four persist via the parent's onAppearance.
function AppearanceMenu({
  appearance,
  onAppearance,
}: {
  appearance: Appearance;
  onAppearance: (patch: Partial<Appearance>) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div className="relative shrink-0" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className={cn(
          "inline-flex items-center gap-1.5 rounded-lg bg-panel px-2.5 py-1.5 text-xs font-medium ring-1 transition-colors",
          open
            ? "text-fg-strong ring-line-strong"
            : "text-fg ring-line hover:ring-line-strong",
        )}
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" className="h-4 w-4 text-fg-soft" aria-hidden>
          <line x1="21" y1="5" x2="14" y2="5" /><line x1="10" y1="5" x2="3" y2="5" />
          <line x1="21" y1="12" x2="12" y2="12" /><line x1="8" y1="12" x2="3" y2="12" />
          <line x1="21" y1="19" x2="16" y2="19" /><line x1="12" y1="19" x2="3" y2="19" />
          <line x1="14" y1="3" x2="14" y2="7" /><line x1="8" y1="10" x2="8" y2="14" /><line x1="16" y1="17" x2="16" y2="21" />
        </svg>
        <span className="hidden sm:inline">Appearance</span>
      </button>
      {open && (
        <div className="absolute left-0 top-full z-30 mt-2 w-72 rounded-xl border border-line-strong bg-elevated p-4 shadow-2xl shadow-black/60">
          <div className="mb-3 flex items-center justify-between">
            <div className="flex items-center gap-1.5">
              <span className="text-sm font-semibold text-fg-strong">Appearance</span>
              <svg viewBox="0 0 20 20" fill="none" className="h-3.5 w-3.5 text-fg-faint" aria-hidden>
                <circle cx="10" cy="10" r="7" stroke="currentColor" strokeWidth="1.4" />
                <path d="M10 9v4M10 6.5h.01" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
              </svg>
            </div>
            <span className="text-[10px] text-fg-faint">Visible to only you</span>
          </div>
          <div className="space-y-3 text-sm">
            <Segmented
              label="Card Size"
              value={appearance.size}
              options={[
                { value: "S", label: "S" },
                { value: "M", label: "M" },
                { value: "L", label: "L" },
              ]}
              onChange={(size) => onAppearance({ size: size as CardSize })}
            />
            <Segmented
              label="Aspect Ratio"
              value={appearance.aspect}
              options={[
                { value: "video", label: "16:9" },
                { value: "square", label: "1:1" },
              ]}
              onChange={(aspect) => onAppearance({ aspect: aspect as CardAspect })}
            />
            <Segmented
              label="Thumbnail Scale"
              value={appearance.scale}
              options={[
                { value: "fill", label: "Fill" },
                { value: "fit", label: "Fit" },
              ]}
              onChange={(scale) => onAppearance({ scale: scale as CardScale })}
            />
            <div className="my-1 h-px bg-line" />
            <Toggle
              label="Show Card Info"
              checked={appearance.showInfo}
              onChange={(v) => onAppearance({ showInfo: v })}
            />
            <Toggle
              label="Titles"
              checked={appearance.showNames}
              onChange={(v) => onAppearance({ showNames: v })}
            />
            <Toggle
              label="Flatten Folders"
              checked={appearance.flatten}
              onChange={(v) => onAppearance({ flatten: v })}
            />
          </div>
        </div>
      )}
    </div>
  );
}

function Segmented({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: { value: string; label: string }[];
  onChange: (v: string) => void;
}) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-fg">{label}</span>
      <div className="inline-flex rounded-md bg-panel p-0.5 text-[11px] ring-1 ring-line">
        {options.map((o) => (
          <button
            key={o.value}
            type="button"
            onClick={() => onChange(o.value)}
            className={cn(
              "rounded px-2 py-0.5 font-medium transition-colors",
              value === o.value
                ? "bg-accent/20 text-accent"
                : "text-fg-soft hover:text-fg-strong",
            )}
          >
            {o.label}
          </button>
        ))}
      </div>
    </div>
  );
}

function Toggle({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <button
      type="button"
      onClick={() => onChange(!checked)}
      className="flex w-full items-center justify-between"
    >
      <span className={checked ? "text-fg" : "text-fg-soft"}>{label}</span>
      <span
        className={cn(
          "relative h-5 w-9 rounded-full transition-colors",
          checked ? "bg-accent" : "bg-panel ring-1 ring-line",
        )}
      >
        <span
          className={cn(
            "absolute top-0.5 h-4 w-4 rounded-full transition-all",
            checked ? "left-[18px] bg-white" : "left-0.5 bg-fg-faint",
          )}
        />
      </span>
    </button>
  );
}

// Breadcrumb: "Files / sub / deeper" with clickable segments. The root
// click resets to currentPath="". Each crumb returns to that level.
function Breadcrumb({
  path,
  onNavigate,
}: {
  path: string;
  onNavigate: (next: string) => void;
}) {
  const segments = path ? path.split("/") : [];
  return (
    <nav className="flex items-center gap-1 text-sm text-fg-soft" aria-label="Breadcrumb">
      <button
        type="button"
        onClick={() => onNavigate("")}
        className={cn(
          "rounded-md px-2 py-1 transition-colors",
          segments.length === 0
            ? "text-fg-strong"
            : "hover:bg-hover hover:text-fg-strong",
        )}
      >
        Files
      </button>
      {segments.map((seg, i) => {
        const target = segments.slice(0, i + 1).join("/");
        const isLast = i === segments.length - 1;
        return (
          <span key={target} className="flex items-center gap-1">
            <span className="text-fg-faint">/</span>
            <button
              type="button"
              onClick={() => onNavigate(target)}
              className={cn(
                "truncate rounded-md px-2 py-1 transition-colors",
                isLast
                  ? "text-fg-strong"
                  : "hover:bg-hover hover:text-fg-strong",
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

// --- Grid tile ----------------------------------------------------------

function FileTile({
  file,
  folderID,
  unread,
  appearance,
  selected = false,
  active = false,
  onToggleSelect,
  onContextMenu,
  onPreview,
}: {
  file: FileEntry;
  folderID: string;
  unread?: boolean;
  appearance: Appearance;
  // selected = ticked via its checkbox (multi-select); active = currently
  // open in the review player. Both draw an accent highlight border.
  selected?: boolean;
  active?: boolean;
  onToggleSelect?: () => void;
  onContextMenu: (x: number, y: number) => void;
  onPreview: () => void;
}) {
  const synced = file.state.kind === "synced";
  // Thumbnail (poster/waveform/still) for any synced video/audio/image —
  // ffmpeg handles the decode server-side. Clicking opens the preview surface
  // for any video, audio, or image; hover-to-play only applies to video.
  const thumbable = synced && isThumbnailable(file.name);
  const openable = synced && isPreviewable(file.name);
  const hoverable = synced && appearance.hoverToPlay && isPlayable(file.name);
  const transcode = needsTranscode(file.name);

  // Hover-to-play preview. We delay mounting the <video> by a beat so a
  // quick mouse sweep across the grid doesn't spin up (and immediately
  // tear down) a decoder on every tile — that churn is what crashes
  // WebView2. Only one decoder lives at a time per tile, and it unmounts
  // on mouse-out, releasing the decoder right away.
  const [hoverPlay, setHoverPlay] = useState(false);
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clearHoverTimer = () => {
    if (hoverTimer.current !== null) {
      clearTimeout(hoverTimer.current);
      hoverTimer.current = null;
    }
  };
  const onEnter = () => {
    if (!hoverable) return;
    clearHoverTimer();
    hoverTimer.current = setTimeout(() => setHoverPlay(true), 250);
  };
  const onLeave = () => {
    clearHoverTimer();
    setHoverPlay(false);
  };
  useEffect(() => () => clearHoverTimer(), []);

  return (
    <div
      className={cn(
        "group relative select-none overflow-hidden rounded-xl border bg-elevated shadow-sm transition-colors hover:shadow-lg",
        selected || active
          ? "border-accent ring-1 ring-accent"
          : "border-line hover:border-line-strong",
        openable ? "cursor-pointer" : "cursor-default",
      )}
      title={`${file.path}\n${humanBytes(file.size)}`}
      onClick={() => {
        if (openable) onPreview();
      }}
      onMouseEnter={onEnter}
      onMouseLeave={onLeave}
      onContextMenu={(e) => {
        e.preventDefault();
        onContextMenu(e.clientX, e.clientY);
      }}
    >
      {/* Multi-select checkbox — top-left, appears on hover or when ticked.
          stopPropagation so ticking doesn't also open the player. */}
      {onToggleSelect && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onToggleSelect();
          }}
          aria-label={selected ? "Deselect" : "Select"}
          aria-pressed={selected}
          className={cn(
            "absolute left-2 top-2 z-10 flex h-5 w-5 items-center justify-center rounded-[5px] border transition-all",
            selected
              ? "border-accent bg-accent text-white opacity-100"
              : "border-white/60 bg-black/40 text-transparent opacity-0 backdrop-blur-sm group-hover:opacity-100",
          )}
        >
          <svg viewBox="0 0 20 20" fill="currentColor" className="h-3.5 w-3.5" aria-hidden>
            <path d="M16.7 5.3a1 1 0 0 1 0 1.4l-7 7a1 1 0 0 1-1.4 0l-3-3a1 1 0 1 1 1.4-1.4l2.3 2.29 6.3-6.29a1 1 0 0 1 1.4 0z" />
          </svg>
        </button>
      )}
      <div
        className={cn(
          "relative w-full overflow-hidden bg-black",
          appearance.aspect === "square" ? "aspect-square" : "aspect-video",
        )}
      >
        <TileThumbnail
          file={file}
          folderID={folderID}
          enabled={thumbable}
          scale={appearance.scale}
        />
        {hoverPlay && (
          <HoverPreviewVideo
            folderID={folderID}
            path={file.path}
            transcode={transcode}
            size={file.size}
            modified={file.modified}
          />
        )}
        <div className="absolute right-1.5 top-1.5">
          <StateChip state={file.state} />
        </div>
        {unread && (
          <div className="absolute bottom-1.5 left-1.5 rounded bg-base/70 p-0.5 ring-1 ring-red-500/40">
            <UnreadBadge />
          </div>
        )}
        {file.state.kind === "syncing" && (
          <div className="absolute inset-x-0 bottom-0 h-0.5 bg-black/40">
            <div
              className="h-full bg-accent transition-[width]"
              style={{
                width: `${Math.max(2, Math.min(100, file.state.pct))}%`,
              }}
            />
          </div>
        )}
      </div>
      {(appearance.showNames || appearance.showInfo) && (
        <div className="px-2.5 py-2">
          {appearance.showNames && (
            <div
              className="truncate text-xs font-medium text-fg-strong"
              title={file.path}
            >
              {file.name}
            </div>
          )}
          {appearance.showInfo && (
            <div className="mt-0.5 truncate text-[10px] text-fg-faint">
              {humanBytes(file.size)} · {humanRelative(file.modified)}
              {file.state.kind === "syncing" && file.state.ratePerSec > 0 && (
                <>
                  {" · "}
                  <span className="text-amber-300">
                    {humanRate(file.state.ratePerSec)}
                  </span>
                </>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// --- Folder tile/row ----------------------------------------------------

function FolderTile({
  entry,
  unread,
  appearance,
  onOpen,
}: {
  entry: FolderEntry;
  unread?: boolean;
  appearance: Appearance;
  onOpen: () => void;
}) {
  const subtitle = folderSubtitle(entry.aggregate, entry.childCount);
  return (
    <button
      type="button"
      onClick={onOpen}
      title={entry.path}
      className="group flex cursor-pointer flex-col overflow-hidden rounded-xl border border-line bg-elevated text-left shadow-sm transition-colors hover:border-line-strong hover:shadow-lg focus:outline-none focus:ring-2 focus:ring-accent"
    >
      <div
        className={cn(
          "relative w-full overflow-hidden",
          appearance.aspect === "square" ? "aspect-square" : "aspect-video",
        )}
        style={{ backgroundImage: folderGradient(entry.path) }}
      >
        <div className="absolute inset-0 flex items-center justify-center">
          <FolderIcon className="h-10 w-10 text-white/35" />
        </div>
        <div className="pointer-events-none absolute inset-0 bg-gradient-to-t from-black/45 via-transparent to-transparent" />
        <div className="absolute left-1.5 top-1.5 flex h-5 items-center gap-1 rounded bg-black/40 px-1.5 text-[10px] font-medium text-white ring-1 ring-white/10 backdrop-blur-sm">
          <FolderIcon className="h-3 w-3" />
          <span>{entry.aggregate.totalFiles.toLocaleString()}</span>
        </div>
        <div className="absolute right-1.5 top-1.5 flex items-center gap-1">
          {unread && (
            <span className="rounded bg-base/70 p-0.5 ring-1 ring-red-500/40">
              <UnreadBadge />
            </span>
          )}
          <FolderStateChip aggregate={entry.aggregate} />
        </div>
      </div>
      {(appearance.showNames || appearance.showInfo) && (
        <div className="px-2.5 py-2">
          {appearance.showNames && (
            <div className="truncate text-xs font-medium text-fg-strong">
              {entry.name}
            </div>
          )}
          {appearance.showInfo && (
            <div className="mt-0.5 truncate text-[10px] text-fg-faint">{subtitle}</div>
          )}
        </div>
      )}
    </button>
  );
}

// folderGradient returns a deterministic cinematic gradient for a folder
// tile — replaces the old 4-thumbnail collage with a clean colored swatch
// (matching the redesign mockups). Picked by a stable hash of the path.
const FOLDER_GRADIENTS = [
  "linear-gradient(135deg,#1a2740 0%,#0e1830 45%,#06101f 100%)",
  "radial-gradient(120% 120% at 30% 10%,#3a2a1c 0%,#1c130b 55%,#0b0805 100%)",
  "linear-gradient(160deg,#2a1530 0%,#160a22 50%,#08040f 100%)",
  "radial-gradient(120% 100% at 70% 20%,#103030 0%,#0a1d22 55%,#051014 100%)",
  "linear-gradient(135deg,#2b2030 0%,#161023 60%,#0a0814 100%)",
  "radial-gradient(120% 120% at 40% 30%,#26303f 0%,#121821 60%,#080b11 100%)",
  "linear-gradient(150deg,#3b2418 0%,#1f130b 55%,#0b0704 100%)",
  "linear-gradient(135deg,#152a3a 0%,#0c1a28 55%,#06101a 100%)",
];

function folderGradient(path: string): string {
  let h = 0;
  for (let i = 0; i < path.length; i++) h = (h * 31 + path.charCodeAt(i)) >>> 0;
  return FOLDER_GRADIENTS[h % FOLDER_GRADIENTS.length];
}

function FolderRow({
  entry,
  folderID,
  unread,
  onOpen,
}: {
  entry: FolderEntry;
  folderID: string;
  unread?: boolean;
  onOpen: () => void;
}) {
  const thumbs = useFolderCollageThumbs(folderID, 1, entry.path);
  const [thumbBroken, setThumbBroken] = useState(false);
  const thumb = thumbs[0];
  useEffect(() => setThumbBroken(false), [thumb]);
  const a = entry.aggregate;
  const total = a.totalFiles || entry.childCount;
  // Inline metadata strip: count, total bytes, optional in-flight
  // count. Mirrors the file row's compact one-liner layout.
  return (
    <button
      type="button"
      onClick={onOpen}
      title={entry.path}
      className="flex w-full items-center gap-3 px-4 py-1.5 text-left text-sm transition-colors hover:bg-hover"
    >
      <div className="relative h-6 w-10 shrink-0 overflow-hidden rounded bg-base ring-1 ring-line">
        {thumb && !thumbBroken ? (
          <img
            src={thumb}
            alt=""
            aria-hidden
            draggable={false}
            className="absolute inset-0 h-full w-full object-cover"
            onError={() => setThumbBroken(true)}
          />
        ) : (
          <div className="absolute inset-0 flex items-center justify-center bg-gradient-to-br from-indigo-900/40 via-violet-900/30 to-slate-900">
            <FolderIcon className="h-3.5 w-3.5 text-fg-soft" />
          </div>
        )}
      </div>
      <div className="min-w-0 flex-1 truncate font-medium text-fg-strong">
        {entry.name}
      </div>
      {unread && <UnreadBadge className="shrink-0" />}
      <div className="hidden w-20 shrink-0 text-right text-xs tabular-nums text-fg-soft sm:block">
        {total.toLocaleString()} item{total === 1 ? "" : "s"}
      </div>
      <div className="hidden w-20 shrink-0 text-right text-xs tabular-nums text-fg-faint md:block">
        {humanBytes(a.totalBytes)}
      </div>
      <FolderStateChip aggregate={a} />
    </button>
  );
}

// folderSubtitle renders the rollup line under a folder name. Always
// shows file count + total bytes; appends "(N syncing)" or "(N pending)"
// when the subtree isn't fully synced so the user knows there's work
// in flight without drilling in.
function folderSubtitle(
  a: FolderAggregateInfo,
  fallbackCount: number,
): string {
  const total = a.totalFiles || fallbackCount;
  if (total === 0) {
    return "Empty";
  }
  const parts = [
    `${total.toLocaleString()} file${total === 1 ? "" : "s"}`,
    humanBytes(a.totalBytes),
  ];
  if (a.syncingFiles > 0) {
    parts.push(`${a.syncingFiles} syncing`);
  } else if (a.pendingFiles > 0) {
    parts.push(`${a.pendingFiles} pending`);
  }
  return parts.join(" · ");
}

// FolderStateChip surfaces the overall sync state of a folder subtree.
// We mirror the per-file StateChip palette: green when everything is
// in place, amber while there's work in flight, neutral for "fully
// queued but nothing pulling yet". Hidden when the folder is empty.
function FolderStateChip({ aggregate }: { aggregate: FolderAggregateInfo }) {
  if (aggregate.totalFiles === 0) return null;
  if (aggregate.syncingFiles > 0) {
    return <Chip tone="warning" dotPulse label={`Syncing ${aggregate.syncingFiles}`} />;
  }
  if (aggregate.pendingFiles > 0) {
    return <Chip tone="muted" dotPulse={false} label={`${aggregate.pendingFiles} queued`} />;
  }
  return <Chip tone="success" dotPulse={false} label="Synced" />;
}

function FolderIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden
    >
      <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z" />
    </svg>
  );
}

// --- List row -----------------------------------------------------------

function FileRow({
  file,
  folderID,
  unread,
  onContextMenu,
  onPreview,
}: {
  file: FileEntry;
  folderID: string;
  unread?: boolean;
  onContextMenu: (x: number, y: number) => void;
  onPreview: () => void;
}) {
  const synced = file.state.kind === "synced";
  const thumbable = synced && isThumbnailable(file.name);
  // Match FileTile: any video/audio/image opens on click; hover-to-play is
  // video-only.
  const openable = synced && isPreviewable(file.name);
  const hoverable = synced && isPlayable(file.name);
  const transcode = needsTranscode(file.name);

  // Hover-to-play preview, mirroring the grid tile (delayed mount so a quick
  // scroll past rows doesn't spin up a decoder on each one).
  const [hoverPlay, setHoverPlay] = useState(false);
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clearHoverTimer = () => {
    if (hoverTimer.current !== null) {
      clearTimeout(hoverTimer.current);
      hoverTimer.current = null;
    }
  };
  const onEnter = () => {
    if (!hoverable) return;
    clearHoverTimer();
    hoverTimer.current = setTimeout(() => setHoverPlay(true), 250);
  };
  const onLeave = () => {
    clearHoverTimer();
    setHoverPlay(false);
  };
  useEffect(() => () => clearHoverTimer(), []);

  return (
    <div
      className={cn(
        "flex items-center gap-3 px-4 py-1.5 text-sm transition-colors hover:bg-hover",
        openable ? "cursor-pointer" : "cursor-default",
      )}
      onClick={() => {
        if (openable) onPreview();
      }}
      onMouseEnter={onEnter}
      onMouseLeave={onLeave}
      onContextMenu={(e) => {
        e.preventDefault();
        onContextMenu(e.clientX, e.clientY);
      }}
      title={file.path}
    >
      <div className="relative h-6 w-10 shrink-0 overflow-hidden rounded bg-black">
        <TileThumbnail file={file} folderID={folderID} enabled={thumbable} />
        {hoverPlay && (
          <HoverPreviewVideo
            folderID={folderID}
            path={file.path}
            transcode={transcode}
            size={file.size}
            modified={file.modified}
          />
        )}
      </div>
      <div className="min-w-0 flex-1 truncate font-medium text-fg-strong">
        {file.name}
      </div>
      {unread && <UnreadBadge className="shrink-0" />}
      <div className="hidden w-20 shrink-0 text-right text-xs tabular-nums text-fg-soft sm:block">
        {humanBytes(file.size)}
      </div>
      <div className="hidden w-20 shrink-0 text-right text-xs text-fg-faint md:block">
        {humanRelative(file.modified)}
      </div>
      <div className="shrink-0">
        <StateChip state={file.state} />
      </div>
    </div>
  );
}

// --- Thumbnail ----------------------------------------------------------

function TileThumbnail({
  file,
  folderID,
  enabled,
  scale = "fill",
}: {
  file: FileEntry;
  folderID: string;
  enabled: boolean;
  scale?: CardScale;
}) {
  // The daemon generates the poster/waveform with ffmpeg and caches it,
  // so we just point an <img> at /rest/folder/thumb. This works for every
  // format ffmpeg can read (incl. ones the browser can't decode) and
  // doesn't depend on OS media codecs. A 204 (no thumbnail could be made)
  // surfaces as an image error → we fall back to the extension glyph.
  const [errored, setErrored] = useState(false);
  // Some browser-renderable images (e.g. SVG) aren't decodable by ffmpeg, so
  // the daemon thumb 204s. Fall back to the raw file before the glyph.
  const [raw, setRaw] = useState(false);
  // Reset on file identity change (new content, etc.).
  useEffect(() => {
    setErrored(false);
    setRaw(false);
  }, [file.path, file.size, file.modified]);

  if (enabled && !errored) {
    const src = raw
      ? buildFileURL(folderID, file.path)
      : thumbURL(folderID, file.path, file.size, file.modified);
    return (
      <img
        src={src}
        alt=""
        className={cn(
          "h-full w-full",
          scale === "fit" ? "object-contain" : "object-cover",
        )}
        loading="lazy"
        decoding="async"
        draggable={false}
        aria-hidden
        onError={() => {
          if (!raw && isBrowserViewableImage(file.name)) setRaw(true);
          else setErrored(true);
        }}
      />
    );
  }
  return (
    <div
      className={cn(
        "flex h-full w-full items-center justify-center",
        thumbColor(file.name),
      )}
    >
      <ExtensionGlyph name={file.name} />
    </div>
  );
}

// HoverPreviewVideo: muted, looping inline playback shown over the
// thumbnail while the cursor rests on a tile. It streams from the
// Range-capable media server (same source as the full preview), so even
// multi-GB masters play without buffering the whole file into memory —
// no crossOrigin needed since we're not reading pixels back. Unmounting
// (mouse-out) tears the element down and frees the decoder immediately.
function HoverPreviewVideo({
  folderID,
  path,
  transcode,
  size,
  modified,
}: {
  folderID: string;
  path: string;
  // Non-browser formats (MXF, BRAW, …) play a server-transcoded preview clip
  // served same-origin; browser-native formats stream the raw bytes from the
  // Range-capable media server.
  transcode: boolean;
  size: number;
  modified: string;
}) {
  const [src, setSrc] = useState<string | null>(
    transcode ? previewURL(folderID, path, size, modified) : null,
  );
  useEffect(() => {
    if (transcode) {
      setSrc(previewURL(folderID, path, size, modified));
      return;
    }
    let cancelled = false;
    streamingVideoURL(folderID, path).then((u) => {
      if (!cancelled && u) setSrc(u);
    });
    return () => {
      cancelled = true;
    };
  }, [folderID, path, transcode, size, modified]);

  if (!src) return null;
  return (
    <video
      src={src}
      muted
      autoPlay
      loop
      playsInline
      className="absolute inset-0 h-full w-full object-cover"
      aria-hidden
    />
  );
}

// --- State helpers ------------------------------------------------------

function deriveState(
  path: string,
  needSets: { progress: ReadonlySet<string>; pending: ReadonlySet<string> },
  transfers: ReturnType<typeof useTransfersForFolder>,
): FileState {
  const prog = transfers.progress[path];
  if (prog) {
    const pct =
      prog.bytesTotal > 0 ? (prog.bytesDone / prog.bytesTotal) * 100 : 0;
    const ratePerSec = transfers.rates[path]?.bytesPerSec ?? 0;
    return { kind: "syncing", pct, ratePerSec };
  }
  if (needSets.progress.has(path)) {
    // Daemon flagged the file as in-progress but the realtime puller
    // hasn't sent a granular update yet (race on first tick).
    return { kind: "syncing", pct: 0, ratePerSec: 0 };
  }
  if (needSets.pending.has(path)) return { kind: "queued" };
  return { kind: "synced" };
}


// Legacy adapter: FileDetailsModal still takes the old union; map our
// new tagged state back to it without changing that modal's API.
function stateForLegacy(
  s: FileState,
): "synced" | "syncing" | "pending" {
  if (s.kind === "syncing") return "syncing";
  if (s.kind === "queued") return "pending";
  return "synced";
}

function StateChip({ state }: { state: FileState }) {
  if (state.kind === "synced") {
    return (
      <Chip tone="success" dotPulse={false} label="Synced" />
    );
  }
  if (state.kind === "queued") {
    return <Chip tone="muted" dotPulse={false} label="Queued" />;
  }
  const pct = Math.floor(state.pct);
  return (
    <Chip
      tone="warning"
      dotPulse
      label={pct > 0 ? `Downloading ${pct}%` : "Downloading…"}
    />
  );
}

function Chip({
  tone,
  dotPulse,
  label,
}: {
  tone: "success" | "warning" | "muted";
  dotPulse: boolean;
  label: string;
}) {
  const cls =
    tone === "success"
      ? "bg-emerald-500/20 text-emerald-100 ring-emerald-500/40"
      : tone === "warning"
        ? "bg-amber-500/20 text-amber-100 ring-amber-500/40"
        : "bg-slate-700/60 text-slate-100 ring-slate-500/40";
  const dot =
    tone === "success"
      ? "bg-emerald-300"
      : tone === "warning"
        ? "bg-amber-300"
        : "bg-slate-300";
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[10px] font-medium ring-1 backdrop-blur-sm",
        cls,
      )}
    >
      <span
        className={cn(
          "h-1.5 w-1.5 rounded-full",
          dot,
          dotPulse && "animate-pulse",
        )}
        aria-hidden
      />
      {label}
    </span>
  );
}

// --- Extension helpers --------------------------------------------------
// Media format lists/helpers live in lib/videoFormats (shared with FileTree).
// The archive/project lists below are local to the grid's icon coloring.

// Whether we ask the daemon (ffmpeg) for a poster/waveform/still thumbnail.
// Covers every video, audio, and image format ffmpeg can read — including pro
// formats the browser can't (MXF, ProRes, DNxHD, …). Files ffmpeg can't
// decode (e.g. BRAW/R3D) just fall back to the extension glyph.
function isThumbnailable(name: string): boolean {
  return isVideoExt(name) || isAudioExt(name) || isImageExt(name);
}

const ARCHIVE_EXT = ["zip", "tar", "rar", "7z", "gz", "bz2"];
const PROJECT_EXT = ["prproj", "drp", "aep", "fcpx", "blend", "psd", "ai"];

function thumbColor(name: string): string {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  if (VIDEO_EXT.includes(ext)) return "bg-indigo-900/70";
  if (AUDIO_EXT.includes(ext)) return "bg-amber-900/60";
  if (IMAGE_EXT.includes(ext)) return "bg-violet-900/60";
  if (ARCHIVE_EXT.includes(ext)) return "bg-hover";
  if (PROJECT_EXT.includes(ext)) return "bg-blue-900/60";
  return "bg-hover";
}

function ExtensionGlyph({ name }: { name: string }) {
  const ext = (name.split(".").pop() ?? "").toLowerCase();
  return (
    <span className="font-mono text-sm uppercase tracking-wider text-fg-strong/80">
      {ext.length > 0 && ext.length < 6 ? ext : ""}
    </span>
  );
}

// --- Path / icons -------------------------------------------------------

function joinPath(base: string, rel: string): string {
  if (!base) return rel;
  const isWindows = /^[a-zA-Z]:[\\/]/.test(base) || base.includes("\\");
  const sep = isWindows ? "\\" : "/";
  const trimmed = base.replace(/[\\/]+$/, "");
  const normalizedRel = isWindows ? rel.replace(/\//g, "\\") : rel;
  return trimmed + sep + normalizedRel;
}

async function copyText(text: string) {
  try {
    await navigator.clipboard.writeText(text);
    return;
  } catch {
    // fall through to legacy textarea copy
  }
  const ta = document.createElement("textarea");
  ta.value = text;
  document.body.appendChild(ta);
  ta.select();
  document.execCommand("copy");
  document.body.removeChild(ta);
}

function SearchGlyph() {
  return (
    <svg
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-fg-faint"
      aria-hidden
    >
      <circle cx="9" cy="9" r="6" />
      <path d="m17 17-4.35-4.35" />
    </svg>
  );
}

function GridIcon() {
  return (
    <svg
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
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
      className="h-4 w-4"
      aria-hidden
    >
      <path d="M4 5h12M4 10h12M4 15h12" />
    </svg>
  );
}

// Daemon /rest/db/browse wire shape. Each level is an array of
// entries; directories carry a `children` array, files don't. We
// expect this shape from current daemon builds — an older format
// used a nested object keyed by name, which the prior client code
// was written against, but that format is no longer emitted.
interface BrowseEntry {
  name: string;
  modTime: string;
  size: number;
  type: "FILE_INFO_TYPE_FILE" | "FILE_INFO_TYPE_DIRECTORY";
  children?: BrowseEntry[];
}

// nodeAt walks the browse tree to the directory at `path` (POSIX,
// empty string for root) and returns its children array. Returns null
// if any segment is missing or points at a file rather than a dir.
function nodeAt(root: unknown, path: string): BrowseEntry[] | null {
  if (!Array.isArray(root)) return null;
  if (!path) return root as BrowseEntry[];
  let arr: BrowseEntry[] = root as BrowseEntry[];
  for (const seg of path.split("/")) {
    const next = arr.find((e) => e.name === seg);
    if (!next || next.type !== "FILE_INFO_TYPE_DIRECTORY" || !next.children) {
      return null;
    }
    arr = next.children;
  }
  return arr;
}

// Folders always sort alphabetically and float above files. Within
// files, the user-selected `sort` key picks the comparator. For the
// time-based keys we keep a "synced-first" outer rank because the
// user reaches for a name in the list to *work with* it, not to watch
// it transfer — putting synced files at the top keeps the actionable
// rows visible during an active sync.
function compareEntries(a: Entry, b: Entry, sort: SortKey): number {
  if (a.kind !== b.kind) return a.kind === "folder" ? -1 : 1;
  if (a.kind === "folder" && b.kind === "folder") {
    return a.name.localeCompare(b.name);
  }
  if (a.kind === "file" && b.kind === "file") {
    return compareFiles(a, b, sort);
  }
  return 0;
}

function compareFiles(a: FileEntry, b: FileEntry, sort: SortKey): number {
  // Time-based sorts respect the synced-first outer ranking; explicit
  // name and size sorts honor the user's choice across every file in
  // the list, regardless of state, because that's the question they
  // were actually asking ("show me the biggest", "give me a Z list").
  switch (sort) {
    case "recent":
    case "oldest": {
      const rs = displayRank(a.state) - displayRank(b.state);
      if (rs !== 0) return rs;
      const cmp = compareByModified(a, b);
      return sort === "recent" ? cmp : -cmp;
    }
    case "name-asc":
      return a.name.localeCompare(b.name);
    case "name-desc":
      return b.name.localeCompare(a.name);
    case "size-desc":
      return b.size - a.size || a.name.localeCompare(b.name);
    case "size-asc":
      return a.size - b.size || a.name.localeCompare(b.name);
  }
}

function compareByModified(a: FileEntry, b: FileEntry): number {
  const ta = Date.parse(a.modified);
  const tb = Date.parse(b.modified);
  const aValid = Number.isFinite(ta);
  const bValid = Number.isFinite(tb);
  if (aValid && bValid && ta !== tb) return tb - ta;
  return a.name.localeCompare(b.name);
}

// displayRank: how the user wants to see the list — already-synced
// (most actionable for editing) first, in-flight transfers next,
// queued waiting-room files last. Different from stateRank, which
// sorts the other direction for the search filter's "currently
// busy first" view.
function displayRank(s: FileState): number {
  if (s.kind === "synced") return 0;
  if (s.kind === "syncing") return 1;
  return 2;
}

// flattenFiles: only used for recursive search. Returns every file in
// the tree as a (path, name, size, modified) record — no folders.
function flattenFiles(
  node: BrowseEntry[],
  prefix: string,
): { path: string; name: string; size: number; modified: string }[] {
  if (!Array.isArray(node)) return [];
  const out: {
    path: string;
    name: string;
    size: number;
    modified: string;
  }[] = [];
  for (const item of node) {
    const path = prefix ? `${prefix}/${item.name}` : item.name;
    if (item.type === "FILE_INFO_TYPE_DIRECTORY") {
      if (item.children) out.push(...flattenFiles(item.children, path));
    } else {
      if (isJunkFile(item.name)) continue;
      out.push({
        path,
        name: item.name,
        size: item.size,
        modified: item.modTime,
      });
    }
  }
  return out;
}
