// Track which folders the user owns versus folders they accepted from
// an invitation. Persisted in localStorage so the distinction survives
// refresh; not synced anywhere — purely a UI concept.

export type Origin = "owned" | "invited";

const STORAGE_KEY = "syncthing.origins.v1";

function read(): Record<string, Origin> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return typeof parsed === "object" && parsed ? (parsed as Record<string, Origin>) : {};
  } catch {
    return {};
  }
}

function write(map: Record<string, Origin>) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(map));
  } catch {
    // Ignore quota / privacy-mode failures: degrades to "all owned",
    // which is the safe default.
  }
}

export const origins = {
  // Get returns the recorded origin for folderID, defaulting to "owned"
  // for unknown folders. Owned-by-default keeps folders created via the
  // legacy web UI (or imported from a previous setup) visible in
  // "Your Projects" rather than vanishing.
  get(folderID: string): Origin {
    return read()[folderID] ?? "owned";
  },

  set(folderID: string, origin: Origin) {
    const map = read();
    map[folderID] = origin;
    write(map);
  },

  delete(folderID: string) {
    const map = read();
    delete map[folderID];
    write(map);
  },
};
