import { useMemo, useState } from "react";
import { useConfig } from "../api/hooks";
import { useActivity } from "../realtime/hooks";
import { origins, type Origin } from "../api/origins";
import { humanRelative } from "../lib/format";
import { useTick } from "../lib/useTick";
import type { ActivityItem } from "../realtime/types";

// Activity: global, chronological view of every ItemFinished the
// realtime store has seen across all folders. The realtime store keeps
// the most recent ~100 items in memory; older history is intentionally
// pruned (a long log would need persistence + paging — out of scope
// for the in-memory store).

export function Activity({
  onOpen,
}: {
  onOpen: (folderID: string, origin: Origin) => void;
}) {
  const cfg = useConfig();
  const all = useActivity(null);
  useTick(30_000);

  const [search, setSearch] = useState("");
  const [scope, setScope] = useState<"all" | "errors">("all");

  const folderLabel = useMemo(() => {
    const m: Record<string, string> = {};
    for (const f of cfg.data?.folders ?? []) m[f.id] = f.label || f.id;
    return m;
  }, [cfg.data?.folders]);

  const filtered = useMemo(() => {
    let out = all;
    if (scope === "errors") out = out.filter((a) => !!a.error);
    const q = search.trim().toLowerCase();
    if (q) {
      out = out.filter(
        (a) =>
          a.name.toLowerCase().includes(q) ||
          (folderLabel[a.folderID] ?? a.folderID).toLowerCase().includes(q),
      );
    }
    return out;
  }, [all, scope, search, folderLabel]);

  const groups = useMemo(() => groupByDay(filtered), [filtered]);

  return (
    <div className="h-full overflow-y-auto px-6 py-6">
      <header className="mb-5">
        <h1 className="text-2xl font-semibold text-fg-strong">Activity</h1>
        <p className="text-sm text-fg-soft">
          Recent transfers across every project on this device.
        </p>
      </header>

      <div className="mb-5 flex flex-wrap items-center gap-3">
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search files or projects…"
          className="min-w-[220px] flex-1 rounded-md border border-line bg-panel px-3 py-1.5 text-sm text-fg-strong placeholder:text-fg-soft focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500"
        />
        <div className="inline-flex rounded-md bg-panel p-0.5 ring-1 ring-line-strong">
          <ScopeButton
            active={scope === "all"}
            onClick={() => setScope("all")}
          >
            All
          </ScopeButton>
          <ScopeButton
            active={scope === "errors"}
            onClick={() => setScope("errors")}
          >
            Errors only
          </ScopeButton>
        </div>
        <span className="text-xs text-fg-soft">
          {filtered.length} event{filtered.length === 1 ? "" : "s"}
        </span>
      </div>

      {filtered.length === 0 ? (
        <p className="rounded-lg border border-dashed border-line px-6 py-12 text-center text-sm text-fg-soft">
          {all.length === 0
            ? "No activity yet — events will appear here as files transfer."
            : "No events match your filter."}
        </p>
      ) : (
        <div className="space-y-6">
          {groups.map((g) => (
            <section key={g.label}>
              <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-fg-soft">
                {g.label}
              </h2>
              <ul className="divide-y divide-line rounded-md border border-line/60 bg-elevated/40">
                {g.items.map((a, idx) => (
                  <li
                    key={`${a.time}-${a.folderID}-${a.name}-${idx}`}
                    className="flex items-center gap-3 px-4 py-2 text-sm text-fg-strong"
                  >
                    {a.error ? <ErrorIcon /> : <TickIcon />}
                    <div className="min-w-0 flex-1">
                      <div
                        className="truncate font-medium text-fg-strong"
                        title={a.error ?? a.name}
                      >
                        {a.name}
                      </div>
                      <div className="truncate text-xs text-fg-soft">
                        <button
                          type="button"
                          onClick={() =>
                            onOpen(a.folderID, origins.get(a.folderID))
                          }
                          className="rounded text-indigo-400 hover:underline"
                        >
                          {folderLabel[a.folderID] ?? a.folderID}
                        </button>
                        <span className="mx-1.5 text-fg">·</span>
                        <span>{a.action}</span>
                        {a.error && (
                          <span className="ml-1.5 text-rose-400">{a.error}</span>
                        )}
                      </div>
                    </div>
                    <span
                      className="shrink-0 text-xs text-fg-soft"
                      title={new Date(a.time).toLocaleString()}
                    >
                      {humanRelative(a.time)}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      )}
    </div>
  );
}

function ScopeButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={
        "rounded px-3 py-1 text-xs font-medium transition-colors " +
        (active
          ? "bg-indigo-500/15 text-indigo-300"
          : "text-fg-soft hover:text-fg-strong")
      }
    >
      {children}
    </button>
  );
}

interface DayGroup {
  label: string;
  items: ActivityItem[];
}

// Bucket activity items into Today / Yesterday / "Mon, Jan 5" /
// "Jan 5, 2025" (older). Preserves the input ordering within a group
// (the store already keeps newest-first).
function groupByDay(items: ActivityItem[]): DayGroup[] {
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const yesterday = new Date(today.getTime() - 86_400_000);
  const buckets = new Map<string, ActivityItem[]>();
  const order: string[] = [];
  for (const it of items) {
    const d = new Date(it.time);
    let label: string;
    if (!isFinite(d.getTime())) label = "Unknown date";
    else if (d >= today) label = "Today";
    else if (d >= yesterday) label = "Yesterday";
    else if (d.getFullYear() === now.getFullYear())
      label = d.toLocaleDateString(undefined, {
        weekday: "short",
        month: "short",
        day: "numeric",
      });
    else
      label = d.toLocaleDateString(undefined, {
        month: "short",
        day: "numeric",
        year: "numeric",
      });

    if (!buckets.has(label)) {
      buckets.set(label, []);
      order.push(label);
    }
    buckets.get(label)!.push(it);
  }
  return order.map((label) => ({ label, items: buckets.get(label)! }));
}

function TickIcon() {
  return (
    <svg
      className="h-4 w-4 shrink-0 text-indigo-400"
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
      className="h-4 w-4 shrink-0 text-rose-400"
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
