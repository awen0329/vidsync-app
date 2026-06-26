import { useEffect, useMemo, useState } from "react";
import { origins } from "../api/origins";
import { useFolderState } from "../realtime/hooks";
import { humanStateLabel } from "../lib/projectState";
import { FileTree } from "./FileTree";
import { cn } from "../lib/utils";
import type { FolderConfiguration } from "../api/types";
import type { VideoPreviewFile } from "./VideoPreviewModal";

// ProjectsNav: the persistent project navigator — col 2 of the
// Frame.io-style shell. "All projects" up top, then Owned / Invited
// groups. Each project expands in place to reveal its file tree (reusing
// the same <FileTree> the project detail view uses), so users can jump
// straight to a folder or open a clip without first opening the project.
//
// Clicking a project row opens it (and expands it). The chevron toggles
// expansion without navigating. Navigating the tree deep-links into the
// project at that path (onOpenProject with { path } / { preview }).

export interface OpenProjectOptions {
  path?: string;
  preview?: VideoPreviewFile;
}

export function ProjectsNav({
  folders,
  activeFolderID,
  allProjectsActive,
  onOpenAllProjects,
  onOpenProject,
  onCreate,
}: {
  folders: FolderConfiguration[];
  activeFolderID: string | null;
  allProjectsActive: boolean;
  onOpenAllProjects: () => void;
  onOpenProject: (folderID: string, opts?: OpenProjectOptions) => void;
  onCreate: () => void;
}) {
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());

  // Keep the active project's branch open so the tree always reflects
  // where the user is, even after navigating from elsewhere.
  useEffect(() => {
    if (!activeFolderID) return;
    setExpanded((prev) =>
      prev.has(activeFolderID) ? prev : new Set(prev).add(activeFolderID),
    );
  }, [activeFolderID]);

  const toggle = (id: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const { owned, invited } = useMemo(() => {
    const owned: FolderConfiguration[] = [];
    const invited: FolderConfiguration[] = [];
    for (const f of folders) {
      (origins.get(f.id) === "invited" ? invited : owned).push(f);
    }
    const byLabel = (a: FolderConfiguration, b: FolderConfiguration) =>
      (a.label || a.id).localeCompare(b.label || b.id);
    owned.sort(byLabel);
    invited.sort(byLabel);
    return { owned, invited };
  }, [folders]);

  return (
    <aside className="flex h-full w-[252px] shrink-0 flex-col overflow-hidden rounded-xl border border-line bg-panel">
      <div className="flex items-center justify-between px-4 pb-2 pt-4">
        <span className="text-sm font-semibold text-fg-strong">Projects</span>
        <button
          type="button"
          onClick={onCreate}
          title="New project"
          aria-label="New project"
          className="flex h-6 w-6 items-center justify-center rounded-md text-fg-soft transition-colors hover:bg-hover hover:text-fg-strong"
        >
          <svg viewBox="0 0 20 20" fill="none" className="h-4 w-4" aria-hidden>
            <path d="M10 4v12M4 10h12" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
          </svg>
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-2.5 pb-3">
        <button
          type="button"
          onClick={onOpenAllProjects}
          className={cn(
            "flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-sm font-medium transition-colors",
            allProjectsActive
              ? "bg-hover text-fg-strong"
              : "text-fg-default hover:bg-hover hover:text-fg-strong",
          )}
        >
          <svg viewBox="0 0 24 24" fill="none" className="h-4 w-4" aria-hidden>
            <path d="M4 6h16M4 6a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2" stroke="currentColor" strokeWidth="1.7" />
          </svg>
          All projects
          <span className="ml-auto text-[11px] text-fg-faint">{folders.length}</span>
        </button>

        <NavGroup label="Owned">
          {owned.map((f) => (
            <ProjectRow
              key={f.id}
              folder={f}
              active={activeFolderID === f.id}
              expanded={expanded.has(f.id)}
              onOpen={() => onOpenProject(f.id)}
              onToggle={() => toggle(f.id)}
              onNavigate={(path) => onOpenProject(f.id, { path })}
              onPreview={(preview) => onOpenProject(f.id, { preview })}
            />
          ))}
          {owned.length === 0 && <EmptyHint text="No projects yet." />}
        </NavGroup>

        {invited.length > 0 && (
          <NavGroup label="Invited">
            {invited.map((f) => (
              <ProjectRow
                key={f.id}
                folder={f}
                active={activeFolderID === f.id}
                expanded={expanded.has(f.id)}
                onOpen={() => onOpenProject(f.id)}
                onToggle={() => toggle(f.id)}
                onNavigate={(path) => onOpenProject(f.id, { path })}
                onPreview={(preview) => onOpenProject(f.id, { preview })}
              />
            ))}
          </NavGroup>
        )}
      </div>

      <div className="border-t border-line px-4 py-3 text-[11px] text-fg-faint">
        {folders.length} project{folders.length === 1 ? "" : "s"}
      </div>
    </aside>
  );
}

