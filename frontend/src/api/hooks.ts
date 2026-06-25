// React-Query hooks wrapping the SyncthingClient. Each hook auto-refetches
// on a schedule appropriate to its data — folder/device lists rarely
// change so 5s is fine; per-folder sync stats may move every second.

import { useEffect, useRef } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  Configuration,
  DeviceConfiguration,
  FolderConfiguration,
} from "./types";
import { client } from "./client";

const REFETCH_FAST = 1000;
const REFETCH_NORMAL = 5000;

export const queryKeys = {
  ping: ["ping"] as const,
  systemStatus: ["system", "status"] as const,
  systemVersion: ["system", "version"] as const,
  config: ["config"] as const,
  configOptions: ["config", "options"] as const,
  connections: ["connections"] as const,
  pendingFolders: ["pending", "folders"] as const,
  pendingDevices: ["pending", "devices"] as const,
  folderStatus: (id: string) => ["folder", id, "status"] as const,
  folderNeed: (id: string) => ["folder", id, "need"] as const,
  folderBrowse: (id: string) => ["folder", id, "browse"] as const,
  folderErrors: (id: string) => ["folder", id, "errors"] as const,
  folderIgnores: (id: string) => ["folder", id, "ignores"] as const,
  folderVersions: (id: string) => ["folder", id, "versions"] as const,
  completion: (folderID: string, deviceID: string) =>
    ["completion", folderID, deviceID] as const,
};

export function usePing() {
  return useQuery({
    queryKey: queryKeys.ping,
    queryFn: () => client.ping(),
    refetchInterval: REFETCH_NORMAL,
    retry: false,
  });
}

export function useSystemStatus() {
  return useQuery({
    queryKey: queryKeys.systemStatus,
    queryFn: () => client.systemStatus(),
    refetchInterval: REFETCH_NORMAL,
  });
}

export function useSystemVersion() {
  return useQuery({
    queryKey: queryKeys.systemVersion,
    queryFn: () => client.systemVersion(),
    staleTime: Infinity, // version doesn't change without a restart
  });
}

export function useConfig() {
  return useQuery<Configuration>({
    queryKey: queryKeys.config,
    queryFn: () => client.config(),
    refetchInterval: REFETCH_NORMAL,
  });
}

export function useConfigOptions() {
  return useQuery({
    queryKey: queryKeys.configOptions,
    queryFn: () => client.configOptions(),
    refetchInterval: REFETCH_NORMAL,
  });
}

export function usePatchConfigOptions() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (patch: Record<string, unknown>) =>
      client.patchConfigOptions(patch),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.configOptions });
      qc.invalidateQueries({ queryKey: queryKeys.config });
    },
  });
}

export function useConnections() {
  return useQuery({
    queryKey: queryKeys.connections,
    queryFn: () => client.connections(),
    refetchInterval: REFETCH_NORMAL,
  });
}

// usePauseAll / useResumeAll: system-wide pause via /rest/system/pause
// with no device argument. Pauses every peer connection at once.
// Used by the Transfers page top-bar button.
export function usePauseAll() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => client.pause(),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.connections });
      qc.invalidateQueries({ queryKey: queryKeys.config });
    },
  });
}

export function useResumeAll() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => client.resume(),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.connections });
      qc.invalidateQueries({ queryKey: queryKeys.config });
    },
  });
}

export function usePendingFolders() {
  return useQuery({
    queryKey: queryKeys.pendingFolders,
    queryFn: () => client.pendingFolders(),
    refetchInterval: REFETCH_NORMAL,
  });
}

export function usePendingDevices() {
  return useQuery({
    queryKey: queryKeys.pendingDevices,
    queryFn: () => client.pendingDevices(),
    refetchInterval: REFETCH_NORMAL,
  });
}

export function useFolderStatus(folderID: string | null) {
  return useQuery({
    queryKey: queryKeys.folderStatus(folderID ?? ""),
    queryFn: () => client.folderStatus(folderID!),
    enabled: !!folderID,
    refetchInterval: REFETCH_FAST,
  });
}

