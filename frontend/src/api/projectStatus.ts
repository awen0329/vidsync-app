// Per-project lifecycle tag persisted in localStorage. Not visible to
// the daemon — purely a UI concept for video editors to organise a
// list of dozens of projects by where they are in production.

export type ProjectStatus =
  | "editing"
  | "coloring"
  | "mastering"
  | "delivered"
  | "archived";

export const PROJECT_STATUSES: { value: ProjectStatus; label: string }[] = [
  { value: "editing", label: "Editing" },
  { value: "coloring", label: "Coloring" },
  { value: "mastering", label: "Mastering" },
  { value: "delivered", label: "Delivered" },
  { value: "archived", label: "Archived" },
];

const STORAGE_KEY = "vidsync.projectStatus.v1";

function read(): Record<string, ProjectStatus> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return typeof parsed === "object" && parsed
      ? (parsed as Record<string, ProjectStatus>)
      : {};
  } catch {
    return {};
  }
}

function write(map: Record<string, ProjectStatus>) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(map));
  } catch {
    // ignore quota errors
  }
}

export const projectStatus = {
  get(folderID: string): ProjectStatus {
    return read()[folderID] ?? "editing";
  },
  set(folderID: string, status: ProjectStatus) {
    const map = read();
    map[folderID] = status;
    write(map);
  },
  delete(folderID: string) {
    const map = read();
    delete map[folderID];
    write(map);
  },
};

export function statusBadgeClass(s: ProjectStatus): string {
  switch (s) {
    case "editing":
      return "bg-blue-500/15 text-blue-300 ring-1 ring-blue-500/30";
    case "coloring":
      return "bg-violet-500/15 text-violet-300 ring-1 ring-violet-500/30";
    case "mastering":
      return "bg-amber-500/15 text-amber-300 ring-1 ring-amber-500/30";
    case "delivered":
      return "bg-indigo-500/15 text-indigo-300 ring-1 ring-indigo-500/30";
    case "archived":
      return "bg-slate-500/15 text-fg-soft ring-1 ring-line-strong/30";
  }
}
