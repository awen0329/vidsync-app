import type {
  ActivityItem,
  FolderState,
  PeerState,
  PendingDevice,
  PendingFolder,
  PullerProgress,
  Snapshot,
  SyncEventEnvelope,
  TransferRate,
} from "./types";

// Realtime state container. Plain class with a manual subscribe/notify
// pattern — small enough that pulling in zustand would be overkill,
// and we want full control over how reducer-produced state preserves
// reference equality (which matters for selector hooks downstream).

type Listener = () => void;

const MAX_ACTIVITY = 100;
const RATE_WINDOW_SAMPLES = 5;

interface RateSample {
  t: number;
  bytesDone: number;
}

const EMPTY_SNAPSHOT: Snapshot = {
  folders: {},
  peers: {},
  transfers: {},
  rates: {},
  activity: [],
  pendingDevices: {},
  pendingFolders: {},
  status: { connected: false, lastError: null, eventsReceived: 0 },
};

class RealtimeStore {
  private state: Snapshot = EMPTY_SNAPSHOT;
  private listeners = new Set<Listener>();
  // Per-(folder,file) rolling samples for transfer-rate smoothing.
  // Kept outside the snapshot because consumers never read it directly.
  private samples: Record<string, Record<string, RateSample[]>> = {};

  // Bound so callers can pass these as React hook arguments without
  // needing arrow wrappers.
  getSnapshot = (): Snapshot => this.state;

  subscribe = (cb: Listener): (() => void) => {
    this.listeners.add(cb);
    return () => {
      this.listeners.delete(cb);
    };
  };

  setConnected(connected: boolean, lastError: string | null = null): void {
    const cur = this.state.status;
    if (cur.connected === connected && cur.lastError === lastError) return;
    this.state = {
      ...this.state,
      status: { ...cur, connected, lastError },
    };
    this.emit();
  }

  applyEvents(events: SyncEventEnvelope[]): void {
    let next = this.state;
    for (const ev of events) {
      next = reduce(next, ev, this.samples);
    }
    if (next !== this.state) {
      this.state = next;
      this.emit();
    }
  }

  setPendingDevices(devices: Record<string, PendingDevice>): void {
    this.state = { ...this.state, pendingDevices: devices };
    this.emit();
  }

  setPendingFolders(folders: Record<string, PendingFolder>): void {
    this.state = { ...this.state, pendingFolders: folders };
    this.emit();
  }

  // seedFolder fills in (or refreshes) a folder's state from a REST
  // /db/status payload. Used by RealtimeProvider at boot to cover the
  // case where the daemon's event buffer doesn't include a recent
  // FolderSummary — without this, settled folders rendered with
  // 0 files / 0 B / no updated-time until something happened to
  // trigger a fresh event. We do NOT overwrite a richer existing
  // entry that's already richer than the seed (rare in practice,
  // but cheap to be safe).
  seedFolder(
    folderID: string,
    s: {
      state?: string;
      stateChanged?: string;
      needFiles?: number;
      needBytes?: number;
      localFiles?: number;
      localBytes?: number;
      globalFiles?: number;
      globalBytes?: number;
      errors?: number;
      sequence?: number;
      error?: string;
      watchError?: string;
      receiveOnlyChangedFiles?: number;
      receiveOnlyChangedBytes?: number;
      receiveOnlyChangedDeletes?: number;
    },
  ): void {
    if (!folderID) return;
    const cur = this.state.folders[folderID];
    const globalBytes = s.globalBytes ?? cur?.globalBytes ?? 0;
    const needBytes = s.needBytes ?? cur?.needBytes ?? 0;
    const completion =
      globalBytes > 0
        ? Math.max(0, 100 - (needBytes / globalBytes) * 100)
        : 100;
    const next: FolderState = {
      id: folderID,
      state: s.state ?? cur?.state ?? "idle",
      stateChanged: s.stateChanged ?? cur?.stateChanged ?? "",
      needFiles: s.needFiles ?? cur?.needFiles ?? 0,
      needBytes,
      localFiles: s.localFiles ?? cur?.localFiles ?? 0,
      localBytes: s.localBytes ?? cur?.localBytes ?? 0,
      globalFiles: s.globalFiles ?? cur?.globalFiles ?? 0,
      globalBytes,
      completion,
      errors: s.errors ?? cur?.errors ?? 0,
      sequence: s.sequence ?? cur?.sequence ?? 0,
      // At seed time we have no event-stream history to consult, so
      // best-guess lastSeqChanged from stateChanged. A subsequent
      // FolderSummary that preserves sequence will keep this value;
      // one that bumps sequence will overwrite it with the real time.
      lastSeqChanged: cur?.lastSeqChanged ?? s.stateChanged,
      paused: cur?.paused ?? false,
      error: s.error || cur?.error,
      watchError: s.watchError || cur?.watchError,
      receiveOnlyChangedFiles:
        s.receiveOnlyChangedFiles ?? cur?.receiveOnlyChangedFiles ?? 0,
      receiveOnlyChangedBytes:
        s.receiveOnlyChangedBytes ?? cur?.receiveOnlyChangedBytes ?? 0,
      receiveOnlyChangedDeletes:
        s.receiveOnlyChangedDeletes ?? cur?.receiveOnlyChangedDeletes ?? 0,
    };
    this.state = {
      ...this.state,
      folders: { ...this.state.folders, [folderID]: next },
    };
    this.emit();
  }

