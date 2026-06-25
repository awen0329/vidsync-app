// Typed REST client for the sync daemon. Mirrors
// internal/gui/client/client.go on the Go side.
//
// baseURL is always "" — fetches are same-origin. In dev, Vite's
// proxy forwards /rest/* to the daemon and injects X-API-Key from
// VITE_API_KEY. In Wails desktop, cmd/vidsync/proxy.go does the
// same job in the embedded asset server.

import type {
  Completion,
  Configuration,
  Connections,
  DeviceConfiguration,
  FolderConfiguration,
  FolderNeed,
  FolderStatus,
  LogResponse,
  PendingDevice,
  PendingFolder,
  SyncEvent,
  SystemStatus,
  SystemVersion,
} from "./types";

export class APIError extends Error {
  constructor(
    public readonly method: string,
    public readonly path: string,
    public readonly status: number,
    public readonly body: string,
  ) {
    super(`${method} ${path}: ${status} ${body}`);
    this.name = "APIError";
  }
}

export interface ClientConfig {
  baseURL: string;
  apiKey: string;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const EVENT_POLL_TIMEOUT_S = 60;

export class SyncthingClient {
  constructor(private cfg: ClientConfig) {}

  get baseURL() {
    return this.cfg.baseURL;
  }

  // configure swaps the endpoint at runtime. Used by main.tsx to
  // inject the daemon URL + API key handed to us by the Wails host
  // before React renders. Subsequent fetches use the new values; in
  // flight requests are unaffected.
  configure(cfg: ClientConfig): void {
    this.cfg = cfg;
  }

