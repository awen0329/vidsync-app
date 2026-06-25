import { useState } from "react";
import { Modal } from "./Modal";
import { humanBytes, humanRelative } from "../lib/format";

// Lightweight metadata view for a single file in the FileGrid. Shows
// the daemon-known facts (path, size, modtime, status) plus a quick
// "Copy path" shortcut. Intentionally read-only — mutating actions are
// surfaced from the context menu itself.

export type FileDetailsStatus = "synced" | "syncing" | "pending";

export interface FileDetails {
  name: string;
  relativePath: string;
  absolutePath: string;
  size: number;
  modified: string;
  status: FileDetailsStatus;
}

export function FileDetailsModal({
  open,
  onClose,
  file,
}: {
  open: boolean;
  onClose: () => void;
  file: FileDetails | null;
}) {
  const [copied, setCopied] = useState(false);

  async function copy(text: string) {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const ta = document.createElement("textarea");
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      document.body.removeChild(ta);
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  if (!file) return null;

  return (
    <Modal open={open} onClose={onClose} title={file.name}>
      <dl className="space-y-3 text-sm text-fg">
        <Row label="Status">
          <StatusBadge status={file.status} />
        </Row>
        <Row label="Size">{humanBytes(file.size)}</Row>
        <Row label="Modified">
          {file.modified ? humanRelative(file.modified) : "—"}
        </Row>
        <Row label="Relative path">
          <code className="break-all rounded bg-panel px-1.5 py-0.5 text-xs">
            {file.relativePath}
          </code>
        </Row>
        <Row label="Full path">
          <div className="flex items-start gap-2">
            <code className="min-w-0 flex-1 break-all rounded bg-panel px-1.5 py-0.5 text-xs">
              {file.absolutePath}
            </code>
            <button
              type="button"
              onClick={() => copy(file.absolutePath)}
              className="shrink-0 rounded border border-line px-2 py-0.5 text-xs hover:bg-panel"
            >
              {copied ? "Copied" : "Copy"}
            </button>
          </div>
        </Row>
      </dl>
    </Modal>
  );
}

function Row({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="grid grid-cols-[7rem_1fr] items-start gap-3">
      <dt className="text-xs font-medium uppercase tracking-wide text-fg-soft">
        {label}
      </dt>
      <dd className="min-w-0">{children}</dd>
    </div>
  );
}

function StatusBadge({ status }: { status: FileDetailsStatus }) {
  const map = {
    synced: { label: "Synced", cls: "bg-indigo-100 text-indigo-800" },
    syncing: { label: "Syncing", cls: "bg-amber-100 text-amber-800" },
    pending: { label: "Not synced", cls: "bg-elevated text-fg" },
  } as const;
  const { label, cls } = map[status];
  return (
    <span
      className={`inline-flex items-center rounded px-2 py-0.5 text-xs font-medium ${cls}`}
    >
      {label}
    </span>
  );
}
