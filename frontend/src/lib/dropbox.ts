// Typed access to the Dropbox import/export bridge bound in the desktop app
// (cmd/vidsync/cloud_dropbox.go). Mirrors the other window.go.main.App
// accessors (see lib/folderDialog.ts): everything is optional-chained so the
// app still runs in dev/browser where the Wails bindings aren't injected.

export interface DropboxAccount {
  connected: boolean;
  configured: boolean;
  email?: string;
  name?: string;
}

export interface DropboxEntry {
  name: string;
  path: string; // Dropbox path, e.g. "/Footage/clip.mov"
  isDir: boolean;
  size: number;
}

export interface DropboxProgress {
  phase:
    | "import"
    | "export"
    | "import-done"
    | "export-done"
    | "error";
  current: number;
  total: number;
  name: string;
  bytesDone: number;
  bytesTotal: number;
}

interface DropboxBindings {
  DropboxStatus: () => Promise<DropboxAccount>;
  DropboxConnect: () => Promise<DropboxAccount>;
  DropboxDisconnect: () => Promise<void>;
  DropboxList: (path: string) => Promise<DropboxEntry[]>;
  DropboxImport: (destDir: string, paths: string[]) => Promise<void>;
  DropboxExport: (
    srcDir: string,
    relPaths: string[],
    dropboxDest: string,
  ) => Promise<void>;
}

function bindings(): DropboxBindings | null {
  const w = window as unknown as {
    go?: { main?: { App?: Partial<DropboxBindings> } };
  };
  const app = w.go?.main?.App;
  return app?.DropboxStatus ? (app as DropboxBindings) : null;
}

// True only in the desktop host. The UI hides the feature otherwise.
export function dropboxAvailable(): boolean {
  return bindings() !== null;
}

export async function dropboxStatus(): Promise<DropboxAccount> {
  const b = bindings();
  if (!b) return { connected: false, configured: false };
  return b.DropboxStatus();
}

export async function dropboxConnect(): Promise<DropboxAccount> {
  const b = bindings();
  if (!b) throw new Error("Dropbox is only available in the desktop app.");
  return b.DropboxConnect();
}

export async function dropboxDisconnect(): Promise<void> {
  const b = bindings();
  if (!b) return;
  return b.DropboxDisconnect();
}

export async function dropboxList(path: string): Promise<DropboxEntry[]> {
  const b = bindings();
  if (!b) return [];
  return b.DropboxList(path);
}

export async function dropboxImport(
  destDir: string,
  paths: string[],
): Promise<void> {
  const b = bindings();
  if (!b) throw new Error("Dropbox is only available in the desktop app.");
  return b.DropboxImport(destDir, paths);
}

export async function dropboxExport(
  srcDir: string,
  relPaths: string[],
  dropboxDest: string,
): Promise<void> {
  const b = bindings();
  if (!b) throw new Error("Dropbox is only available in the desktop app.");
  return b.DropboxExport(srcDir, relPaths, dropboxDest);
}

// Subscribe to byte/file progress while an import or export runs. Returns an
// unsubscribe function. Uses the global Wails runtime event bus, like the
// rest of the app (see App.tsx / bearerAuth.tsx).
export function onDropboxProgress(
  cb: (p: DropboxProgress) => void,
): () => void {
  const rt = (
    window as unknown as {
      runtime?: {
        EventsOn: (n: string, f: (...args: unknown[]) => void) => () => void;
      };
    }
  ).runtime;
  if (!rt?.EventsOn) return () => {};
  return rt.EventsOn("dropbox:progress", (...args: unknown[]) => {
    const p = args[0] as DropboxProgress | undefined;
    if (p) cb(p);
  });
}
