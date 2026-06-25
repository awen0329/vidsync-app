import { useCallback, useEffect, useMemo, useState } from "react";
import { Button } from "./Button";
import { useFolderBrowse } from "../api/hooks";
import {
  dropboxConnect,
  dropboxDisconnect,
  dropboxExport,
  dropboxImport,
  dropboxList,
  dropboxStatus,
  onDropboxProgress,
  type DropboxAccount,
  type DropboxEntry,
  type DropboxProgress,
} from "../lib/dropbox";

// DropboxModal: connect a Dropbox account, then import files from Dropbox into
// this project's folder, or export project files up to Dropbox. The desktop
// app does the work (cmd/vidsync/cloud_dropbox.go); this is the UI + progress.

interface BrowseNode {
  name: string;
  size: number;
  type: "FILE_INFO_TYPE_FILE" | "FILE_INFO_TYPE_DIRECTORY";
  children?: BrowseNode[];
}

// flattenFiles walks the daemon browse tree into a flat list of files with
// POSIX-relative paths (what DropboxExport expects).
function flattenFiles(nodes: BrowseNode[], prefix = ""): { path: string; size: number }[] {
  const out: { path: string; size: number }[] = [];
  for (const n of nodes) {
    const rel = prefix ? `${prefix}/${n.name}` : n.name;
    if (n.type === "FILE_INFO_TYPE_DIRECTORY") {
      if (n.children) out.push(...flattenFiles(n.children, rel));
    } else {
      out.push({ path: rel, size: n.size });
    }
  }
  return out;
}

function humanBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const u = ["KB", "MB", "GB", "TB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < u.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(1)} ${u[i]}`;
}

