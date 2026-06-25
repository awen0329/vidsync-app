// Per-project Dropbox-backup toggle state, shared by the project card and the
// project list row. Reports whether backup is on and exposes a toggle that
// links/unlinks the project on the cloud control plane (and starts/stops the
// local upload loop). Only does anything in the desktop host and when `active`
// (i.e. the project is owned by the current user).

import { useCallback, useEffect, useState } from "react";
import {
  backupAvailable,
  backupStatus,
  backupEnable,
  backupDisable,
  onBackupStatus,
} from "../lib/backup";
import { useDropboxAccount } from "./useDropboxAccount";
import { pushToast } from "../lib/toast";

export interface ProjectBackup {
  available: boolean;
  enabled: boolean;
  busy: boolean;
  toggle: () => void;
}

export function useProjectBackup(
  folderID: string,
  folderPath: string,
  deviceID: string,
  active: boolean,
): ProjectBackup {
  // The per-project toggle only makes sense once the user has connected their
  // Dropbox account (enabling backup needs the linked account's token). Until
  // then the icon stays hidden — the user connects via the sidebar first.
  const account = useDropboxAccount();
  const available = backupAvailable() && !!account?.connected;
  const [enabled, setEnabled] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!available || !active) return;
    let alive = true;
    void backupStatus(folderID).then((s) => {
      if (alive) setEnabled(s.enabled);
    });
    const off = onBackupStatus((s) => {
      if (s.folderId === folderID) setEnabled(s.enabled);
    });
    return () => {
      alive = false;
      off();
    };
  }, [available, active, folderID]);

  const toggle = useCallback(async () => {
    setBusy(true);
    try {
      if (enabled) {
        await backupDisable(folderID);
        setEnabled(false);
        pushToast({ title: "Dropbox backup off" });
      } else {
        await backupEnable(folderID, folderPath, deviceID);
        setEnabled(true);
        pushToast({
          title: "Backing up to Dropbox",
          body: "This project will mirror to your Dropbox.",
        });
      }
    } catch (e) {
      pushToast({
        title: "Dropbox backup",
        body: e instanceof Error ? e.message : String(e),
      });
    } finally {
      setBusy(false);
    }
  }, [enabled, folderID, folderPath, deviceID]);

  return { available, enabled, busy, toggle };
}