  private async request<T>(
    method: string,
    path: string,
    options: {
      query?: Record<string, string>;
      body?: unknown;
      signal?: AbortSignal;
      noTimeout?: boolean;
    } = {},
  ): Promise<T> {
    const url = new URL(this.cfg.baseURL + path, window.location.origin);
    if (options.query) {
      for (const [k, v] of Object.entries(options.query)) {
        if (v !== undefined && v !== "") url.searchParams.set(k, v);
      }
    }

    const ctl = new AbortController();
    if (!options.noTimeout) {
      setTimeout(() => ctl.abort(), DEFAULT_TIMEOUT_MS);
    }
    const signal = options.signal ?? ctl.signal;

    const headers: Record<string, string> = {
      Accept: "application/json",
    };
    if (this.cfg.apiKey) headers["X-API-Key"] = this.cfg.apiKey;
    if (options.body !== undefined) headers["Content-Type"] = "application/json";

    const res = await fetch(url, {
      method,
      headers,
      body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
      signal,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new APIError(method, path, res.status, body.slice(0, 4000));
    }
    if (res.status === 204) return undefined as T;
    const contentType = res.headers.get("content-type") || "";
    if (contentType.includes("application/json")) {
      return (await res.json()) as T;
    }
    return (await res.text()) as unknown as T;
  }

  // --- system

  ping(): Promise<void> {
    return this.request<void>("GET", "/rest/system/ping");
  }

  systemStatus(): Promise<SystemStatus> {
    return this.request<SystemStatus>("GET", "/rest/system/status");
  }

  systemVersion(): Promise<SystemVersion> {
    return this.request<SystemVersion>("GET", "/rest/system/version");
  }

  systemLog(since?: string): Promise<LogResponse> {
    return this.request<LogResponse>("GET", "/rest/system/log", {
      query: since ? { since } : undefined,
    });
  }

  browse(current = ""): Promise<string[]> {
    return this.request<string[]>("GET", "/rest/system/browse", {
      query: current ? { current } : undefined,
    });
  }

  restart(): Promise<void> {
    return this.request<void>("POST", "/rest/system/restart");
  }

  shutdown(): Promise<void> {
    return this.request<void>("POST", "/rest/system/shutdown");
  }

  pause(deviceID = ""): Promise<void> {
    return this.request<void>("POST", "/rest/system/pause", {
      query: deviceID ? { device: deviceID } : undefined,
    });
  }

  resume(deviceID = ""): Promise<void> {
    return this.request<void>("POST", "/rest/system/resume", {
      query: deviceID ? { device: deviceID } : undefined,
    });
  }

  // --- config

  config(): Promise<Configuration> {
    return this.request<Configuration>("GET", "/rest/config");
  }

  configOptions(): Promise<Record<string, unknown>> {
    return this.request<Record<string, unknown>>(
      "GET",
      "/rest/config/options",
    );
  }

  patchConfigOptions(patch: Record<string, unknown>): Promise<void> {
    return this.request<void>("PATCH", "/rest/config/options", { body: patch });
  }

  defaultFolder(): Promise<FolderConfiguration> {
    return this.request<FolderConfiguration>("GET", "/rest/config/defaults/folder");
  }

  defaultDevice(): Promise<DeviceConfiguration> {
    return this.request<DeviceConfiguration>("GET", "/rest/config/defaults/device");
  }

  addFolder(f: FolderConfiguration): Promise<void> {
    return this.request<void>("POST", "/rest/config/folders", { body: f });
  }

  putFolder(f: FolderConfiguration): Promise<void> {
    return this.request<void>("PUT", `/rest/config/folders/${f.id}`, { body: f });
  }

  patchFolder(id: string, patch: Partial<FolderConfiguration>): Promise<void> {
    return this.request<void>("PATCH", `/rest/config/folders/${id}`, { body: patch });
  }

  deleteFolder(id: string): Promise<void> {
    return this.request<void>("DELETE", `/rest/config/folders/${id}`);
  }

  addDevice(d: DeviceConfiguration): Promise<void> {
    return this.request<void>("POST", "/rest/config/devices", { body: d });
  }

  putDevice(d: DeviceConfiguration): Promise<void> {
    return this.request<void>("PUT", `/rest/config/devices/${d.deviceID}`, { body: d });
  }

  patchDevice(id: string, patch: Partial<DeviceConfiguration>): Promise<void> {
    return this.request<void>("PATCH", `/rest/config/devices/${id}`, { body: patch });
  }

  deleteDevice(id: string): Promise<void> {
    return this.request<void>("DELETE", `/rest/config/devices/${id}`);
  }

  // --- db / status

  folderStatus(folderID: string): Promise<FolderStatus> {
    return this.request<FolderStatus>("GET", "/rest/db/status", {
      query: { folder: folderID },
    });
  }

  completion(folderID = "", deviceID = ""): Promise<Completion> {
    return this.request<Completion>("GET", "/rest/db/completion", {
      query: { folder: folderID, device: deviceID },
    });
  }

  folderNeed(folderID: string, page = 1, perpage = 20): Promise<FolderNeed> {
    return this.request<FolderNeed>("GET", "/rest/db/need", {
      query: {
        folder: folderID,
        page: String(page),
        perpage: String(perpage),
      },
    });
  }

  folderErrors(
    folderID: string,
    page = 1,
    perpage = 50,
  ): Promise<{ errors: { path: string; error: string }[]; page: number; perpage: number }> {
    return this.request("GET", "/rest/folder/errors", {
      query: {
        folder: folderID,
        page: String(page),
        perpage: String(perpage),
      },
    });
  }

  bringToFront(folderID: string, file: string): Promise<unknown> {
    return this.request("POST", "/rest/db/prio", {
      query: { folder: folderID, file },
    });
  }

  // Revert: discard local-only changes in a receive-only folder and
  // re-fetch the master copy. Fire-and-forget on the daemon side — the
  // response comes back immediately and the actual revert proceeds async.
  revertFolder(folderID: string): Promise<unknown> {
    return this.request("POST", "/rest/db/revert", {
      query: { folder: folderID },
    });
  }

  // Resync: re-create the project folder root + marker and kick off a
  // scan. Used to clear ErrPathMissing / ErrMarkerMissing after the
  // user has either restored the directory or repointed the folder at
  // a new path.
  resyncFolder(folderID: string): Promise<void> {
    return this.request<void>("POST", "/rest/folder/resync", {
      query: { folder: folderID },
    });
  }

  // Kick a scan on demand. Cheap when nothing changed; used to nudge
  // the daemon into running a health check (CheckPath) so a missing
  // marker / path surfaces in the folder's error state quickly. The
  // daemon's automatic rescan is hourly which is too slow for an
  // interactive "why isn't this syncing?" loop.
  // fileContentKey returns the file's content fingerprint (Syncthing
  // BlocksHash, base64) — stable across renames. Used to key review comments
  // to the file's content rather than its path. Returns "" if the daemon
  // doesn't know the file or has no hash yet (caller falls back to path).
  async fileContentKey(folderID: string, path: string): Promise<string> {
    try {
      const r = await this.request<{
        global?: { blocksHash?: string | null };
        local?: { blocksHash?: string | null };
      }>("GET", "/rest/db/file", { query: { folder: folderID, file: path } });
      return r.global?.blocksHash || r.local?.blocksHash || "";
    } catch {
      return "";
    }
  }

  scanFolder(folderID: string, sub?: string): Promise<void> {
    const query: Record<string, string> = { folder: folderID };
    // A sub-path scan indexes just that subtree — used after writing a
    // comment sidecar so it's picked up + synced without rescanning the
    // whole (potentially huge) project folder.
    if (sub) query.sub = sub;
    return this.request<void>("POST", "/rest/db/scan", { query });
  }

  // Per-user filesystem locations resolved by the daemon. Used to
  // seed the AcceptFolderModal's default destination to the OS
  // downloads folder rather than a tilde-prefixed daemon path.
  userDirs(): Promise<{ home?: string; downloads?: string; documents?: string }> {
    return this.request("GET", "/rest/system/userdirs");
  }

  // Free / total bytes for the disk that contains `path`. Daemon
  // walks up to the nearest existing parent if the path itself
  // doesn't exist yet. The returned `path` echoes what was used so
  // the UI can show e.g. "free on C:\".
  diskFree(path: string): Promise<{ path: string; free: number; total: number }> {
    return this.request("GET", "/rest/system/diskfree", {
      query: { path },
    });
  }

  // GlobalDirectoryTree: dirs map to nested objects, files map to a
  // tuple [modtime, size]. We walk this for conflict detection.
  //
  // `local=true` flips the daemon onto the LocalDirectoryTree path,
  // which iterates this peer's local file index instead of the merged
  // global view. The FileGrid uses this so files this peer just
  // deleted disappear immediately even if the deletion hasn't yet
  // propagated to other peers. ConflictsBanner still wants the global
  // view (a conflict from a peer should show even if we don't have
  // the file locally), so it stays on the default.
  dbBrowse(
    folderID: string,
    prefix = "",
    levels = -1,
    opts: { local?: boolean } = {},
  ): Promise<unknown> {
    const query: Record<string, string> = { folder: folderID };
    if (prefix) query.prefix = prefix;
    if (levels >= 0) query.levels = String(levels);
    if (opts.local) query.local = "true";
    return this.request<unknown>("GET", "/rest/db/browse", { query });
  }

  // .stignore patterns. The daemon returns { ignore, expanded, error };
  // we only care about ignore on read and ignore on write.
  getIgnores(folderID: string): Promise<{
    ignore: string[] | null;
    expanded: string[] | null;
    error: string | null;
  }> {
    return this.request("GET", "/rest/db/ignores", {
      query: { folder: folderID },
    });
  }

  setIgnores(folderID: string, lines: string[]): Promise<unknown> {
    return this.request("POST", "/rest/db/ignores", {
      query: { folder: folderID },
      body: { ignore: lines },
    });
  }

  // --- versioning

  folderVersions(
    folderID: string,
  ): Promise<Record<string, { versionTime: string; modTime: string; size: number }[]>> {
    return this.request("GET", "/rest/folder/versions", {
      query: { folder: folderID },
    });
  }

  restoreFolderVersions(
    folderID: string,
    versions: Record<string, string>,
  ): Promise<Record<string, string>> {
    return this.request("POST", "/rest/folder/versions", {
      query: { folder: folderID },
      body: versions,
    });
  }

  connections(): Promise<Connections> {
    return this.request<Connections>("GET", "/rest/system/connections");
  }

  // --- pending shares

  pendingDevices(): Promise<Record<string, PendingDevice>> {
    return this.request<Record<string, PendingDevice>>(
      "GET",
      "/rest/cluster/pending/devices",
    );
  }

  pendingFolders(deviceID = ""): Promise<Record<string, PendingFolder>> {
    return this.request<Record<string, PendingFolder>>(
      "GET",
      "/rest/cluster/pending/folders",
      { query: deviceID ? { device: deviceID } : undefined },
    );
  }

  dismissPendingDevice(deviceID: string): Promise<void> {
    return this.request<void>("DELETE", "/rest/cluster/pending/devices", {
      query: { device: deviceID },
    });
  }

  dismissPendingFolder(folderID: string, deviceID = ""): Promise<void> {
    return this.request<void>("DELETE", "/rest/cluster/pending/folders", {
      query: { folder: folderID, device: deviceID },
    });
  }

  // --- events

  events(
    since: number,
    signal?: AbortSignal,
    filter?: string[],
  ): Promise<SyncEvent[]> {
    const query: Record<string, string> = {
      since: String(since),
      limit: "100",
      timeout: String(EVENT_POLL_TIMEOUT_S),
    };
    if (filter && filter.length > 0) query.events = filter.join(",");
    return this.request<SyncEvent[]>("GET", "/rest/events", {
      query,
      signal,
      noTimeout: true,
    });
  }
}

// Default config targets dev: same-origin against the Vite dev server
// (which proxies /rest/* and injects X-API-Key). main.tsx overrides
// via client.configure() at startup when running inside Wails.
export const client = new SyncthingClient({
  baseURL: "",
  apiKey: import.meta.env.VITE_API_KEY ?? "",
});