export function useCompletion(folderID: string | null, deviceID = "") {
  return useQuery({
    queryKey: queryKeys.completion(folderID ?? "", deviceID),
    queryFn: () => client.completion(folderID!, deviceID),
    enabled: !!folderID,
    refetchInterval: REFETCH_FAST,
  });
}

// `/db/need` and `/db/browse` are the two heaviest responses the
// daemon serves — for a project with thousands of files the JSON is
// multiple megabytes. WebView2 has to buffer each response in full
// before JSON.parse, so polling them at REFETCH_FAST (1 Hz) was both
// pumping a lot of bytes through the proxy AND keeping a fat payload
// hot in renderer memory at all times. Two changes:
//
//   * `refetchInterval` is now a slow safety net (15 s for need,
//     5 min for browse). The realtime event stream invalidates these
//     keys as soon as the daemon actually changes index state — see
//     realtime/RealtimeProvider.tsx for the wiring. So in practice the
//     safety net is the ceiling on staleness, not the source of fresh
//     data.
//   * `staleTime` is set to a chunk of the interval so remount /
//     navigation doesn't refetch a payload we just got.
const REFETCH_NEED = 15_000;
const REFETCH_BROWSE = 5 * 60_000;

// The FileGrid renders the need list as the "remote side" view during
// an active sync — it needs every queued/in-flight file, not a page of
// them. The client default (perpage=20) truncated the list to the first
// 20 entries, so a project syncing hundreds of files showed only a
// handful as queued/downloading. Request the daemon's full-list cap
// (matches getPagingParams' 1<<16 default when perpage is omitted).
const NEED_PER_PAGE = 1 << 16;

export function useFolderNeed(folderID: string | null) {
  return useQuery({
    queryKey: queryKeys.folderNeed(folderID ?? ""),
    queryFn: () => client.folderNeed(folderID!, 1, NEED_PER_PAGE),
    enabled: !!folderID,
    refetchInterval: REFETCH_NEED,
    staleTime: REFETCH_NEED,
  });
}

export function useFolderBrowse(
  folderID: string | null,
  opts: { local?: boolean } = {},
) {
  // Cache the local and global variants under distinct keys so
  // ConflictsBanner (global) and FileGrid (local) don't fight over
  // one slot. Both still share the LocalChangeDetected /
  // LocalIndexUpdated invalidation in RealtimeProvider — that
  // invalidates by the queryKeys.folderBrowse(id) PREFIX, so both
  // variants get kicked together.
  return useQuery({
    queryKey: [...queryKeys.folderBrowse(folderID ?? ""), opts.local ? "local" : "global"],
    queryFn: () => client.dbBrowse(folderID!, "", -1, { local: opts.local }),
    enabled: !!folderID,
    refetchInterval: REFETCH_BROWSE,
    staleTime: REFETCH_BROWSE,
  });
}

export function useFolderErrors(folderID: string | null) {
  return useQuery({
    queryKey: queryKeys.folderErrors(folderID ?? ""),
    queryFn: () => client.folderErrors(folderID!),
    enabled: !!folderID,
    refetchInterval: REFETCH_NORMAL,
  });
}

export function useBringToFront() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: { folderID: string; file: string }) =>
      client.bringToFront(args.folderID, args.file),
    onSuccess: (_, vars) => {
      qc.invalidateQueries({ queryKey: queryKeys.folderNeed(vars.folderID) });
    },
  });
}

// useRevertFolder discards locally-modified files in a receive-only
// folder and refetches the master copy. The daemon does the work
// asynchronously; we invalidate status/need/errors so the UI reflects
// the dropping receiveOnlyChangedFiles count as soon as the daemon
// publishes a new FolderSummary.
export function useRevertFolder() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: { folderID: string }) =>
      client.revertFolder(args.folderID),
    onSuccess: (_, vars) => {
      qc.invalidateQueries({ queryKey: queryKeys.folderStatus(vars.folderID) });
      qc.invalidateQueries({ queryKey: queryKeys.folderNeed(vars.folderID) });
      qc.invalidateQueries({ queryKey: queryKeys.folderErrors(vars.folderID) });
    },
  });
}

