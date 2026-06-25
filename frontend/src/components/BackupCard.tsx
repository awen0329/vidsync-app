// Per-project "Back up to Dropbox" card, shown on the Team tab.
//
//  - Owner: enable/disable backup, see last-backup time + file count + live
//    upload status, and trigger an immediate backup.
//  - Teammate: pull the owner's backed-up materials straight from Dropbox —
//    automatically when the owner is offline (so they can keep working without
//    asking the owner to turn their PC on), or on demand.
//
// The whole card hides outside the desktop host (Wails bindings absent).

import { useCallback, useEffect, useRef, useState } from "react";
import type { FolderConfiguration } from "../api/types";
import { useConnections } from "../api/hooks";
import { useProjectMembers } from "../api/cloud/hooks";
import { dropboxConnect } from "../lib/dropbox";
import { useDropboxAccount, refreshDropboxAccount } from "./useDropboxAccount";
import {
  backupAvailable,
  backupStatus,
  backupEnable,
  backupDisable,
  backupNow,
  backupPull,
  onBackupStatus,
  type BackupStatusInfo,
} from "../lib/backup";
import { pushToast } from "../lib/toast";

const cardClass =
  "rounded-lg border border-line bg-elevated p-4 text-sm text-fg-soft";
const btnClass =
  "rounded-md border border-line bg-elevated px-3 py-1.5 text-xs font-medium text-fg-soft shadow-sm transition-colors hover:bg-hover hover:text-fg-strong disabled:cursor-not-allowed disabled:opacity-50";

function formatWhen(ms: number): string {
  if (!ms) return "never";
  return new Date(ms).toLocaleString();
}

export function BackupCard({
  folder,
  isOwned,
  myID,
}: {
  folder: FolderConfiguration;
  isOwned: boolean;
  myID: string;
}) {
  // No hooks before this guard — keep the early return hook-safe by branching
  // to child components that own their own hooks.
  if (!backupAvailable()) return null;
  return isOwned ? (
    <OwnerBackup folder={folder} myID={myID} />
  ) : (
    <TeammateBackup folder={folder} />
  );
}

