// Typed access to the owner-side Dropbox backup + teammate restore bridge
// bound in the desktop app (cmd/vidsync/backup.go). Mirrors lib/dropbox.ts:
// everything is optional-chained so the app still runs in dev/browser where
// the Wails bindings aren't injected, and the UI hides the feature there.

export interface BackupStatusInfo {
  enabled: boolean;
  uploading: boolean;
  lastBackupUnixMs: number;
  lastError: string;
  fileCount: number;
}

export interface BackupPullResult {
  downloaded: number;
  skipped: number;
  failed: number;
  bytes: number;
  error?: string;
}

// Live status pushed on the "backup:status" event carries the folder id so a
// card can filter to its own project.
export type BackupStatusEvent = BackupStatusInfo & { folderId: string };

export interface BackupProgress {
  name: string;
  bytesDone: number;
  bytesTotal: number;
  direction?: "download";
}

interface BackupBindings {
  BackupEnable: (
    folderID: string,
    folderPath: string,
    deviceID: string,
  ) => Promise<void>;
  BackupDisable: (folderID: string) => Promise<void>;
  BackupStatus: (folderID: string) => Promise<BackupStatusInfo>;
  BackupListEnabled: () => Promise<string[]>;
  BackupNow: (folderID: string) => Promise<void>;
  BackupPull: (
    folderID: string,
    folderPath: string,
  ) => Promise<BackupPullResult>;
}

function bindings(): BackupBindings | null {
  const w = window as unknown as {
    go?: { main?: { App?: Partial<BackupBindings> } };
  };
  const app = w.go?.main?.App;
  return app?.BackupStatus ? (app as BackupBindings) : null;
}

// True only in the desktop host. The UI hides the feature otherwise.
export function backupAvailable(): boolean {
  return bindings() !== null;
}

const emptyStatus: BackupStatusInfo = {
  enabled: false,
  uploading: false,
  lastBackupUnixMs: 0,
  lastError: "",
  fileCount: 0,
};

export async function backupStatus(
  folderID: string,
): Promise<BackupStatusInfo> {
  const b = bindings();
  if (!b) return emptyStatus;
  return b.BackupStatus(folderID);
}

export async function backupEnable(
  folderID: string,
  folderPath: string,
  deviceID: string,
): Promise<void> {
  const b = bindings();
  if (!b) throw new Error("Backup is only available in the desktop app.");
  return b.BackupEnable(folderID, folderPath, deviceID);
}

export async function backupDisable(folderID: string): Promise<void> {
  const b = bindings();
  if (!b) return;
  return b.BackupDisable(folderID);
}

export async function backupListEnabled(): Promise<string[]> {
  const b = bindings();
  if (!b) return [];
  return b.BackupListEnabled();
}

export async function backupNow(folderID: string): Promise<void> {
  const b = bindings();
  if (!b) return;
  return b.BackupNow(folderID);
}

export async function backupPull(
  folderID: string,
  folderPath: string,
): Promise<BackupPullResult> {
  const b = bindings();
  if (!b) throw new Error("Backup is only available in the desktop app.");
  return b.BackupPull(folderID, folderPath);
}

function eventsOn():
  | ((n: string, f: (...args: unknown[]) => void) => () => void)
  | null {
  const rt = (
    window as unknown as {
      runtime?: {
        EventsOn: (n: string, f: (...args: unknown[]) => void) => () => void;
      };
    }
  ).runtime;
  return rt?.EventsOn ?? null;
}

// Subscribe to live backup status updates (one per project as work happens).
// Returns an unsubscribe function.
export function onBackupStatus(
  cb: (s: BackupStatusEvent) => void,
): () => void {
  const on = eventsOn();
  if (!on) return () => {};
  return on("backup:status", (...args: unknown[]) => {
    const s = args[0] as BackupStatusEvent | undefined;
    if (s) cb(s);
  });
}

// Subscribe to per-file byte progress while an upload or download runs.
export function onBackupProgress(
  cb: (p: BackupProgress) => void,
): () => void {
  const on = eventsOn();
  if (!on) return () => {};
  return on("backup:progress", (...args: unknown[]) => {
    const p = args[0] as BackupProgress | undefined;
    if (p) cb(p);
  });
}
