import { useEffect, useMemo, useRef, useState } from "react";
import { Modal } from "./Modal";
import { Button } from "./Button";
import { useAddFolder, useConfig, useSystemStatus } from "../api/hooks";
import { client } from "../api/client";
import { origins } from "../api/origins";
import type { FolderConfiguration } from "../api/types";
import { pickFolder } from "../lib/folderDialog";
import {
  folderErrorMessage,
  isPathOverlapError,
  overlappingFolder,
} from "../lib/folderPath";
import { humanBytes } from "../lib/format";
import { cn } from "../lib/utils";

// AcceptFolderModal: prompts the user for a local path, then calls
// addFolder so the daemon starts syncing the offered folder. The
// invitation entry is automatically removed from /rest/cluster/pending
// once the folder exists.
//
// Defaults:
//   - The parent path seeds to the OS Downloads folder (matches what
//     users expect on Win/Mac/Linux for "stuff arriving on this
//     machine").
//   - "Create a subfolder named after the project" is on by default
//     so a recipient picking ~/Downloads ends up with each accepted
//     project in its own ~/Downloads/<project> directory instead of
//     all files spilling into the shared Downloads folder root.
//
// We also surface the destination disk's free space — large video
// projects routinely outgrow a laptop SSD and the user wants to know
// before they hit "Accept".

function joinProjectPath(parent: string, name: string): string {
  if (!parent) return name;
  if (!name) return parent;
  const sep = parent.includes("\\") ? "\\" : "/";
  const cleanParent = parent.replace(/[\\/]+$/, "");
  const cleanName = name.replace(/^[\\/]+/, "");
  return `${cleanParent}${sep}${cleanName}`;
}

function pathLastSegment(p: string): string {
  if (!p) return "";
  return p.replace(/[\\/]+$/, "").split(/[\\/]/).pop() ?? "";
}

