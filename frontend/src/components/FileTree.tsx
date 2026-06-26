import { useEffect, useMemo, useState } from "react";
import { useFolderBrowse } from "../api/hooks";
import { cn } from "../lib/utils";
import { isPreviewable, mediaKind, previewNeedsTranscode } from "../lib/videoFormats";
import { useUnread } from "../api/cloud/useUnread";
import { UnreadBadge } from "./UnreadBadge";
import type { VideoPreviewFile } from "./VideoPreviewModal";

type Unread = ReturnType<typeof useUnread>;

// FileTree: the left navigator pane in a project's Files tab. Renders
// the folder/file hierarchy from /rest/db/browse (global index, so the
// full project structure shows even before content finishes syncing)
// and drives the FileGrid on the right via onNavigate.
//
//   - Click a folder row  → navigate the grid into that folder (and
//                           expand it so its children reveal).
//   - Click the chevron   → expand/collapse without navigating.
//   - Click a video file  → open it in the review player (onPreview).
//   - Click any other file → navigate the grid to the file's parent so
//                           the file is visible in the grid.
//
// Children of collapsed folders aren't rendered, so the DOM stays
// bounded even on large libraries — only expanded subtrees mount.

// Mirror of FileGrid's daemon /rest/db/browse wire shape. Kept local to
// avoid coupling the two components; both decode the same payload.
interface BrowseEntry {
  name: string;
  modTime: string;
  size: number;
  type: "FILE_INFO_TYPE_FILE" | "FILE_INFO_TYPE_DIRECTORY";
  children?: BrowseEntry[];
}

// Hide OS metadata files that aren't project content — mirrors
// FileGrid.isJunkFile so the tree and grid agree on what's a "file".
function isJunkFile(name: string): boolean {
  return (
    name === ".DS_Store" ||
    name === "Thumbs.db" ||
    name === "desktop.ini" ||
    // The review-comments sidecar dir is app data, not project content.
    name === ".vidsync-review"
  );
}

// ancestorsOf returns every parent path of a "/"-joined POSIX path,
// excluding the path itself. "a/b/c" → ["a", "a/b"]. Used to auto-open
// the branch leading to the currently-selected folder.
function ancestorsOf(path: string): string[] {
  if (!path) return [];
  const segs = path.split("/");
  const out: string[] = [];
  for (let i = 1; i < segs.length; i++) {
    out.push(segs.slice(0, i).join("/"));
  }
  return out;
}