  // Test/dev helper: reset to empty. Not used in production.
  reset(): void {
    this.state = EMPTY_SNAPSHOT;
    this.samples = {};
    this.emit();
  }

  private emit(): void {
    for (const l of this.listeners) l();
  }
}

function reduce(
  s: Snapshot,
  ev: SyncEventEnvelope,
  samples: Record<string, Record<string, RateSample[]>>,
): Snapshot {
  // Bump events-received counter on every event we accept.
  const status = {
    ...s.status,
    eventsReceived: s.status.eventsReceived + 1,
  };
  s = { ...s, status };

  switch (ev.type) {
    case "FolderSummary":
      return applyFolderSummary(s, ev);
    case "StateChanged":
      return applyStateChanged(s, ev);
    case "DeviceConnected":
      return applyDeviceConnected(s, ev);
    case "DeviceDisconnected":
      return applyDeviceDisconnected(s, ev);
    case "DownloadProgress":
      return applyDownloadProgress(s, ev, samples);
    case "ItemFinished":
      return applyItemFinished(s, ev);
    case "LocalChangeDetected":
      return applyLocalChangeDetected(s, ev);
    default:
      return s;
  }
}

function applyFolderSummary(s: Snapshot, ev: SyncEventEnvelope): Snapshot {
  const d = ev.data as {
    folder?: string;
    summary?: {
      state?: string;
      stateChanged?: string;
      needFiles?: number;
      needBytes?: number;
      localFiles?: number;
      localBytes?: number;
      globalFiles?: number;
      globalBytes?: number;
      errors?: number;
      sequence?: number;
      paused?: boolean;
      error?: string;
      watchError?: string;
      receiveOnlyChangedFiles?: number;
      receiveOnlyChangedBytes?: number;
      receiveOnlyChangedDeletes?: number;
    };
  };
  if (!d?.folder || !d.summary) return s;
  const sum = d.summary;
  const globalBytes = sum.globalBytes ?? 0;
  const needBytes = sum.needBytes ?? 0;
  const completion =
    globalBytes > 0 ? Math.max(0, 100 - (needBytes / globalBytes) * 100) : 100;
  const cur = s.folders[d.folder];
  const nextSeq = sum.sequence ?? cur?.sequence ?? 0;
  // The daemon bumps stateChanged on every state transition,
  // including the scanning→idle round-trip from periodic rescans
  // that find no changes. sequence only moves when the index has
  // a real new/changed/removed entry, so it's the honest signal
  // for "last edit". We anchor on the moment of the bump (ev.time)
  // and otherwise preserve whatever cur had.
  const seqMoved = cur ? nextSeq !== cur.sequence : true;
  const lastSeqChanged = seqMoved
    ? ev.time
    : cur?.lastSeqChanged ?? sum.stateChanged ?? ev.time;
  const next: FolderState = {
    id: d.folder,
    state: sum.state ?? cur?.state ?? "idle",
    stateChanged: sum.stateChanged ?? cur?.stateChanged ?? ev.time,
    needFiles: sum.needFiles ?? 0,
    needBytes,
    localFiles: sum.localFiles ?? 0,
    localBytes: sum.localBytes ?? 0,
    globalFiles: sum.globalFiles ?? 0,
    globalBytes,
    completion,
    errors: sum.errors ?? 0,
    sequence: nextSeq,
    lastSeqChanged,
    paused: sum.paused ?? cur?.paused ?? false,
    error: sum.error || undefined,
    watchError: sum.watchError || undefined,
    receiveOnlyChangedFiles: sum.receiveOnlyChangedFiles ?? 0,
    receiveOnlyChangedBytes: sum.receiveOnlyChangedBytes ?? 0,
    receiveOnlyChangedDeletes: sum.receiveOnlyChangedDeletes ?? 0,
  };
  if (cur && shallowFolderEqual(cur, next)) return s;
  return { ...s, folders: { ...s.folders, [d.folder]: next } };
}

