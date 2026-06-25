// Realtime state types. Mirrors what we get from the daemon's
// /rest/events stream and represents the live, push-driven slice of
// the world: folder state, peer connection state, in-flight transfers,
// recent activity, and pending invitations.
//
// Static config (the list of devices, folder definitions, options) is
// still owned by React Query — that data is rarely updated and the
// mutation flows benefit from React Query's invalidation. The realtime
// store complements it, not replaces it.

import type {
  PendingDevice,
  PendingFolder,
  PullerProgress,
} from "../api/types";

export interface FolderState {
  id: string;
  state: string; // idle / scanning / syncing / sync-waiting / error / etc.
  stateChanged: string; // ISO timestamp
  needFiles: number;
  needBytes: number;
  localFiles: number;
  localBytes: number;
  globalFiles: number;
  globalBytes: number;
  completion: number; // 0..100, computed from need/global bytes
  errors: number;
  sequence: number;
  // Timestamp of the last FolderSummary at which `sequence` actually
  // increased — i.e. the last time the daemon's index recorded a real
  // change (file added/modified/removed). Distinct from `stateChanged`,
  // which the daemon also bumps on periodic rescans that found nothing
  // and is therefore not a trustworthy "last edit" signal for the UI.
  lastSeqChanged?: string;
  paused: boolean;
  // Daemon-side folder error (cannot run, marker missing, path
  // disappeared, etc.) — populated from FolderSummary.error / the
  // `error` field on /db/status.
  error?: string;
  // Filesystem watcher failure (separate from sync errors).
  watchError?: string;
  // For receive-only folders: how many files the user has changed
  // locally that haven't been propagated. Needs an Override or
  // Revert from the recipient to resolve. The daemon reports
  // additions/modifications separately from deletions; both count
  // as "local changes" from the user's POV.
  receiveOnlyChangedFiles?: number;
  receiveOnlyChangedBytes?: number;
  receiveOnlyChangedDeletes?: number;
}

export interface PeerState {
  deviceID: string;
  connected: boolean;
  paused: boolean;
  address: string;
  at: string; // last state transition (connected / disconnected)
  inBytesTotal: number;
  outBytesTotal: number;
}

export interface TransferRate {
  bytesPerSec: number;
  etaSeconds: number;
}

export interface ActivityItem {
  folderID: string;
  name: string;
  time: string;
  action: string;
  type: string;
  error: string | null;
}

export interface RealtimeStatus {
  // true when the event long-poll is healthy. Drops to false during a
  // reconnect backoff or initial startup.
  connected: boolean;
  lastError: string | null;
  eventsReceived: number;
}

export interface Snapshot {
  folders: Record<string, FolderState>;
  peers: Record<string, PeerState>;
  transfers: Record<string, Record<string, PullerProgress>>; // folderID → file → progress
  rates: Record<string, Record<string, TransferRate>>; // folderID → file → derived rate
  activity: ActivityItem[]; // newest first
  pendingDevices: Record<string, PendingDevice>;
  pendingFolders: Record<string, PendingFolder>;
  status: RealtimeStatus;
}

export interface SyncEventEnvelope {
  id: number;
  globalID?: number;
  type: string;
  time: string;
  data: unknown;
}

// Re-export so consumers don't need to know that progress + pending
// types live in api/types.
export type { PullerProgress, PendingDevice, PendingFolder };
