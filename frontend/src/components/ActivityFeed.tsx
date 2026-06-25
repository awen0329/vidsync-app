import { useSyncEvents } from "../api/useSyncEvents";
import { humanRelative } from "../lib/format";
import { useTick } from "../lib/useTick";

// ActivityFeed surfaces ItemFinished events for a folder as a
// chronological log: who/what changed, with a relative timestamp.
// Folder owners see this so they know when remote peers pulled their
// changes; invited members see it as their own download history.

export function ActivityFeed({ folderID }: { folderID: string }) {
  const { completed } = useSyncEvents(folderID);
  useTick(30_000); // freshen "Xm ago" labels
  if (completed.length === 0) return null;
  return (
    // flex-col + min-h-0 + flex-1 so the panel itself fills the
    // remaining vertical space and only the inner list scrolls. The
    // parent (Activity tab in ProjectDetail) is also a flex column,
    // anchoring the ErrorsBanner above.
    <section className="flex min-h-0 flex-1 flex-col">
      <h3 className="mb-2 shrink-0 text-sm font-semibold uppercase tracking-wide text-fg-soft">
        Today's activity
      </h3>
      <ul className="min-h-0 flex-1 divide-y divide-line overflow-y-auto rounded-md border border-line/60 bg-elevated/50">
        {completed.map((it, idx) => (
          <li
            key={`${it.time}-${it.name}-${idx}`}
            className="flex items-center gap-3 px-3 py-2 text-sm text-fg-strong"
            title={it.error ? `Error: ${it.error}` : it.name}
          >
            {it.error ? <ErrorIcon /> : <TickIcon />}
            <div className="flex-1 truncate">{it.name}</div>
            <span className="shrink-0 text-xs text-fg-soft">{it.action}</span>
            <span
              className="shrink-0 text-xs text-fg-soft"
              title={new Date(it.time).toLocaleString()}
            >
              {humanRelative(it.time)}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

function TickIcon() {
  return (
    <svg
      className="h-4 w-4 shrink-0 text-indigo-600"
      viewBox="0 0 20 20"
      fill="currentColor"
      aria-hidden
    >
      <path
        fillRule="evenodd"
        d="M16.704 5.296a1 1 0 010 1.408l-7.999 8a1 1 0 01-1.412 0l-3.997-4a1 1 0 111.414-1.414L8 12.583l7.295-7.287a1 1 0 011.41 0z"
        clipRule="evenodd"
      />
    </svg>
  );
}

function ErrorIcon() {
  return (
    <svg
      className="h-4 w-4 shrink-0 text-rose-600"
      viewBox="0 0 20 20"
      fill="currentColor"
      aria-hidden
    >
      <path
        fillRule="evenodd"
        d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z"
        clipRule="evenodd"
      />
    </svg>
  );
}