function applyStateChanged(s: Snapshot, ev: SyncEventEnvelope): Snapshot {
  const d = ev.data as { folder?: string; from?: string; to?: string };
  if (!d?.folder || !d.to) return s;
  const cur = s.folders[d.folder];
  if (cur && cur.state === d.to) return s;
  const next: FolderState = cur
    ? { ...cur, state: d.to, stateChanged: ev.time }
    : {
        id: d.folder,
        state: d.to,
        stateChanged: ev.time,
        needFiles: 0,
        needBytes: 0,
        localFiles: 0,
        localBytes: 0,
        globalFiles: 0,
        globalBytes: 0,
        completion: 0,
        errors: 0,
        sequence: 0,
        lastSeqChanged: ev.time,
        paused: false,
      };
  return { ...s, folders: { ...s.folders, [d.folder]: next } };
}

function applyDeviceConnected(s: Snapshot, ev: SyncEventEnvelope): Snapshot {
  const d = ev.data as { id?: string; addr?: string };
  if (!d?.id) return s;
  const cur = s.peers[d.id];
  const next: PeerState = {
    deviceID: d.id,
    connected: true,
    paused: cur?.paused ?? false,
    address: d.addr ?? cur?.address ?? "",
    at: ev.time,
    inBytesTotal: cur?.inBytesTotal ?? 0,
    outBytesTotal: cur?.outBytesTotal ?? 0,
  };
  return { ...s, peers: { ...s.peers, [d.id]: next } };
}

function applyDeviceDisconnected(s: Snapshot, ev: SyncEventEnvelope): Snapshot {
  const d = ev.data as { id?: string };
  if (!d?.id) return s;
  const cur = s.peers[d.id];
  const next: PeerState = {
    deviceID: d.id,
    connected: false,
    paused: cur?.paused ?? false,
    address: cur?.address ?? "",
    at: ev.time,
    inBytesTotal: cur?.inBytesTotal ?? 0,
    outBytesTotal: cur?.outBytesTotal ?? 0,
  };
  return { ...s, peers: { ...s.peers, [d.id]: next } };
}