function OwnerBackup({
  folder,
  myID,
}: {
  folder: FolderConfiguration;
  myID: string;
}) {
  const [status, setStatus] = useState<BackupStatusInfo | null>(null);
  const [busy, setBusy] = useState(false);
  const account = useDropboxAccount();
  const dbxConfigured = account?.configured ?? false;
  const dbxConnected = account?.connected ?? false;

  const refresh = useCallback(() => {
    void backupStatus(folder.id).then(setStatus);
  }, [folder.id]);

  useEffect(() => {
    refresh();
    return onBackupStatus((s) => {
      if (s.folderId === folder.id) setStatus(s);
    });
  }, [folder.id, refresh]);

  const enabled = status?.enabled ?? false;

  const connectDropbox = async () => {
    setBusy(true);
    try {
      await dropboxConnect();
      await refreshDropboxAccount();
    } catch (e) {
      pushToast({ title: "Dropbox", body: errMsg(e) });
    } finally {
      setBusy(false);
    }
  };

  const enable = async () => {
    setBusy(true);
    try {
      await backupEnable(folder.id, folder.path, myID);
      pushToast({
        title: "Backup enabled",
        body: `${folder.label || folder.id} will back up to Dropbox.`,
      });
      refresh();
    } catch (e) {
      pushToast({ title: "Couldn't enable backup", body: errMsg(e) });
    } finally {
      setBusy(false);
    }
  };

  const disable = async () => {
    setBusy(true);
    try {
      await backupDisable(folder.id);
      pushToast({ title: "Backup turned off" });
      refresh();
    } catch (e) {
      pushToast({ title: "Couldn't turn off backup", body: errMsg(e) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={cardClass}>
      <div className="mb-2 flex items-center justify-between">
        <span className="font-medium text-fg-strong">Back up to Dropbox</span>
        {enabled && (
          <span className="text-xs text-fg-soft">
            {status?.uploading ? "Backing up…" : "On"}
          </span>
        )}
      </div>

      {!enabled && !dbxConfigured && (
        <p className="text-xs text-fg-faint">
          Dropbox isn't configured on this build yet (missing Dropbox app
          credentials). Backup will be available once it's set up.
        </p>
      )}

      {!enabled && dbxConfigured && !dbxConnected && (
        <div className="flex items-center justify-between gap-3">
          <p className="text-xs">
            Connect your Dropbox to keep a durable copy of this project and let
            teammates sync while you're offline.
          </p>
          <button
            type="button"
            className={btnClass}
            disabled={busy}
            onClick={connectDropbox}
          >
            Connect Dropbox
          </button>
        </div>
      )}

      {!enabled && dbxConfigured && dbxConnected && (
        <div className="flex items-center justify-between gap-3">
          <p className="text-xs">
            Mirror this project's materials to your Dropbox so they're backed up
            and reachable by teammates even when your PC is off.
          </p>
          <button
            type="button"
            className={btnClass}
            disabled={busy}
            onClick={enable}
          >
            Enable backup
          </button>
        </div>
      )}

      {enabled && (
        <div className="space-y-2">
          <dl className="grid grid-cols-2 gap-y-1 text-xs">
            <dt>Last backup</dt>
            <dd className="text-right text-fg-strong">
              {formatWhen(status?.lastBackupUnixMs ?? 0)}
            </dd>
            <dt>Files backed up</dt>
            <dd className="text-right text-fg-strong">
              {status?.fileCount ?? 0}
            </dd>
          </dl>
          {status?.lastError ? (
            <p className="text-xs text-red-500">{status.lastError}</p>
          ) : null}
          <div className="flex gap-2">
            <button
              type="button"
              className={btnClass}
              disabled={busy || status?.uploading}
              onClick={() => void backupNow(folder.id)}
            >
              Back up now
            </button>
            <button
              type="button"
              className={btnClass}
              disabled={busy}
              onClick={disable}
            >
              Turn off
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function TeammateBackup({ folder }: { folder: FolderConfiguration }) {
  const roster = useProjectMembers(folder.id);
  const conns = useConnections();
  const [pulling, setPulling] = useState(false);
  const autoPulled = useRef(false);

  const owner = roster.data?.find((m) => m.role === "owner");
  const ownerDeviceId = owner?.deviceId ?? null;
  const ownerOnline = ownerDeviceId
    ? !!conns.data?.connections[ownerDeviceId]?.connected
    : null;

  const pull = useCallback(
    async (silent: boolean) => {
      setPulling(true);
      try {
        const res = await backupPull(folder.id, folder.path);
        if (!silent || res.downloaded > 0) {
          pushToast({
            title:
              res.downloaded > 0
                ? `Downloaded ${res.downloaded} file${res.downloaded === 1 ? "" : "s"} from backup`
                : "Already up to date",
            body:
              res.failed > 0 ? `${res.failed} failed` : undefined,
          });
        }
      } catch (e) {
        if (!silent) pushToast({ title: "Couldn't pull backup", body: errMsg(e) });
      } finally {
        setPulling(false);
      }
    },
    [folder.id, folder.path],
  );

  // Auto-pull from the backup when the owner is offline, once per offline
  // stretch. Resets when the owner comes back so direct P2P sync takes over.
  useEffect(() => {
    if (!roster.data || !conns.data || !ownerDeviceId) return;
    if (ownerOnline) {
      autoPulled.current = false;
      return;
    }
    if (!autoPulled.current) {
      autoPulled.current = true;
      void pull(true);
    }
  }, [roster.data, conns.data, ownerDeviceId, ownerOnline, pull]);

  return (
    <div className={cardClass}>
      <div className="mb-2 flex items-center justify-between">
        <span className="font-medium text-fg-strong">Dropbox backup</span>
        {ownerOnline !== null && (
          <span className="text-xs text-fg-soft">
            {ownerOnline ? "Owner online" : "Owner offline"}
          </span>
        )}
      </div>
      <div className="flex items-center justify-between gap-3">
        <p className="text-xs">
          {ownerOnline === false
            ? "The owner is offline. Pull the latest materials straight from their Dropbox backup."
            : "Download this project's materials from the owner's Dropbox backup."}
        </p>
        <button
          type="button"
          className={btnClass}
          disabled={pulling}
          onClick={() => void pull(false)}
        >
          {pulling ? "Downloading…" : "Download from backup"}
        </button>
      </div>
    </div>
  );
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