export function FileTree({
  folderID,
  currentPath,
  selectedPath,
  showRoot = true,
  onNavigate,
  onPreview,
}: {
  folderID: string;
  // Currently-shown directory (POSIX, "" = project root).
  currentPath: string;
  // POSIX path of the video currently open in the player, so its row can be
  // highlighted (and its branch revealed). null when no video is open.
  selectedPath?: string | null;
  // Show the top-level "Project" root row. Hidden inside the ProjectsNav,
  // where the project name above already serves as the root.
  showRoot?: boolean;
  onNavigate: (path: string) => void;
  // Open a playable video in the review player. When omitted, clicking a
  // file just navigates the grid to its parent (legacy behavior).
  onPreview?: (file: VideoPreviewFile) => void;
}) {
  // Same query key/options as FileGrid's browse, so this reuses the
  // cached payload rather than issuing a second fetch.
  const browse = useFolderBrowse(folderID);
  const root = Array.isArray(browse.data) ? (browse.data as BrowseEntry[]) : [];
  const unread = useUnread(folderID);

  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());

  // Auto-expand the branch leading to the active folder (and the open
  // video's parent), so a grid navigation or opening a clip from the grid
  // reveals where you are in the tree without manual drilling.
  useEffect(() => {
    const anc = ancestorsOf(currentPath);
    if (currentPath) anc.push(currentPath);
    // A selected video is a file; its ancestors are the folders to open.
    if (selectedPath) anc.push(...ancestorsOf(selectedPath));
    if (anc.length === 0) return;
    setExpanded((prev) => {
      let changed = false;
      const next = new Set(prev);
      for (const a of anc) {
        if (!next.has(a)) {
          next.add(a);
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [currentPath, selectedPath]);

  const toggle = (path: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });

  if (browse.isLoading && root.length === 0) {
    return <p className="px-3 py-2 text-xs text-fg-faint">Loading…</p>;
  }
  if (root.length === 0) {
    return <p className="px-3 py-2 text-xs text-fg-faint">No files yet.</p>;
  }

  return (
    <div className="py-1 text-sm">
      {/* Root row — jumps the grid back to the project root. Hidden inside
          the ProjectsNav, where the project name already serves as root. */}
      {showRoot && (
        <Row
          depth={0}
          label="Project"
          isDir
          hasChildren
          expanded
          active={currentPath === ""}
          onToggle={() => onNavigate("")}
          onActivate={() => onNavigate("")}
        />
      )}
      <TreeLevel
        nodes={root}
        prefix=""
        depth={showRoot ? 1 : 0}
        expanded={expanded}
        currentPath={currentPath}
        selectedPath={selectedPath}
        folderID={folderID}
        unread={unread}
        onToggle={toggle}
        onNavigate={onNavigate}
        onPreview={onPreview}
      />
    </div>
  );
}

// TreeLevel renders one array of sibling entries: directories first
// (alphabetical), then files (alphabetical) — matching the grid's
// folders-above-files ordering.
function TreeLevel({
  nodes,
  prefix,
  depth,
  expanded,
  currentPath,
  selectedPath,
  folderID,
  unread,
  onToggle,
  onNavigate,
  onPreview,
}: {
  nodes: BrowseEntry[];
  prefix: string;
  depth: number;
  expanded: ReadonlySet<string>;
  currentPath: string;
  selectedPath?: string | null;
  folderID: string;
  unread: Unread;
  onToggle: (path: string) => void;
  onNavigate: (path: string) => void;
  onPreview?: (file: VideoPreviewFile) => void;
}) {
  const { dirs, files } = useMemo(() => {
    const dirs: BrowseEntry[] = [];
    const files: BrowseEntry[] = [];
    for (const n of nodes) {
      if (isJunkFile(n.name)) continue;
      if (n.type === "FILE_INFO_TYPE_DIRECTORY") dirs.push(n);
      else files.push(n);
    }
    dirs.sort((a, b) => a.name.localeCompare(b.name));
    files.sort((a, b) => a.name.localeCompare(b.name));
    return { dirs, files };
  }, [nodes]);

  return (
    <>
      {dirs.map((node) => {
        const path = prefix ? `${prefix}/${node.name}` : node.name;
        const isOpen = expanded.has(path);
        const childDirs = node.children ?? [];
        const hasChildren = childDirs.length > 0;
        return (
          <div key={path}>
            <Row
              depth={depth}
              label={node.name}
              isDir
              hasChildren={hasChildren}
              expanded={isOpen}
              active={currentPath === path}
              unread={unread.isFolderUnread(path)}
              onToggle={() => onToggle(path)}
              onActivate={() => onNavigate(path)}
            />
            {isOpen && hasChildren && (
              <TreeLevel
                nodes={childDirs}
                prefix={path}
                depth={depth + 1}
                expanded={expanded}
                currentPath={currentPath}
                selectedPath={selectedPath}
                folderID={folderID}
                unread={unread}
                onToggle={onToggle}
                onNavigate={onNavigate}
                onPreview={onPreview}
              />
            )}
          </div>
        );
      })}
      {files.map((node) => {
        const path = prefix ? `${prefix}/${node.name}` : node.name;
        const previewable = !!onPreview && isPreviewable(node.name);
        return (
          <Row
            key={path}
            depth={depth}
            label={node.name}
            isDir={false}
            fileKind={mediaKind(node.name)}
            hasChildren={false}
            expanded={false}
            active={selectedPath === path}
            unread={unread.isVideoUnread(path)}
            // A previewable video/audio/image opens directly in the review
            // player; any other file just navigates the grid to its parent.
            onActivate={() =>
              previewable
                ? onPreview!({
                    folderID,
                    path,
                    name: node.name,
                    size: node.size,
                    modified: node.modTime,
                    kind: mediaKind(node.name) ?? "video",
                    transcode: previewNeedsTranscode(node.name),
                  })
                : onNavigate(prefix)
            }
          />
        );
      })}
    </>
  );
}

function Row({
  depth,
  label,
  isDir,
  fileKind,
  hasChildren,
  expanded,
  active,
  unread,
  onToggle,
  onActivate,
}: {
  depth: number;
  label: string;
  isDir: boolean;
  // Media kind for file rows — picks the glyph (video / audio / image).
  fileKind?: ReturnType<typeof mediaKind>;
  hasChildren: boolean;
  expanded: boolean;
  active: boolean;
  unread?: boolean;
  onToggle?: () => void;
  onActivate: () => void;
}) {
  // Indent by depth; reserve the chevron column even for leaves so
  // labels line up vertically.
  const padLeft = 8 + depth * 14;
  return (
    <div
      className={cn(
        "group flex items-center gap-1 rounded-md py-1 pr-2 transition-colors",
        active
          ? "bg-hover text-fg-strong"
          : "text-fg-soft hover:bg-hover/60 hover:text-fg-strong",
      )}
      style={{ paddingLeft: padLeft }}
    >
      {isDir && hasChildren ? (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onToggle?.();
          }}
          aria-label={expanded ? "Collapse" : "Expand"}
          className="flex h-4 w-4 shrink-0 items-center justify-center rounded text-fg-faint hover:text-fg-strong"
        >
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            className={cn("h-3 w-3 transition-transform", expanded && "rotate-90")}
            aria-hidden
          >
            <path d="m9 6 6 6-6 6" />
          </svg>
        </button>
      ) : (
        <span className="h-4 w-4 shrink-0" aria-hidden />
      )}
      <button
        type="button"
        onClick={onActivate}
        title={label}
        className="flex min-w-0 flex-1 items-center gap-1.5 py-px text-left"
      >
        {isDir ? (
          <FolderGlyph />
        ) : fileKind === "video" ? (
          <VideoGlyph />
        ) : fileKind === "audio" ? (
          <AudioGlyph />
        ) : fileKind === "image" ? (
          <ImageGlyph />
        ) : (
          <FileGlyph />
        )}
        <span className="truncate text-sm">{label}</span>
        {unread && <UnreadBadge className="ml-auto pl-1" />}
      </button>
    </div>
  );
}

function FolderGlyph() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="h-3.5 w-3.5 shrink-0 text-amber-300/80"
      aria-hidden
    >
      <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z" />
    </svg>
  );
}

function FileGlyph() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="h-3.5 w-3.5 shrink-0 text-fg-faint"
      aria-hidden
    >
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <path d="M14 2v6h6" />
    </svg>
  );
}

function VideoGlyph() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.9"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="h-3.5 w-3.5 shrink-0 text-accent"
      aria-hidden
    >
      <rect x="2.5" y="6" width="13" height="12" rx="2" />
      <path d="M15.5 10.5 21 7.5v9l-5.5-3z" />
    </svg>
  );
}

function AudioGlyph() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.9"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="h-3.5 w-3.5 shrink-0 text-emerald-300/90"
      aria-hidden
    >
      <path d="M9 18V6l11-2v12" />
      <circle cx="6" cy="18" r="3" />
      <circle cx="17" cy="16" r="3" />
    </svg>
  );
}

function ImageGlyph() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.9"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="h-3.5 w-3.5 shrink-0 text-violet-300/90"
      aria-hidden
    >
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <circle cx="8.5" cy="9.5" r="1.5" />
      <path d="m5 17 4.5-4.5L13 16l3-3 3 3" />
    </svg>
  );
}
