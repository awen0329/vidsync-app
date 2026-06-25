import { useState } from "react";
import { useFolderStatus, useRevertFolder } from "../api/hooks";
import { useFolderState } from "../realtime/hooks";

// LocalChangesBanner appears on receive-only (invited) folders when
// the user has modified files locally. Receive-only folders treat the
// owner's copy as canonical, so local edits sit in limbo until the
// recipient picks one of:
//   - Override (only available to the owner — push local as truth), or
//   - Revert (this banner) — discard local changes, refetch master.
//
// Revert is destructive and uses a two-step inline confirm to avoid a
// stray click wiping out files. The daemon's /rest/db/revert is fire-
// and-forget; the count drops on the next FolderSummary push.

export function LocalChangesBanner({ folderID }: { folderID: string }) {
  const fs = useFolderState(folderID);
  const status = useFolderStatus(folderID);
  const revert = useRevertFolder();
  const [confirming, setConfirming] = useState(false);

  // The daemon's "local changes" come in two buckets: edits/additions
  // (receiveOnlyChangedFiles) and deletions (receiveOnlyChangedDeletes).
  // Both need a Revert or Override to resolve, so we sum them for the
  // banner's trigger and headline count.
  const edits =
    fs?.receiveOnlyChangedFiles ??
    status.data?.receiveOnlyChangedFiles ??
    0;
  const deletes =
    fs?.receiveOnlyChangedDeletes ??
    status.data?.receiveOnlyChangedDeletes ??
    0;
  const count = edits + deletes;
  if (count <= 0) return null;

  const fileWord = `${count.toLocaleString()} file${count === 1 ? "" : "s"}`;

  return (
    <section className="space-y-2 rounded-md border border-amber-500/30 bg-amber-500/10 p-3">
      <header className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-sm font-semibold text-amber-200">
          Local changes detected
        </h3>
        <span className="text-xs text-amber-300/90">
          {fileWord} modified locally on this receive-only project.
        </span>
      </header>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-xs text-amber-200/80">
          Revert discards the local edits and re-downloads the original copy
          from the project owner. This can't be undone.
        </p>
        {!confirming ? (
          <button
            type="button"
            onClick={() => setConfirming(true)}
            className="shrink-0 rounded-md border border-amber-400/40 bg-amber-500/15 px-3 py-1.5 text-xs font-semibold text-amber-100 transition-colors hover:bg-amber-500/25"
          >
            Revert local changes
          </button>
        ) : (
          <div className="flex shrink-0 items-center gap-2">
            <span className="text-xs text-amber-100">
              Discard local edits to {fileWord}?
            </span>
            <button
              type="button"
              onClick={() => setConfirming(false)}
              className="rounded-md border border-line bg-panel px-2.5 py-1.5 text-xs text-fg-strong hover:bg-elevated"
              disabled={revert.isPending}
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => {
                revert.mutate(
                  { folderID },
                  { onSettled: () => setConfirming(false) },
                );
              }}
              className="rounded-md bg-rose-600 px-2.5 py-1.5 text-xs font-semibold text-white hover:bg-rose-500 disabled:opacity-60"
              disabled={revert.isPending}
            >
              {revert.isPending ? "Reverting…" : "Confirm revert"}
            </button>
          </div>
        )}
      </div>
      {revert.error && (
        <p className="text-xs text-rose-300">
          Revert failed:{" "}
          {revert.error instanceof Error
            ? revert.error.message
            : String(revert.error)}
        </p>
      )}
    </section>
  );
}