// useResyncFolder re-creates the project folder root + marker and
// triggers a scan. Cures ErrPathMissing / ErrMarkerMissing once the
// underlying issue is resolved (path restored, or repointed via
// patchFolder beforehand). Returns the folderStatus refetch promise
// from onSuccess so mutateAsync awaits a fresh status read — the
// caller's UI (e.g. the Resync button) then re-renders with the
// cleared error in the same tick instead of flashing the stale one.
export function useResyncFolder() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: { folderID: string }) =>
      client.resyncFolder(args.folderID),
    onSuccess: (_, vars) => {
      // Browse / need / errors can refresh in the background — the
      // UI gate for the Resync button is folder status, so block on
      // that one only.
      qc.invalidateQueries({ queryKey: queryKeys.folderBrowse(vars.folderID) });
      qc.invalidateQueries({ queryKey: queryKeys.folderNeed(vars.folderID) });
      qc.invalidateQueries({ queryKey: queryKeys.folderErrors(vars.folderID) });
      return qc.refetchQueries({
        queryKey: queryKeys.folderStatus(vars.folderID),
      });
    },
  });
}

export function useFolderIgnores(folderID: string | null) {
  return useQuery({
    queryKey: queryKeys.folderIgnores(folderID ?? ""),
    queryFn: () => client.getIgnores(folderID!),
    enabled: !!folderID,
    // Ignores rarely change; lean on the cache and let mutations
    // invalidate explicitly.
    staleTime: 30_000,
  });
}

export function useSetFolderIgnores() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: { folderID: string; lines: string[] }) =>
      client.setIgnores(args.folderID, args.lines),
    onSuccess: (_, vars) => {
      qc.invalidateQueries({ queryKey: queryKeys.folderIgnores(vars.folderID) });
    },
  });
}

export function useFolderVersions(folderID: string | null) {
  return useQuery({
    queryKey: queryKeys.folderVersions(folderID ?? ""),
    queryFn: () => client.folderVersions(folderID!),
    enabled: !!folderID,
    staleTime: REFETCH_NORMAL,
  });
}

export function useRestoreFolderVersions() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: {
      folderID: string;
      versions: Record<string, string>;
    }) => client.restoreFolderVersions(args.folderID, args.versions),
    onSuccess: (_, vars) => {
      qc.invalidateQueries({ queryKey: queryKeys.folderVersions(vars.folderID) });
      qc.invalidateQueries({ queryKey: queryKeys.folderStatus(vars.folderID) });
    },
  });
}

// --- mutations

function invalidateConfig(qc: ReturnType<typeof useQueryClient>) {
  // Return the config-refetch promise so callers that use mutateAsync
  // (notably the Edit project modal) can await fresh data before
  // closing — otherwise re-opening the modal seeds from the stale
  // cache and the user sees their just-saved values "reverted".
  // The pending lists are best-effort and don't need to block.
  qc.invalidateQueries({ queryKey: queryKeys.pendingFolders });
  qc.invalidateQueries({ queryKey: queryKeys.pendingDevices });
  return qc.invalidateQueries({ queryKey: queryKeys.config });
}

export function useAddFolder() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (f: FolderConfiguration) => client.addFolder(f),
    onSuccess: () => invalidateConfig(qc),
  });
}

export function usePutFolder() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (f: FolderConfiguration) => client.putFolder(f),
    onSuccess: () => invalidateConfig(qc),
  });
}

