import { useEffect, useMemo, useState } from "react";
import { Modal } from "./Modal";
import { Button } from "./Button";
import { FolderPicker } from "./FolderPicker";
import { useAddFolder, useConfig } from "../api/hooks";
import { useProjectQuota } from "../api/cloud/useProjectQuota";
import { client } from "../api/client";
import { origins } from "../api/origins";
import { isNativeDialogAvailable, pickFolder } from "../lib/folderDialog";
import {
  folderErrorMessage,
  isPathOverlapError,
  overlappingFolder,
} from "../lib/folderPath";
import { HIDE_BILLING } from "../App";

// NewProjectModal: create a new "owned" project. Used from both the
// dashboard and the Your Projects sidebar. The folder ID matches the
// 10-char lowercase-alnum convention the daemon uses internally.

export function NewProjectModal({
  open,
  onClose,
  onCreated,
  myID,
  initialPath,
}: {
  open: boolean;
  onClose: () => void;
  // Fires with the new folder ID after the daemon accepts the project.
  // Optional so the modal still works for callers that just want to
  // drop a project on disk without navigating. App.tsx uses this to
  // jump straight into the new project's detail page (instead of
  // leaving the user staring at the Projects grid wondering where it
  // went).
  onCreated?: (folderID: string) => void;
  myID: string;
  // initialPath seeds the local-folder field when the modal opens.
  // Used by the drag-and-drop handler in App.tsx so dropping a folder
  // onto the window lands the user one step into project creation.
  initialPath?: string;
}) {
  const [name, setName] = useState("");
  const [path, setPath] = useState("");
  const [picking, setPicking] = useState(false);

  // Re-seed when the modal is reopened with a new initialPath.
  // The empty-string default in useState above stays in effect for
  // manual "Create project" clicks where initialPath is undefined.
  useEffect(() => {
    if (open && initialPath) setPath(initialPath);
  }, [open, initialPath]);
  const add = useAddFolder();
  const quota = useProjectQuota();
  const cfg = useConfig();

  // Refuse a path that overlaps an existing project's folder — same dir,
  // a subfolder, or a parent. Two folders on one tree corrupt each other
  // (shared marker, cross-propagated deletes). The daemon enforces this
  // too (HTTP 409); this just surfaces it before the user hits Create.
  const pathConflict = useMemo(
    () => (path ? overlappingFolder(path, cfg.data?.folders ?? []) : null),
    [path, cfg.data?.folders],
  );

  return (
    <Modal
      open={open}
      onClose={() => {
        setName("");
        setPath("");
        onClose();
      }}
      title="Create project"
      primaryLabel="Create"
      primaryDisabled={
        !name || !path || !!pathConflict || add.isPending || !quota.canCreate
      }
      onPrimary={async () => {
        // Defense-in-depth. The CTA upstream already disables itself
        // at the cap; we re-check here in case state was stale at the
        // moment the modal opened.
        if (!quota.canCreate || pathConflict) return;
        const def = await client.defaultFolder();
        const id = randomFolderID();
        await add.mutateAsync({
          ...def,
          id,
          label: name,
          path,
          // Owner-created projects are the source of truth — push
          // local edits out, don't accept incoming changes that
          // would silently rewrite the master copy. Recipients
          // joining via AcceptFolderModal start in receive-only
          // mode, so the two roles default symmetrically.
          type: "sendonly",
          // Smallest-first means proxies/thumbnails clear before
          // multi-GB masters, so recipients can scrub the project
          // long before the big files finish downloading.
          order: "smallestFirst",
          devices: [{ deviceID: myID }],
        });
        origins.set(id, "owned");
        setName("");
        setPath("");
        onClose();
        // Navigate after closing so the modal unmount + view swap
        // happen in the same React commit — no flash of the empty
        // Projects grid before the detail page mounts.
        onCreated?.(id);
      }}
    >
      <p className="mb-4 text-sm text-fg-soft">
        Pick a folder on this computer and give it a name. Anything
        inside that folder becomes part of the project — files added,
        edited, or removed will sync to anyone you invite.
      </p>
      <label className="mb-3 block">
        <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-fg-soft">
          Project name
        </span>
        <input
          autoFocus
          value={name}
          onChange={(e) => setName(e.target.value)}
          className={inputClass}
          placeholder="Q3 Edit Room"
        />
      </label>
      <label className="mb-3 block">
        <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-fg-soft">
          Local folder
        </span>
        <div className="flex gap-2">
          <input
            value={path}
            onChange={(e) => setPath(e.target.value)}
            className={inputClass}
            placeholder="Choose a folder on this computer…"
          />
          <Button
            onClick={async () => {
              const chosen = await pickFolder("Choose a folder for the project", path);
              if (chosen) {
                setPath(chosen);
                // Seed the project name from the picked folder's
                // basename so the common case (project name === folder
                // name) is one less typing step. The field stays
                // editable, so a user who picked the folder first can
                // still rename afterwards.
                setName(basenameOf(chosen));
                return;
              }
              // In Wails the OS dialog handles cancel itself; only fall
              // back to the in-app picker in dev/browser where there's
              // no native dialog to begin with.
              if (!isNativeDialogAvailable()) setPicking(true);
            }}
          >
            Browse…
          </Button>
        </div>
      </label>
      {pathConflict && (
        <p className="mt-2 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm text-amber-200">
          This folder is already used by{" "}
          <span className="font-medium">
            {pathConflict.label || pathConflict.id}
          </span>
          . Pick a different folder — two projects can't share the same
          location.
        </p>
      )}
      {!quota.canCreate && (
        <p className="mt-2 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm text-amber-200">
          {quota.trialExpired
            ? HIDE_BILLING
              ? "Your free trial has ended."
              : "Your free trial has ended. Upgrade to keep creating projects."
            : quota.subscriptionInactive
              ? `Your ${quota.inactiveTierLabel ?? "paid"} subscription isn't active right now. Renew it to keep creating projects.`
              : HIDE_BILLING
                ? `You're at the ${quota.max}-project limit.`
                : `You're at the ${quota.max}-project limit on your current plan. Upgrade to add more.`}
        </p>
      )}
      {add.isError &&
        (isPathOverlapError(add.error) ? (
          // The daemon caught an overlap the lexical pre-check couldn't
          // (e.g. a macOS firmlink alias). Show it in the same amber alert
          // as a locally-detected conflict rather than a raw error code.
          <p className="mt-2 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm text-amber-200">
            {folderErrorMessage(add.error)}. Pick a different folder — two
            projects can&apos;t share the same location.
          </p>
        ) : (
          <p className="mt-2 text-sm text-rose-400">
            {folderErrorMessage(add.error)}
          </p>
        ))}
      <FolderPicker
        open={picking}
        onClose={() => setPicking(false)}
        onPick={(p) => {
          setPath(p);
          setName(basenameOf(p));
        }}
        initialPath={path}
      />
    </Modal>
  );
}

const inputClass =
  "w-full rounded-md border border-line bg-elevated px-3 py-2 text-sm text-fg-strong placeholder:text-fg-faint focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent";

function basenameOf(p: string): string {
  const stripped = p.replace(/[\\/]+$/, "");
  const idx = Math.max(stripped.lastIndexOf("/"), stripped.lastIndexOf("\\"));
  return idx < 0 ? stripped : stripped.slice(idx + 1);
}

function randomFolderID() {
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
  let s = "";
  for (let i = 0; i < 10; i++) {
    s += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  return s;
}