export function DropboxModal({
  open,
  onClose,
  folderID,
  folderPath,
  folderName,
}: {
  open: boolean;
  onClose: () => void;
  folderID: string;
  folderPath: string;
  folderName: string;
}) {
  const [account, setAccount] = useState<DropboxAccount | null>(null);
  const [tab, setTab] = useState<"import" | "export">("import");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState<DropboxProgress | null>(null);

  // Load status when opened.
  useEffect(() => {
    if (!open) return;
    setError(null);
    setProgress(null);
    dropboxStatus().then(setAccount).catch(() => setAccount({ connected: false, configured: false }));
  }, [open]);

  // Live progress.
  useEffect(() => {
    if (!open) return;
    return onDropboxProgress((p) => {
      setProgress(p);
      if (p.phase === "import-done" || p.phase === "export-done") {
        setBusy(false);
      }
    });
  }, [open]);

  // Close on Escape.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !busy) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, busy, onClose]);

  const connect = async () => {
    setError(null);
    setBusy(true);
    try {
      setAccount(await dropboxConnect());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const disconnect = async () => {
    await dropboxDisconnect();
    setAccount(await dropboxStatus());
  };

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-base/95 px-6 py-6"
      onClick={() => !busy && onClose()}
    >
      <div
        className="flex max-h-[82vh] w-full max-w-3xl flex-col overflow-hidden rounded-lg border border-line-strong bg-panel shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-center justify-between gap-3 border-b border-line-strong px-4 py-2.5">
          <div className="min-w-0">
            <div className="text-sm font-medium text-fg-strong">Dropbox</div>
            <div className="truncate text-[11px] text-fg-soft">
              {account?.connected
                ? `Connected${account.email ? ` · ${account.email}` : ""}`
                : "Not connected"}
            </div>
          </div>
          <div className="flex items-center gap-2">
            {account?.connected && (
              <button
                type="button"
                onClick={disconnect}
                className="rounded px-2 py-1 text-xs text-fg-soft hover:bg-elevated hover:text-fg-strong"
              >
                Disconnect
              </button>
            )}
            <button
              type="button"
              onClick={() => !busy && onClose()}
              aria-label="Close"
              className="rounded p-1 text-fg-soft hover:bg-elevated hover:text-fg-strong"
            >
              ✕
            </button>
          </div>
        </header>

        {error && (
          <div className="border-b border-line-strong bg-rose-500/10 px-4 py-2 text-xs text-rose-300">
            {error}
          </div>
        )}

        {!account ? (
          <div className="px-4 py-10 text-center text-sm text-fg-soft">Loading…</div>
        ) : !account.configured ? (
          <div className="px-4 py-10 text-center text-sm text-fg-soft">
            Dropbox isn't set up in this build.
          </div>
        ) : !account.connected ? (
          <div className="flex flex-col items-center gap-3 px-4 py-10 text-center">
            <p className="max-w-sm text-sm text-fg-soft">
              Connect your Dropbox to import footage into this project or export
              project files back to Dropbox.
            </p>
            <Button onClick={connect} disabled={busy}>
              {busy ? "Waiting for browser…" : "Connect Dropbox"}
            </Button>
          </div>
        ) : (
          <>
            <div className="flex shrink-0 gap-1 border-b border-line-strong px-3 pt-2">
              {(["import", "export"] as const).map((t) => (
                <button
                  key={t}
                  type="button"
                  onClick={() => setTab(t)}
                  className={
                    "rounded-t px-3 py-1.5 text-xs font-medium " +
                    (tab === t
                      ? "border-b-2 border-accent text-fg-strong"
                      : "text-fg-soft hover:text-fg-strong")
                  }
                >
                  {t === "import" ? "Import from Dropbox" : "Export to Dropbox"}
                </button>
              ))}
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto">
              {tab === "import" ? (
                <ImportPane
                  folderPath={folderPath}
                  busy={busy}
                  setBusy={setBusy}
                  setError={setError}
                />
              ) : (
                <ExportPane
                  folderID={folderID}
                  folderPath={folderPath}
                  folderName={folderName}
                  busy={busy}
                  setBusy={setBusy}
                  setError={setError}
                />
              )}
            </div>

            {progress && progress.phase !== "import-done" && progress.phase !== "export-done" && (
              <ProgressBar p={progress} />
            )}
          </>
        )}
      </div>
    </div>
  );
}

function ProgressBar({ p }: { p: DropboxProgress }) {
  const pct =
    p.bytesTotal > 0
      ? Math.round((p.bytesDone / p.bytesTotal) * 100)
      : p.total > 0
        ? Math.round((p.current / p.total) * 100)
        : 0;
  return (
    <div className="shrink-0 border-t border-line-strong px-4 py-2">
      <div className="mb-1 flex justify-between text-[11px] text-fg-soft">
        <span className="truncate">
          {p.phase === "error" ? "Failed" : p.name || "Working…"}
        </span>
        <span>
          {p.current + 1}/{p.total}
        </span>
      </div>
      <div className="h-1.5 overflow-hidden rounded bg-elevated">
        <div className="h-full bg-accent transition-[width]" style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

// --- Import: browse Dropbox, pick files, download into the project folder ---

function ImportPane({
  folderPath,
  busy,
  setBusy,
  setError,
}: {
  folderPath: string;
  busy: boolean;
  setBusy: (b: boolean) => void;
  setError: (e: string | null) => void;
}) {
  const [path, setPath] = useState(""); // Dropbox dir, "" = root
  const [entries, setEntries] = useState<DropboxEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const load = useCallback(
    (p: string) => {
      setLoading(true);
      setError(null);
      dropboxList(p)
        .then((e) => {
          // Folders first, then files; alphabetical.
          e.sort((a, b) =>
            a.isDir === b.isDir ? a.name.localeCompare(b.name) : a.isDir ? -1 : 1,
          );
          setEntries(e);
        })
        .catch((err) => setError(err instanceof Error ? err.message : String(err)))
        .finally(() => setLoading(false));
    },
    [setError],
  );

  useEffect(() => {
    load(path);
  }, [path, load]);

  const crumbs = path ? path.split("/").filter(Boolean) : [];
  const toggle = (p: string) =>
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(p)) n.delete(p);
      else n.add(p);
      return n;
    });

  const runImport = async () => {
    if (selected.size === 0) return;
    setBusy(true);
    setError(null);
    try {
      await dropboxImport(folderPath, [...selected]);
      setSelected(new Set());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex h-full flex-col">
      <div className="flex flex-wrap items-center gap-1 border-b border-line px-3 py-2 text-xs text-fg-soft">
        <button className="hover:text-fg-strong" onClick={() => setPath("")}>
          Dropbox
        </button>
        {crumbs.map((c, i) => (
          <span key={i} className="flex items-center gap-1">
            <span className="text-fg-faint">/</span>
            <button
              className="hover:text-fg-strong"
              onClick={() => setPath("/" + crumbs.slice(0, i + 1).join("/"))}
            >
              {c}
            </button>
          </span>
        ))}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-2 py-1">
        {loading ? (
          <div className="px-2 py-8 text-center text-sm text-fg-soft">Loading…</div>
        ) : entries.length === 0 ? (
          <div className="px-2 py-8 text-center text-sm text-fg-soft">Empty folder.</div>
        ) : (
          entries.map((e) =>
            e.isDir ? (
              <button
                key={e.path}
                onClick={() => setPath(e.path)}
                className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm text-fg-strong hover:bg-hover"
              >
                <span className="text-fg-faint">📁</span>
                <span className="truncate">{e.name}</span>
              </button>
            ) : (
              <label
                key={e.path}
                className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-sm hover:bg-hover"
              >
                <input
                  type="checkbox"
                  checked={selected.has(e.path)}
                  onChange={() => toggle(e.path)}
                />
                <span className="flex-1 truncate text-fg-strong">{e.name}</span>
                <span className="text-[11px] text-fg-faint">{humanBytes(e.size)}</span>
              </label>
            ),
          )
        )}
      </div>

      <div className="flex shrink-0 items-center justify-between border-t border-line px-3 py-2">
        <span className="text-xs text-fg-soft">{selected.size} selected</span>
        <Button onClick={runImport} disabled={busy || selected.size === 0}>
          {busy ? "Importing…" : `Import ${selected.size || ""} → ${"this project"}`}
        </Button>
      </div>
    </div>
  );
}

// --- Export: pick project files, upload to a Dropbox folder ---

function ExportPane({
  folderID,
  folderPath,
  folderName,
  busy,
  setBusy,
  setError,
}: {
  folderID: string;
  folderPath: string;
  folderName: string;
  busy: boolean;
  setBusy: (b: boolean) => void;
  setError: (e: string | null) => void;
}) {
  const browse = useFolderBrowse(folderID, { local: true });
  const files = useMemo(() => {
    const root = browse.data;
    if (!Array.isArray(root)) return [];
    return flattenFiles(root as BrowseNode[]).sort((a, b) =>
      a.path.localeCompare(b.path),
    );
  }, [browse.data]);

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [dest, setDest] = useState(`/Vidsync/${folderName}`);

  const toggle = (p: string) =>
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(p)) n.delete(p);
      else n.add(p);
      return n;
    });

  const runExport = async () => {
    if (selected.size === 0) return;
    setBusy(true);
    setError(null);
    try {
      await dropboxExport(folderPath, [...selected], dest);
      setSelected(new Set());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex h-full flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b border-line px-3 py-2">
        <label className="text-xs text-fg-soft">Dropbox folder</label>
        <input
          value={dest}
          onChange={(e) => setDest(e.target.value)}
          className="flex-1 rounded border border-line bg-elevated px-2 py-1 text-xs text-fg-strong"
          placeholder="/Vidsync/Project"
        />
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-2 py-1">
        {browse.isLoading ? (
          <div className="px-2 py-8 text-center text-sm text-fg-soft">Loading…</div>
        ) : files.length === 0 ? (
          <div className="px-2 py-8 text-center text-sm text-fg-soft">No files in this project.</div>
        ) : (
          files.map((f) => (
            <label
              key={f.path}
              className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-sm hover:bg-hover"
            >
              <input
                type="checkbox"
                checked={selected.has(f.path)}
                onChange={() => toggle(f.path)}
              />
              <span className="flex-1 truncate text-fg-strong">{f.path}</span>
              <span className="text-[11px] text-fg-faint">{humanBytes(f.size)}</span>
            </label>
          ))
        )}
      </div>

      <div className="flex shrink-0 items-center justify-between border-t border-line px-3 py-2">
        <span className="text-xs text-fg-soft">{selected.size} selected</span>
        <Button onClick={runExport} disabled={busy || selected.size === 0 || !dest.trim()}>
          {busy ? "Exporting…" : `Export ${selected.size || ""} → Dropbox`}
        </Button>
      </div>
    </div>
  );
}
