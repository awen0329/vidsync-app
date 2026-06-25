import { useSyncExternalStore } from "react";
import { realtimeStore } from "./store";
import type {
  ActivityItem,
  FolderState,
  PeerState,
  PendingDevice,
  PendingFolder,
  PullerProgress,
  RealtimeStatus,
  TransferRate,
} from "./types";

// Selector hooks over the realtime store. Each subscribes to *the
// whole snapshot* — every event-driven change triggers a re-render.
// That's intentional and adequate at our scale (handful of folders,
// handful of peers); we'll add memoized selectors only if a real perf
// problem shows up.

function useSnapshot() {
  return useSyncExternalStore(realtimeStore.subscribe, realtimeStore.getSnapshot);
}

export function useFolderState(
  folderID: string | null | undefined,
): FolderState | undefined {
  const snap = useSnapshot();
  return folderID ? snap.folders[folderID] : undefined;
}

export function useAllFolderStates(): Record<string, FolderState> {
  return useSnapshot().folders;
}

export function usePeerState(
  deviceID: string | null | undefined,
): PeerState | undefined {
  const snap = useSnapshot();
  return deviceID ? snap.peers[deviceID] : undefined;
}

export function useAllPeerStates(): Record<string, PeerState> {
  return useSnapshot().peers;
}

export function useTransfersForFolder(folderID: string | null | undefined): {
  progress: Record<string, PullerProgress>;
  rates: Record<string, TransferRate>;
} {
  const snap = useSnapshot();
  const id = folderID ?? "";
  return {
    progress: snap.transfers[id] ?? {},
    rates: snap.rates[id] ?? {},
  };
}

// useAllTransfers: flattens the per-folder transfers + rates maps into
// a single list, sorted by remaining bytes descending so the biggest
// in-flight items show up first. Used by the global Transfers page.
export interface TransferRow {
  folderID: string;
  path: string;
  progress: PullerProgress;
  rate: TransferRate | undefined;
}

export function useAllTransfers(): TransferRow[] {
  const snap = useSnapshot();
  const out: TransferRow[] = [];
  for (const [folderID, files] of Object.entries(snap.transfers)) {
    for (const [path, progress] of Object.entries(files)) {
      out.push({
        folderID,
        path,
        progress,
        rate: snap.rates[folderID]?.[path],
      });
    }
  }
  out.sort((a, b) => {
    const remA = a.progress.bytesTotal - a.progress.bytesDone;
    const remB = b.progress.bytesTotal - b.progress.bytesDone;
    return remB - remA;
  });
  return out;
}

export function useActivity(
  folderID: string | null | undefined,
): ActivityItem[] {
  const snap = useSnapshot();
  if (!folderID) return snap.activity;
  return snap.activity.filter((a) => a.folderID === folderID);
}

export function useRealtimeStatus(): RealtimeStatus {
  return useSnapshot().status;
}

export function usePendingDevicesRT(): Record<string, PendingDevice> {
  return useSnapshot().pendingDevices;
}

export function usePendingFoldersRT(): Record<string, PendingFolder> {
  return useSnapshot().pendingFolders;
}
