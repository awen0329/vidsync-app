import { useFolderErrors } from "../api/hooks";

// ErrorsBanner surfaces files the daemon failed to sync — permission
// denied, disk full, illegal characters on this OS, etc. These are
// otherwise silent and lead to "I thought I had this file" surprises.

export function ErrorsBanner({ folderID }: { folderID: string }) {
  const errors = useFolderErrors(folderID);
  const rows = errors.data?.errors ?? [];
  if (rows.length === 0) return null;
  return (
    <section className="space-y-2 rounded-md border border-rose-500/30 bg-rose-500/10 p-3">
      <header className="flex items-baseline justify-between">
        <h3 className="text-sm font-semibold text-rose-200">
          {rows.length} sync error{rows.length > 1 ? "s" : ""}
        </h3>
        <span className="text-xs text-rose-300">
          These files couldn't be synced. Hover for details.
        </span>
      </header>
      <ul className="max-h-40 divide-y divide-line overflow-auto rounded bg-panel/60">
        {rows.map((r) => (
          <li
            key={r.path}
            className="flex items-center gap-3 px-3 py-2 text-sm"
            title={r.error}
          >
            <div className="flex-1 truncate font-mono text-xs text-fg-strong">
              {r.path}
            </div>
            <div className="max-w-[40%] shrink-0 truncate text-xs text-rose-300">
              {r.error}
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
