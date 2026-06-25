// TypeScript shapes for the sync daemon REST API responses we consume.
// Mirrors internal/gui/client/types.go on the Go side; keep them in
// sync. Only fields the UI actually reads are typed — anything else is
// a `Record<string, unknown>` to avoid bloat.

export interface SystemStatus {
  myID: string;
  goroutines: number;
  alloc: number;
  sys: number;
  uptime: number;
  startTime: string;
  tilde: string;
}

export interface SystemVersion {
  arch: string;
  codename: string;
  date: string;
  isBeta: boolean;
  isCandidate: boolean;
  isRelease: boolean;
  longVersion: string;
  os: string;
  tags: string[];
  user: string;
  version: string;
}

export interface FolderStatus {
  state: string;
  stateChanged: string;
  globalBytes: number;
  globalFiles: number;
  localBytes: number;
  localFiles: number;
  needBytes: number;
  needFiles: number;
  sequence: number;
  // Per-file pull-failure count (permission denied, disk full, etc.)
  // — distinct from `error` below.
  errors: number;
  // Folder-level state error from model.State(): set when the folder
  // is in `error` state because the daemon can't run it at all (path
  // missing, marker file gone, permission denied on the root).
  error?: string;
  // Filesystem watcher failure (e.g. running out of inotify handles).
  // The folder still syncs via polling, but realtime change detection
  // is degraded — worth surfacing so the user can do something about
  // it before it bites them.
  watchError?: string;
  // For receive-only folders: count and total bytes of files the user
  // changed locally. These conflict with the master copy and require
  // an explicit Override or Revert from the recipient. Deletes are
  // tracked separately by the daemon — both contribute to "local
  // changes" from the user's POV.
  receiveOnlyChangedFiles?: number;
  receiveOnlyChangedBytes?: number;
  receiveOnlyChangedDeletes?: number;
}

export interface Completion {
  completion: number;
  globalBytes: number;
  needBytes: number;
  needDeletes: number;
  needItems: number;
}

export interface ConnectionInfo {
  address: string;
  at: string;
  clientVersion: string;
  connected: boolean;
  inBytesTotal: number;
  outBytesTotal: number;
  paused: boolean;
  type: string;
  startedAt?: string;
}

export interface Connections {
  connections: Record<string, ConnectionInfo>;
  total: ConnectionInfo;
}

export interface PeerRate {
  inBytesPerSec: number;
  outBytesPerSec: number;
}

export interface ObservedFolder {
  id: string;
  label: string;
  // RFC3339 timestamp — the daemon stamps this on insert; we send
  // our current clock for new entries.
  time: string;
}

export interface DeviceConfiguration {
  deviceID: string;
  name: string;
  addresses: string[];
  compression: string;
  introducer: boolean;
  paused: boolean;
  // Folder IDs the daemon should silently drop when this device offers
  // them. Populated when the user clicks Decline on a folder offer —
  // without this, the peer re-announces on its next cycle and the
  // offer reappears in the inbox.
  ignoredFolders?: ObservedFolder[];
}

export interface FolderDeviceConfiguration {
  deviceID: string;
  introducedBy?: string;
  encryptionPassword?: string;
}

export interface FolderConfiguration {
  id: string;
  label: string;
  filesystemType: string;
  path: string;
  type: string;
  devices: FolderDeviceConfiguration[];
  rescanIntervalS: number;
  fsWatcherEnabled: boolean;
  paused: boolean;
  versioning?: { type: string; params?: Record<string, string> };
  // …many more fields the legacy web UI exposes; we don't decode them
  // because we don't render them. They round-trip via the daemon's
  // PATCH endpoints when we touch the typed fields.
  [key: string]: unknown;
}

export interface Configuration {
  version: number;
  folders: FolderConfiguration[];
  devices: DeviceConfiguration[];
  options?: Record<string, unknown>;
  gui?: Record<string, unknown>;
  defaults?: Record<string, unknown>;
}

export interface PendingDevice {
  time: string;
  name: string;
  addresses: string[];
}

export interface PendingFolderOffer {
  time: string;
  label: string;
  receiveEncrypted: boolean;
  remoteEncrypted: boolean;
}

export interface PendingFolder {
  offeredBy: Record<string, PendingFolderOffer>;
}

export interface FileInfo {
  name: string;
  size: number;
  // Protobuf enum name from FileType().String(), e.g.
  // "FILE_INFO_TYPE_FILE" | "FILE_INFO_TYPE_DIRECTORY" |
  // "FILE_INFO_TYPE_SYMLINK" — NOT the bare "FILE"/"DIRECTORY" the
  // older REST shape emitted. Matches /rest/db/browse's vocabulary.
  type: string;
  deleted: boolean;
  modified: string;
  [key: string]: unknown;
}

// Live download progress for a single file, emitted by the daemon's
// DownloadProgress event. Mirrors lib/model.PullerProgress.
export interface PullerProgress {
  total: number;
  reused: number;
  copiedFromOrigin: number;
  copiedFromOriginShifted: number;
  copiedFromElsewhere: number;
  pulled: number;
  pulling: number;
  bytesDone: number;
  bytesTotal: number;
}

export interface FolderNeed {
  progress: FileInfo[];
  queued: FileInfo[];
  rest: FileInfo[];
  page: number;
  perpage: number;
}

export interface SyncEvent {
  id: number;
  globalID: number;
  type: string;
  time: string;
  data: unknown;
}

export interface LogMessage {
  when: string;
  level: string;
  message: string;
}

export interface LogResponse {
  messages: LogMessage[];
}