function NavGroup({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <>
      <div className="px-2 pb-1 pt-4 text-[10px] font-semibold uppercase tracking-[0.13em] text-fg-faint">
        {label}
      </div>
      <div className="space-y-0.5">{children}</div>
    </>
  );
}

function EmptyHint({ text }: { text: string }) {
  return <p className="px-2.5 py-1 text-[12px] text-fg-faint">{text}</p>;
}

function ProjectRow({
  folder,
  active,
  expanded,
  onOpen,
  onToggle,
  onNavigate,
  onPreview,
}: {
  folder: FolderConfiguration;
  active: boolean;
  expanded: boolean;
  onOpen: () => void;
  onToggle: () => void;
  onNavigate: (path: string) => void;
  onPreview: (file: VideoPreviewFile) => void;
}) {
  const fs = useFolderState(folder.id);
  const view = humanStateLabel(fs?.state, folder.paused);
  const dot =
    view.state === "syncing"
      ? "bg-accent animate-pulse"
      : view.state === "error"
        ? "bg-rose-400"
        : view.state === "paused"
          ? "bg-amber-300"
          : view.state === "offline"
            ? "bg-slate-400"
            : "bg-emerald-400";

  return (
    <div>
      <div
        className={cn(
          "flex items-center gap-1.5 rounded-lg pr-2 transition-colors",
          active
            ? "bg-hover text-fg-strong"
            : "text-fg-default hover:bg-hover/60 hover:text-fg-strong",
        )}
      >
        <button
          type="button"
          onClick={onToggle}
          aria-label={expanded ? "Collapse" : "Expand"}
          className="flex h-7 w-5 shrink-0 items-center justify-center rounded text-fg-faint hover:text-fg-strong"
        >
          {/* Same chevron as the file tree rows. */}
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
        <button
          type="button"
          onClick={onOpen}
          title={folder.label || folder.id}
          className="flex min-w-0 flex-1 items-center gap-2 py-1.5 text-left text-sm"
        >
          <span
            className="h-5 w-5 shrink-0 rounded ring-1 ring-line-strong"
            style={{ backgroundImage: projectGradient(folder.id) }}
            aria-hidden
          />
          <span className="flex-1 truncate">{folder.label || folder.id}</span>
          <span className={cn("h-1.5 w-1.5 shrink-0 rounded-full", dot)} title={view.label} aria-hidden />
        </button>
      </div>
      {expanded && (
        <div className="ml-3 border-l border-line pl-1">
          <FileTree
            folderID={folder.id}
            currentPath=""
            selectedPath={null}
            showRoot={false}
            onNavigate={onNavigate}
            onPreview={onPreview}
          />
        </div>
      )}
    </div>
  );
}

// projectGradient: deterministic cinematic swatch for a project's cover,
// replacing the 4-thumbnail collage. Matches the folder-tile gradients.
const PROJECT_GRADIENTS = [
  "linear-gradient(135deg,#1a2740,#06101f)",
  "radial-gradient(120% 120% at 30% 10%,#3a2a1c,#0b0805)",
  "linear-gradient(160deg,#2a1530,#08040f)",
  "radial-gradient(120% 100% at 70% 20%,#103030,#051014)",
  "linear-gradient(135deg,#2b2030,#0a0814)",
  "linear-gradient(135deg,#152a3a,#06101a)",
];

function projectGradient(id: string): string {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return PROJECT_GRADIENTS[h % PROJECT_GRADIENTS.length];
}
