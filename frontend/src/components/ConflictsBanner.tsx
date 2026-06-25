import { useMemo } from "react";
import { useFolderBrowse } from "../api/hooks";
import { humanBytes, humanRelative } from "../lib/format";
import { useTick } from "../lib/useTick";

// ConflictsBanner walks /rest/db/browse looking for files matching
// the daemon's `*.sync-conflict-<date>-<time>-<peer>.<ext>` pattern.
// Browsers can't move/rename files, so this surface is informational —
// it tells the editor a conflict exists and where to find it.

interface ConflictRow {
  path: string;
  size: number;
  modified: string; // ISO
}

const CONFLICT_RE = /\.sync-conflict-/;

export function ConflictsBanner({ folderID }: { folderID: string }) {
  const browse = useFolderBrowse(folderID);
  useTick(30_000);
  const conflicts = useMemo(
    () => (browse.data ? findConflicts(browse.data, "") : []),
    [browse.data],
  );
  if (conflicts.length === 0) return null;
  return (
    <section className="space-y-2 rounded-md border border-rose-500/30 bg-rose-500/10 p-3">
      <header className="flex items-baseline justify-between">
        <h3 className="text-sm font-semibold text-rose-200">
          {conflicts.length} sync conflict
          {conflicts.length > 1 ? "s" : ""}
        </h3>
        <span className="text-xs text-rose-300">
          Two devices saved the same file. Open each, keep the version you want, delete the other.
        </span>
      </header>
      <ul className="max-h-48 divide-y divide-line overflow-auto rounded bg-panel/60">
        {conflicts.map((c) => (
          <li key={c.path} className="flex items-center gap-3 px-3 py-2 text-sm">
            <div className="flex-1 truncate font-mono text-xs text-fg-strong" title={c.path}>
              {c.path}
            </div>
            <span className="shrink-0 text-xs text-fg-soft">
              {humanBytes(c.size)}
            </span>
            <span
              className="shrink-0 text-xs text-fg-soft"
              title={new Date(c.modified).toLocaleString()}
            >
              {humanRelative(c.modified)}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

// The /rest/db/browse response shape: a directory is an object whose
// keys are children; a file is a 2-tuple [modtime, size]. We recurse,
// joining segments with "/" because the daemon paths are POSIX-style.
function findConflicts(node: unknown, prefix: string): ConflictRow[] {
  if (!node || typeof node !== "object") return [];
  const out: ConflictRow[] = [];
  for (const [name, value] of Object.entries(node as Record<string, unknown>)) {
    const path = prefix ? `${prefix}/${name}` : name;
    if (Array.isArray(value)) {
      // file leaf — [modtime, size]
      if (CONFLICT_RE.test(name)) {
        const [mod, size] = value as [string, number];
        out.push({ path, modified: mod, size });
      }
    } else {
      out.push(...findConflicts(value, path));
    }
  }
  return out;
}
