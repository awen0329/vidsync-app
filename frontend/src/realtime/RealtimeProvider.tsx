import { useEffect, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { client } from "../api/client";
import { queryKeys } from "../api/hooks";
import { realtimeStore } from "./store";
import type { SyncEventEnvelope } from "./types";

// RealtimeProvider runs ONE long-poll against /rest/events for the
// whole app. It dispatches into realtimeStore (which fans out to the
// selector hooks) and triggers React Query invalidations for the
// slower-moving data (config, pending lists).
//
// Why one long-poll, not many: each selected project used to mount its
// own subscription. Switching projects cancelled + reopened them; long
// transfers spawned multiple parallel subscriptions over a session.
// Everything now reads from a single pipe.

const EVENT_FILTER = [
  "FolderSummary",
  "StateChanged",
  "FolderCompletion",
  "DeviceConnected",
  "DeviceDisconnected",
  "DownloadProgress",
  "ItemFinished",
  "LocalChangeDetected",
  "LocalIndexUpdated",
  "RemoteIndexUpdated",
  "PendingDevicesChanged",
  "PendingFoldersChanged",
  "ConfigSaved",
];

// During initial sync `ItemFinished` can fire many times per second.
// We coalesce browse/need invalidations behind this debounce so we
// refetch the (potentially multi-MB) responses at most twice per
// second per folder, instead of once per file.
const INDEX_INVALIDATE_DEBOUNCE_MS = 500;

const BACKOFF_BASE_MS = 2_000;
const BACKOFF_MAX_MS = 30_000;

export function RealtimeProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient();

  useEffect(() => {
    const ctl = new AbortController();
    let stopped = false;
    let sinceID = 0;
    let backoff = BACKOFF_BASE_MS;

    // Per-folder debounce so a burst of ItemFinished events triggers
    // at most one refetch per folder per debounce window.
    const indexTimers = new Map<string, ReturnType<typeof setTimeout>>();
    const scheduleIndexInvalidate = (folderID: string) => {
      if (!folderID) return;
      const existing = indexTimers.get(folderID);
      if (existing) clearTimeout(existing);
      indexTimers.set(
        folderID,
        setTimeout(() => {
          indexTimers.delete(folderID);
          qc.invalidateQueries({ queryKey: queryKeys.folderBrowse(folderID) });
          qc.invalidateQueries({ queryKey: queryKeys.folderNeed(folderID) });
        }, INDEX_INVALIDATE_DEBOUNCE_MS),
      );
    };

    async function pumpPendingLists() {
      try {
        const [devs, folders] = await Promise.all([
          client.pendingDevices(),
          client.pendingFolders(),
        ]);
        realtimeStore.setPendingDevices(devs);
        realtimeStore.setPendingFolders(folders);
      } catch {
        // Falls back to React Query polling; non-fatal.
      }
    }

    // pumpFolderStates seeds the realtime store from /rest/db/status
    // for every configured folder. The daemon only emits FolderSummary
    // when something changes, so on a settled project nothing arrives
    // through the long-poll — without this seed the Projects cards
    // and the in-hero stats render 0 files / 0 B until the user
    // touches the data.
    async function pumpFolderStates() {
      try {
        const cfg = await client.config();
        await Promise.all(
          cfg.folders.map(async (f) => {
            try {
              const s = await client.folderStatus(f.id);
              realtimeStore.seedFolder(f.id, s);
            } catch {
              /* per-folder failure is fine */
            }
          }),
        );
      } catch {
        /* no config yet; events will fill in later */
      }
    }

    async function loop() {
      // Seed pending lists + folder states once on mount — the
      // Changed/Summary events tell us when to refresh, but we need
      // the initial state.
      pumpPendingLists();
      pumpFolderStates();

      while (!stopped) {
        try {
          const events = (await client.events(
            sinceID,
            ctl.signal,
            EVENT_FILTER,
          )) as unknown as SyncEventEnvelope[];
          if (stopped) break;
          realtimeStore.setConnected(true, null);
          backoff = BACKOFF_BASE_MS;

          if (events.length > 0) {
            realtimeStore.applyEvents(events);
            sinceID = events[events.length - 1].id;

            // Side-effects driven off specific event types.
            for (const ev of events) {
              if (ev.type === "ConfigSaved") {
                qc.invalidateQueries({ queryKey: queryKeys.config });
              } else if (ev.type === "PendingDevicesChanged") {
                pumpPendingLists();
                qc.invalidateQueries({
                  queryKey: queryKeys.pendingDevices,
                });
              } else if (ev.type === "PendingFoldersChanged") {
                pumpPendingLists();
                qc.invalidateQueries({
                  queryKey: queryKeys.pendingFolders,
                });
              } else if (
                ev.type === "LocalIndexUpdated" ||
                ev.type === "RemoteIndexUpdated" ||
                ev.type === "ItemFinished" ||
                ev.type === "LocalChangeDetected"
              ) {
                // Daemon's index (or fs watcher) flagged a change: kick
                // the browse + need queries to refetch. Debounced per
                // folder so a burst of finished items doesn't pull the
                // multi-MB browse response on every line. Including
                // LocalChangeDetected here means a user dropping or
                // deleting a file in the project folder sees the Files
                // list refresh as soon as the watcher fires, instead of
                // having to wait for the rescan to publish a
                // LocalIndexUpdated.
                const folder =
                  (ev.data as { folder?: string } | null)?.folder ?? "";
                scheduleIndexInvalidate(folder);
              }
            }
          }
        } catch (e) {
          if (stopped || ctl.signal.aborted) break;
          const msg = e instanceof Error ? e.message : String(e);
          realtimeStore.setConnected(false, msg);
          await new Promise((r) => setTimeout(r, backoff));
          backoff = Math.min(BACKOFF_MAX_MS, backoff * 2);
        }
      }
    }

    loop();
    return () => {
      stopped = true;
      ctl.abort();
      for (const t of indexTimers.values()) clearTimeout(t);
      indexTimers.clear();
    };
  }, [qc]);

  return <>{children}</>;
}
