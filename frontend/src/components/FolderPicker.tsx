import { useEffect, useState } from "react";
import { Modal } from "./Modal";
import { client } from "../api/client";

// FolderPicker browses the daemon's local filesystem via /rest/system/browse.
// Returns the picked absolute path through onPick. Path values keep the
// trailing separator while navigating; the chosen value is trimmed once.
export function FolderPicker({
  open,
  onClose,
  onPick,
  initialPath,
}: {
  open: boolean;
  onClose: () => void;
  onPick: (path: string) => void;
  initialPath?: string;
}) {
  const [current, setCurrent] = useState(initialPath ?? "");
  const [entries, setEntries] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (open) setCurrent(initialPath ?? "");
  }, [open, initialPath]);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    setErr(null);
    client
      .browse(withTrailingSep(current))
      .then((es) => {
        if (!cancelled) setEntries(es ?? []);
      })
      .catch((e) => {
        if (!cancelled) setErr(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [current, open]);

  const inputClass =
    "w-full rounded border border-line px-2 py-1.5 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500";

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Pick folder"
      primaryLabel="Use this folder"
      primaryDisabled={!current}
      onPrimary={() => {
        onPick(stripTrailingSep(current));
        onClose();
      }}
    >
      <label className="mb-3 block">
        <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-fg-soft">
          Path
        </span>
        <input
          value={current}
          onChange={(e) => setCurrent(e.target.value)}
          placeholder="(root)"
          className={inputClass}
        />
      </label>
      {err && <p className="mb-2 text-sm text-rose-700">{err}</p>}
      <ul className="max-h-72 divide-y divide-line overflow-y-auto rounded-md border border-line">
        {current && (
          <li>
            <button
              type="button"
              onClick={() => setCurrent(parentOf(current))}
              className="w-full px-3 py-2 text-left text-sm text-fg-soft hover:bg-panel"
            >
              ..
            </button>
          </li>
        )}
        {entries.map((e) => (
          <li key={e}>
            <button
              type="button"
              onClick={() => setCurrent(e)}
              className="w-full px-3 py-2 text-left text-sm hover:bg-panel"
            >
              {basenameOf(e)}
            </button>
          </li>
        ))}
        {!loading && entries.length === 0 && (
          <li className="px-3 py-2 text-sm text-fg-soft">
            {current ? "No subfolders here." : "Listing roots…"}
          </li>
        )}
      </ul>
    </Modal>
  );
}

function stripTrailingSep(p: string): string {
  return p.replace(/[\\/]+$/, "");
}

// The daemon's /rest/system/browse interprets a path with no trailing
// separator as "prefix-match the last segment", and one *with* a
// separator as "list contents of this dir". We always want the latter
// when navigating, but filepath.Join on the Go side strips the trailing
// separator from each returned entry — so add it back here.
function withTrailingSep(p: string): string {
  if (!p) return p;
  if (p.endsWith("/") || p.endsWith("\\")) return p;
  const sep = p.includes("\\") ? "\\" : "/";
  return p + sep;
}

function parentOf(p: string): string {
  const stripped = stripTrailingSep(p);
  const idx = Math.max(stripped.lastIndexOf("/"), stripped.lastIndexOf("\\"));
  if (idx < 0) return "";
  return stripped.slice(0, idx + 1);
}

function basenameOf(p: string): string {
  const stripped = stripTrailingSep(p);
  const idx = Math.max(stripped.lastIndexOf("/"), stripped.lastIndexOf("\\"));
  return idx < 0 ? stripped : stripped.slice(idx + 1) || stripped;
}