// useFsWatcherDelayMigration patches any folder whose stored
// fsWatcherDelayS is still the legacy 10s default down to 1s so the
// file list reflects local edits within ~1 second instead of ~10.
// Daemon defaults already ship this on newly created folders; this
// hook handles folders configured before the change. Runs once per
// app session and only touches folders that need it.
const FS_WATCHER_TARGET_DELAY_S = 1;
export function useFsWatcherDelayMigration() {
  const qc = useQueryClient();
  const cfg = useConfig();
  const ran = useRef(false);
  useEffect(() => {
    if (ran.current) return;
    const folders = cfg.data?.folders;
    if (!folders || folders.length === 0) return;
    const targets = folders.filter(
      (f) =>
        f.fsWatcherEnabled !== false &&
        typeof f.fsWatcherDelayS === "number" &&
        f.fsWatcherDelayS > FS_WATCHER_TARGET_DELAY_S,
    );
    if (targets.length === 0) {
      ran.current = true;
      return;
    }
    ran.current = true;
    (async () => {
      for (const f of targets) {
        try {
          await client.patchFolder(f.id, {
            fsWatcherDelayS: FS_WATCHER_TARGET_DELAY_S,
          });
        } catch {
          // Best-effort; if one folder rejects (e.g. the daemon
          // clamps the value), don't block the rest.
        }
      }
      qc.invalidateQueries({ queryKey: queryKeys.config });
    })();
  }, [cfg.data, qc]);
}

export function usePatchFolder() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: { id: string; patch: Partial<FolderConfiguration> }) =>
      client.patchFolder(args.id, args.patch),
    onSuccess: () => invalidateConfig(qc),
  });
}

export function useDeleteFolder() {
  const qc = useQueryClient();
  return useMutation<void, Error, string, { prev?: Configuration }>({
    mutationFn: (id: string) => client.deleteFolder(id),
    // Optimistically drop the folder from the cached Configuration so
    // dependent reads (notably the project-quota hook) see the new
    // count immediately. Without this, the quota stays at "1 of 1
    // used" — and the +New Project CTA stays disabled — for the
    // full window between the DELETE returning 200 and useConfig's
    // next refetch landing. Users hit that window often enough that
    // they reported it as "the limit still applies after removing".
    onMutate: async (id) => {
      await qc.cancelQueries({ queryKey: queryKeys.config });
      const prev = qc.getQueryData<Configuration>(queryKeys.config);
      if (prev) {
        qc.setQueryData<Configuration>(queryKeys.config, {
          ...prev,
          folders: prev.folders.filter((f) => f.id !== id),
        });
      }
      return { prev };
    },
    onError: (_err, _id, ctx) => {
      // Roll back if the daemon rejected the delete.
      if (ctx?.prev) qc.setQueryData(queryKeys.config, ctx.prev);
    },
    onSettled: () => invalidateConfig(qc),
  });
}

export function useAddDevice() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (d: DeviceConfiguration) => client.addDevice(d),
    onSuccess: () => invalidateConfig(qc),
  });
}

// Decline a folder offer permanently. Two-step:
//   1. PATCH the offering device's config with the folder ID added to
//      its ignoredFolders list, so the daemon silently drops future
//      offers for it from that peer.
//   2. DELETE the current /rest/cluster/pending/folders row so the
//      pending inbox clears right away.
//
// Without step (1), the peer's next announce cycle (seconds to minutes)
// re-creates the pending row and the offer reappears in the inbox.
export function useDismissPendingFolder() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (args: {
      folderID: string;
      deviceID: string;
      label?: string;
    }) => {
      const cfg = qc.getQueryData<Configuration>(queryKeys.config);
      const dev = cfg?.devices.find((d) => d.deviceID === args.deviceID);
      if (dev) {
        const existing = dev.ignoredFolders ?? [];
        const already = existing.some((f) => f.id === args.folderID);
        if (!already) {
          await client.patchDevice(args.deviceID, {
            ignoredFolders: [
              ...existing,
              {
                id: args.folderID,
                label: args.label ?? args.folderID,
                time: new Date().toISOString(),
              },
            ],
          });
        }
      }
      await client.dismissPendingFolder(args.folderID, args.deviceID);
    },
    onSuccess: () => {
      invalidateConfig(qc);
      qc.invalidateQueries({ queryKey: queryKeys.pendingFolders });
    },
  });
}

export function useDismissPendingDevice() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (deviceID: string) => client.dismissPendingDevice(deviceID),
    onSuccess: () =>
      qc.invalidateQueries({ queryKey: queryKeys.pendingDevices }),
  });
}