export function AcceptFolderModal({
  info,
  sizeBytes,
  onClose,
  onAccepted,
  beforeAddFolder,
}: {
  info: { folderID: string; deviceID: string; label: string };
  // Project total size carried on the cloud invitation, when known.
  // Drives the "Project size" readout and the insufficient-space
  // warning. Undefined for daemon pending-folder offers, where the
  // size isn't available until the index arrives post-accept.
  sizeBytes?: number;
  onClose: () => void;
  onAccepted?: (folderID: string) => void;
  // Optional pre-flight callback. Used by the cloud-invitations flow
  // to defer the /v1/invitations/:id/accept POST until the user has
  // actually confirmed the destination path — if they close this
  // modal without hitting Accept, the cloud invitation must stay
  // pending so it doesn't vanish from their list.
  beforeAddFolder?: () => Promise<void>;
}) {
  const status = useSystemStatus();
  const myID = status.data?.myID ?? "";
  const add = useAddFolder();
  const cfg = useConfig();
  const [path, setPath] = useState("");
  const [useSubfolder, setUseSubfolder] = useState(true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  // Whether the current error is a path-overlap rejection — styled as an
  // amber alert (like the pre-check) rather than a red error.
  const [errIsOverlap, setErrIsOverlap] = useState(false);
  const [diskFree, setDiskFree] = useState<{
    path: string;
    free: number;
    total: number;
  } | null>(null);

  // Seed the path from the OS downloads dir on first mount (per
  // folder ID). Fallback to ~/Downloads if the daemon can't resolve
  // the home dir for some reason.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const dirs = await client.userDirs();
        if (cancelled) return;
        setPath(dirs.downloads || "~/Downloads");
      } catch {
        if (cancelled) return;
        setPath("~/Downloads");
      }
    })();
    setErr(null);
    setUseSubfolder(true);
    return () => {
      cancelled = true;
    };
  }, [info.folderID]);

  // Debounced disk-free lookup. Re-queries whenever the user picks a
  // new parent path so the "X GB free on Y" hint tracks the actual
  // destination drive.
  useEffect(() => {
    if (!path) {
      setDiskFree(null);
      return;
    }
    let cancelled = false;
    const t = setTimeout(() => {
      client
        .diskFree(path)
        .then((r) => {
          if (!cancelled) setDiskFree(r);
        })
        .catch(() => {
          if (!cancelled) setDiskFree(null);
        });
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [path]);

  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    ref.current?.focus();
  }, []);

  // The path the daemon will actually store. When the subfolder
  // option is on we append the project label unless the path already
  // ends in it (e.g. the user explicitly typed it).
  const resolvedPath = useMemo(() => {
    if (!useSubfolder || !info.label) return path;
    if (pathLastSegment(path) === info.label) return path;
    return joinProjectPath(path, info.label);
  }, [path, useSubfolder, info.label]);

  // Refuse a destination that overlaps an existing project's folder —
  // same dir, a subfolder, or a parent. A receive-only invited folder
  // sharing a tree with another folder lets the owner's deletes/overwrites
  // bleed across projects. The daemon enforces this too (HTTP 409); this
  // surfaces it before the user hits Accept.
  const pathConflict = useMemo(
    () =>
      resolvedPath
        ? overlappingFolder(
            resolvedPath,
            cfg.data?.folders ?? [],
            info.folderID,
          )
        : null,
    [resolvedPath, cfg.data?.folders, info.folderID],
  );

  // Whether we have a usable project size to show. The owner sends 0 /
  // omits it when the folder hasn't been scanned yet, so treat only a
  // positive number as known.
  const haveSize = typeof sizeBytes === "number" && sizeBytes > 0;
  // Not enough room on the destination drive. We only flag this once we
  // know both the project size and the drive's free space; we warn but
  // still let the user proceed (they may be freeing space, or the
  // destination is a different drive than they expect and they'll fix
  // the path). diskFree.free is the bytes available to this user.
  const insufficientSpace =
    haveSize && diskFree != null && diskFree.free < (sizeBytes as number);

  // Tri-state for the disk-space badge shown in front of both readouts.
  // "ok" only once we know the project fits the destination drive;
  // "low" when we know it doesn't; "unknown" while either the project
  // size or the drive's free space is still missing (so we never flash
  // a reassuring green before we can actually vouch for the fit).
  const spaceState: "ok" | "low" | "unknown" =
    !haveSize || diskFree == null
      ? "unknown"
      : insufficientSpace
        ? "low"
        : "ok";

  const submit = async () => {
    if (!myID) {
      setErr("Still connecting — try again in a moment.");
      return;
    }
    if (!resolvedPath) {
      setErr("Pick a folder first.");
      return;
    }
    if (pathConflict) {
      setErr(
        `This folder is already used by ${pathConflict.label || pathConflict.id}. Choose a different location.`,
      );
      setErrIsOverlap(true);
      return;
    }
    setBusy(true);
    setErr(null);
    setErrIsOverlap(false);
    try {
      // Cloud-side accept runs first (when present) so a failure
      // there short-circuits before we add anything locally — the
      // user keeps their pending invitation and sees the reason.
      if (beforeAddFolder) {
        await beforeAddFolder();
      }
      // Register the owner's device as a first-class config entry (with
      // sane transport defaults) BEFORE adding the folder — mirrors the
      // owner side's InvitationBridge.ensureDeviceKnown. Without this the
      // folder references a device that isn't in config.devices, so the
      // owner's daemon keeps resurfacing as a "pending device" connection
      // request on reconnects instead of being trusted outright.
      const live = await client.config();
      if (!live.devices.some((d) => d.deviceID === info.deviceID)) {
        const devDef = await client.defaultDevice();
        await client.addDevice({
          ...devDef,
          deviceID: info.deviceID,
          name: info.deviceID.slice(0, 7),
        });
      }
      const def = await client.defaultFolder();
      const folder: FolderConfiguration = {
        ...def,
        id: info.folderID,
        label: info.label,
        path: resolvedPath,
        // Recipients consume the owner's master copy — accept their
        // edits but don't push our local changes back upstream. The
        // owner side of this same project defaults symmetrically to
        // sendonly in NewProjectModal.
        type: "receiveonly",
        // Smallest-first so proxies clear before multi-GB masters
        // and the recipient can start scrubbing the project quickly.
        order: "smallestFirst",
        devices: [{ deviceID: myID }, { deviceID: info.deviceID }],
      };
      await add.mutateAsync(folder);
      origins.set(info.folderID, "invited");
      onAccepted?.(info.folderID);
      onClose();
    } catch (e) {
      const overlap = isPathOverlapError(e);
      setErr(
        overlap
          ? `${folderErrorMessage(e)}. Choose a different location.`
          : folderErrorMessage(e),
      );
      setErrIsOverlap(overlap);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      title={`Accept ${info.label}`}
      primaryLabel="Accept"
      primaryDisabled={busy || !path || !!pathConflict}
      onPrimary={submit}
    >
      <p className="mb-3 text-sm text-fg-soft">
        Choose where on this computer to store the synced files.
      </p>
      <label className="mb-3 block">
        <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-fg-soft">
          Local folder
        </span>
        <div className="flex gap-2">
          <input
            ref={ref}
            value={path}
            onChange={(e) => setPath(e.target.value)}
            className="w-full rounded-md border border-line bg-elevated px-3 py-2 text-sm text-fg-strong focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent"
          />
          <Button
            onClick={async () => {
              const chosen = await pickFolder(
                "Choose a folder for this project",
                path,
              );
              if (chosen) setPath(chosen);
            }}
          >
            Browse…
          </Button>
        </div>
        <label className="mt-2 flex items-start gap-2 text-xs text-fg-soft">
          <input
            type="checkbox"
            checked={useSubfolder}
            onChange={(e) => setUseSubfolder(e.target.checked)}
            className="mt-0.5 accent-accent"
          />
          <span>
            Create a subfolder named after the project under this path.
            {resolvedPath && resolvedPath !== path && (
              <span className="ml-1 text-fg-faint">
                (Resolves to{" "}
                <span className="font-mono text-fg">{resolvedPath}</span>)
              </span>
            )}
          </span>
        </label>
      </label>
      <div className="mt-1 grid grid-cols-2 gap-2 rounded-md border border-line bg-elevated/40 px-3 py-2 text-xs">
        <div>
          <div className="flex items-center gap-1.5 text-fg-faint">
            <SpaceBadge state={spaceState} />
            Project size
          </div>
          <div
            className={cn(
              "font-mono",
              insufficientSpace ? "text-amber-300" : "text-fg",
            )}
            title={
              haveSize
                ? "Total size of the project to download, as reported by the sender."
                : "Final size is known once the daemon receives the project's index."
            }
          >
            {haveSize ? humanBytes(sizeBytes as number) : "—"}
          </div>
        </div>
        <div>
          <div className="flex items-center gap-1.5 text-fg-faint">
            <SpaceBadge state={spaceState} />
            Free on this drive
          </div>
          <div
            className={cn(
              "font-mono",
              insufficientSpace ? "text-amber-300" : "text-fg",
            )}
          >
            {diskFree
              ? `${humanBytes(diskFree.free)} of ${humanBytes(diskFree.total)}`
              : "—"}
          </div>
        </div>
      </div>
      {insufficientSpace && (
        <p className="mt-2 flex items-start gap-1.5 text-xs text-amber-300">
          <WarningGlyph />
          <span>
            This project needs {humanBytes(sizeBytes as number)} but only{" "}
            {humanBytes(diskFree!.free)} is free on this drive. You can still
            accept — syncing will pause if the drive fills up. Consider freeing
            space or choosing another location.
          </span>
        </p>
      )}
      {pathConflict && (
        <p className="mt-2 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm text-amber-200">
          This folder is already used by{" "}
          <span className="font-medium">
            {pathConflict.label || pathConflict.id}
          </span>
          . Pick a different location — two projects can't share the same
          folder.
        </p>
      )}
      {err &&
        (errIsOverlap ? (
          <p className="mt-2 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm text-amber-200">
            {err}
          </p>
        ) : (
          <p className="mt-2 text-sm text-rose-700">{err}</p>
        ))}
    </Modal>
  );
}

// Disk-space status badge rendered in front of the "Project size" and
// "Free on this drive" labels. A single icon family across three states
// so the two readouts read as a matched pair:
//   - ok      → emerald check  (the project fits this drive)
//   - low     → amber alert     (not enough room — pairs with the warning below)
//   - unknown → muted dash      (size or free space not known yet)
function SpaceBadge({ state }: { state: "ok" | "low" | "unknown" }) {
  const tone =
    state === "ok"
      ? "text-emerald-400"
      : state === "low"
        ? "text-amber-300"
        : "text-fg-faint";
  const label =
    state === "ok"
      ? "Enough free space on the destination drive"
      : state === "low"
        ? "Not enough free space on the destination drive"
        : "Free space not known yet";
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={cn("h-3.5 w-3.5 shrink-0", tone)}
      role="img"
      aria-label={label}
    >
      <title>{label}</title>
      <circle cx="8" cy="8" r="6.5" />
      {state === "ok" && <path d="M5.3 8.2 7 9.9l3.6-3.9" />}
      {state === "low" && <path d="M8 4.8v3.4M8 11h.01" />}
      {state === "unknown" && <path d="M5.4 8h5.2" />}
    </svg>
  );
}

// Small triangle-bang icon for the insufficient-space warning. Inline
// so the modal doesn't pull in an icon dependency for one glyph.
function WarningGlyph() {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="mt-0.5 h-3.5 w-3.5 shrink-0"
      aria-hidden
    >
      <path d="M8 1.5 1 14h14L8 1.5Z" />
      <path d="M8 6.5v3.5" />
      <path d="M8 12h.01" />
    </svg>
  );
}
