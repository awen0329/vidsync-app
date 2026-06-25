import {
  useActivity,
  useTransfersForFolder,
} from "../realtime/hooks";
import type { PullerProgress } from "./types";

// useSyncEvents is a thin compatibility wrapper over the realtime
// store, preserving the original return shape for ActivityFeed.
// New code should use the selectors in `realtime/hooks.ts` directly.

export interface FileRate {
  bytesPerSec: number;
  etaSeconds: number;
}

export interface CompletedItem {
  name: string;
  time: string;
  action: string;
  type: string;
  error: string | null;
}

export interface SyncEventsState {
  progressByFile: Record<string, PullerProgress>;
  rateByFile: Record<string, FileRate>;
  completed: CompletedItem[];
}

export function useSyncEvents(folderID: string | null): SyncEventsState {
  const transfers = useTransfersForFolder(folderID);
  const activity = useActivity(folderID);
  return {
    progressByFile: transfers.progress,
    rateByFile: transfers.rates,
    completed: activity.map((a) => ({
      name: a.name,
      time: a.time,
      action: a.action,
      type: a.type,
      error: a.error,
    })),
  };
}
