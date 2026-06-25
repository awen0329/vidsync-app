import { useEffect, useRef } from "react";
import { realtimeStore } from "../realtime/store";
import { useConfig } from "./hooks";
import { humanBytes } from "../lib/format";
import { useMyInvitations } from "./cloud/hooks";

// useDesktopNotifications watches the realtime store for folders that
// transition from "files needed > 0" to 0 and fires one OS-level
// notification per batch. Replaces the prior polling implementation —
// the store already receives FolderSummary events from the daemon, so
// we subscribe instead of asking again every 3 seconds.
//
// Transport: when running inside Wails (window.go.main.App is bound),
// we route through a Go ShowNotification helper that posts a real
// Windows 10+ toast. The browser Notification API works in WebView2
// in some configurations but doesn't reliably surface OS toasts;
// the Go path always does.

interface WailsNotifierBindings {
  ShowNotification(title: string, body: string): Promise<void>;
}

function wailsNotifier(): WailsNotifierBindings | null {
  const w = window as unknown as {
    go?: { main?: { App?: WailsNotifierBindings } };
  };
  return w.go?.main?.App?.ShowNotification ? (w.go.main.App as WailsNotifierBindings) : null;
}

function fire(title: string, body: string, tag: string) {
  const native = wailsNotifier();
  if (native) {
    void native.ShowNotification(title, body);
    return;
  }
  // Browser fallback for `npm run dev` (no Wails host).
  if (typeof Notification === "undefined") return;
  if (Notification.permission !== "granted") return;
  try {
    new Notification(title, { body, tag });
  } catch {
    // Constructor can throw in restrictive contexts; nothing actionable.
  }
}

// fireSystemNotification posts an OS-level notification (Wails toast, or the
// browser Notification API in dev). Callers should gate on
// getNotificationsEnabled() first — this just dispatches.
export function fireSystemNotification(title: string, body: string, tag: string) {
  fire(title, body, tag);
}

const STORAGE_KEY = "vidsync.notifications.enabled";

export function getNotificationsEnabled(): boolean {
  if (typeof localStorage === "undefined") return false;
  return localStorage.getItem(STORAGE_KEY) === "1";
}

export function setNotificationsEnabled(on: boolean) {
  if (typeof localStorage === "undefined") return;
  if (on) localStorage.setItem(STORAGE_KEY, "1");
  else localStorage.removeItem(STORAGE_KEY);
}

export async function requestNotificationPermission(): Promise<NotificationPermission> {
  // In Wails the Go side dispatches toasts unconditionally — Windows
  // itself decides whether to display them (Focus Assist, quiet
  // hours, etc.). Treat that as "granted" so the Settings toggle
  // doesn't keep asking for browser permission that doesn't apply.
  if (wailsNotifier()) return "granted";
  if (typeof Notification === "undefined") return "denied";
  if (Notification.permission === "granted") return "granted";
  if (Notification.permission === "denied") return "denied";
  try {
    return await Notification.requestPermission();
  } catch {
    return "denied";
  }
}

// useInvitationNotifications fires one OS toast the first time a
// pending cloud invitation is seen on this device. We track the
// already-notified invite IDs in a ref so a 3-second refetch from
// useMyInvitations doesn't re-fire for the same row, and use the
// invitation id as the toast `tag` so an OS-level coalescer (e.g.
// macOS Notification Center) treats repeats as the same item even
// across app restarts.
//
// We deliberately don't notify on the *first* render — when the app
// boots with a pre-existing pending invite the user has presumably
// already seen it; firing then would feel like spam. We mark every
// invite present on the very first non-empty fetch as "already
// seen" without firing.
export function useInvitationNotifications(enabled: boolean) {
  const invites = useMyInvitations(enabled);
  const seenRef = useRef<Set<string> | null>(null);

  useEffect(() => {
    if (!enabled) return;
    if (!getNotificationsEnabled()) {
      // Notifications toggle is off — still seed the seen-set so
      // turning them on later doesn't backfill a flood.
      if (invites.data && seenRef.current === null) {
        seenRef.current = new Set(invites.data.invitations.map((i) => i.id));
      }
      return;
    }
    const data = invites.data;
    if (!data) return;

    // First non-empty fetch: snapshot existing IDs, fire nothing.
    if (seenRef.current === null) {
      seenRef.current = new Set(data.invitations.map((i) => i.id));
      return;
    }

    for (const inv of data.invitations) {
      if (inv.status !== "pending") continue;
      if (seenRef.current.has(inv.id)) continue;
      seenRef.current.add(inv.id);

      const fromLabel =
        inv.ownerName?.trim() || inv.ownerEmail?.trim() || "Someone";
      const folder = inv.folderLabel?.trim() || inv.folderId;
      fire(
        "New project invitation",
        `${fromLabel} invited you to "${folder}".`,
        `vidsync-invite-${inv.id}`,
      );
    }
  }, [enabled, invites.data]);
}

export function useDesktopNotifications() {
  const cfg = useConfig();
  // Last observed need-files count per folder. Held in a ref so an
  // unrelated re-render can't restart the comparison.
  const lastNeedRef = useRef<Record<string, number>>({});

  useEffect(() => {
    const folderLabel = (id: string): string => {
      const f = cfg.data?.folders.find((x) => x.id === id);
      return f?.label || id;
    };

    const unsub = realtimeStore.subscribe(() => {
      // Skip work entirely when notifications are off; the per-fire
      // function still gates on Wails-vs-browser availability.
      if (!getNotificationsEnabled()) return;
      const snap = realtimeStore.getSnapshot();
      const next: Record<string, number> = {};
      for (const [id, fs] of Object.entries(snap.folders)) {
        const prev = lastNeedRef.current[id];
        const curNeed = fs.needFiles;
        next[id] = curNeed;
        if (prev !== undefined && prev > 0 && curNeed === 0 && !fs.paused) {
          fire(
            `Sync complete · ${folderLabel(id)}`,
            `${prev} file${prev > 1 ? "s" : ""} synced (${humanBytes(fs.localBytes)}).`,
            `vidsync-${id}`,
          );
        }
      }
      lastNeedRef.current = next;
    });
    return unsub;
  }, [cfg.data]);
}