function applyDownloadProgress(
  s: Snapshot,
  ev: SyncEventEnvelope,
  samples: Record<string, Record<string, RateSample[]>>,
): Snapshot {
  const d = ev.data as Record<string, Record<string, PullerProgress>> | null;
  if (!d) return s;
  const now = Date.now();

  const nextTransfers: Record<string, Record<string, PullerProgress>> = {};
  const nextRates: Record<string, Record<string, TransferRate>> = {};
  const seenFolders = new Set(Object.keys(d));

  // Drop sample buffers for folders no longer in the event payload.
  for (const folderID of Object.keys(samples)) {
    if (!seenFolders.has(folderID)) delete samples[folderID];
  }

  for (const [folderID, files] of Object.entries(d)) {
    // Normalize keys to POSIX-style forward slashes. The daemon's
    // DownloadProgress event uses the runtime path separator (so
    // Windows daemons emit "Dusan\\file.vmem1"), while everywhere
    // else the UI looks files up by their /rest/db/browse path
    // ("Dusan/file.vmem1"). Without normalization the file-row
    // `transfers.progress[path]` lookup misses every active
    // transfer on Windows and the row stays stuck on "Synced".
    const normalized: Record<string, PullerProgress> = {};
    for (const [name, p] of Object.entries(files)) {
      normalized[name.replace(/\\/g, "/")] = p;
    }
    nextTransfers[folderID] = normalized;
    const folderSamples =
      samples[folderID] ?? (samples[folderID] = {});
    // Drop sample buffers for files no longer transferring.
    for (const fname of Object.keys(folderSamples)) {
      if (!(fname in normalized)) delete folderSamples[fname];
    }
    const folderRates: Record<string, TransferRate> = {};
    for (const [name, p] of Object.entries(normalized)) {
      const arr = folderSamples[name] ?? (folderSamples[name] = []);
      arr.push({ t: now, bytesDone: p.bytesDone });
      if (arr.length > RATE_WINDOW_SAMPLES) arr.shift();
      const oldest = arr[0];
      const newest = arr[arr.length - 1];
      const dt = (newest.t - oldest.t) / 1000;
      const dBytes = newest.bytesDone - oldest.bytesDone;
      const bytesPerSec = dt > 0 ? Math.max(0, dBytes / dt) : 0;
      const remaining = Math.max(0, p.bytesTotal - p.bytesDone);
      const etaSeconds = bytesPerSec > 0 ? remaining / bytesPerSec : Infinity;
      folderRates[name] = { bytesPerSec, etaSeconds };
    }
    nextRates[folderID] = folderRates;
  }

  return { ...s, transfers: nextTransfers, rates: nextRates };
}

function applyItemFinished(s: Snapshot, ev: SyncEventEnvelope): Snapshot {
  const d = ev.data as {
    folder?: string;
    item?: string;
    action?: string;
    type?: string;
    error?: string | null;
  };
  if (!d?.folder || !d.item) return s;
  const item: ActivityItem = {
    folderID: d.folder,
    name: d.item,
    time: ev.time,
    action: d.action ?? "update",
    type: d.type ?? "file",
    error: d.error ?? null,
  };
  const activity = [item, ...s.activity].slice(0, MAX_ACTIVITY);
  return { ...s, activity };
}

// applyLocalChangeDetected: surfaces user-initiated file adds, edits,
// and deletes in the activity feed. ItemFinished only fires for the
// puller pipeline (i.e. pulls from remote peers), so without this case
// a user dropping a clip into the project folder never showed up in
// Today's activity. The daemon serializes the path with the native
// separator, so normalize to forward slashes to match how the rest of
// the UI keys files.
function applyLocalChangeDetected(
  s: Snapshot,
  ev: SyncEventEnvelope,
): Snapshot {
  const d = ev.data as {
    folder?: string;
    folderID?: string;
    path?: string;
    action?: string;
    type?: string;
  };
  const folder = d?.folder ?? d?.folderID;
  if (!folder || !d.path) return s;
  const item: ActivityItem = {
    folderID: folder,
    name: d.path.replace(/\\/g, "/"),
    time: ev.time,
    action: d.action ?? "modified",
    type: d.type ?? "file",
    error: null,
  };
  const activity = [item, ...s.activity].slice(0, MAX_ACTIVITY);
  return { ...s, activity };
}

function shallowFolderEqual(a: FolderState, b: FolderState): boolean {
  return (
    a.state === b.state &&
    a.stateChanged === b.stateChanged &&
    a.needFiles === b.needFiles &&
    a.needBytes === b.needBytes &&
    a.localFiles === b.localFiles &&
    a.localBytes === b.localBytes &&
    a.globalFiles === b.globalFiles &&
    a.globalBytes === b.globalBytes &&
    a.completion === b.completion &&
    a.errors === b.errors &&
    a.sequence === b.sequence &&
    a.lastSeqChanged === b.lastSeqChanged &&
    a.paused === b.paused &&
    a.error === b.error &&
    a.watchError === b.watchError &&
    a.receiveOnlyChangedFiles === b.receiveOnlyChangedFiles &&
    a.receiveOnlyChangedBytes === b.receiveOnlyChangedBytes &&
    a.receiveOnlyChangedDeletes === b.receiveOnlyChangedDeletes
  );
}

export const realtimeStore = new RealtimeStore();
