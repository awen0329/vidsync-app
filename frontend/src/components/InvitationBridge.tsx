import { useEffect, useRef } from "react";
import { AUTH_ENABLED } from "../App";
import { useAcceptedSince, useLeftSince } from "../api/cloud/hooks";
import { useConfig } from "../api/hooks";
import { client } from "../api/client";
import type { CloudInvitation } from "../api/cloud/client";
import type { FolderConfiguration } from "../api/types";

// InvitationBridge connects the cloud control-plane invitation flow to
// the local sync daemon. When a recipient accepts an invite, the
// cloud records (recipientDeviceId, folderId) — but no peering happens
// until the owner's daemon actually adds that device to the folder.
// This component runs in the owner's app, polls the cloud for newly
// accepted invites, and applies the matching share-this-folder PUT
// against localhost.
//
// Invisible — renders null. Exists for its side effects.
//
// Cursor strategy: we keep a "last seen acceptedAt" timestamp in
// localStorage so we don't re-process the same accept across reloads.
// On each successful apply we advance the cursor past the latest
// acceptedAt we saw. If a row fails (e.g. daemon offline) we leave the
// cursor unchanged so the next tick retries.

const CURSOR_KEY = "vidsync.invitations.acceptedSince";
const LEFT_CURSOR_KEY = "vidsync.invitations.leftSince";

export function InvitationBridge() {
  if (!AUTH_ENABLED) return null;
  return <Bridge />;
}

function Bridge() {
  const cfg = useConfig();
  // Two independent cursors: accepted events advance one, left events
  // advance the other. They're orthogonal — a single row can pass
  // through both states over its lifetime (accept → later leave).
  const cursorRef = useRef<string | null>(readCursor(CURSOR_KEY));
  const leftCursorRef = useRef<string | null>(readCursor(LEFT_CURSOR_KEY));
  const accepted = useAcceptedSince(cursorRef.current);
  const left = useLeftSince(leftCursorRef.current);
  const inFlight = useRef<Set<string>>(new Set());
  const leftInFlight = useRef<Set<string>>(new Set());

  useEffect(() => {
    const rows = accepted.data?.invitations ?? [];
    if (rows.length === 0 || !cfg.data) return;
    void applyAccepts(rows, cfg.data.folders, cursorRef, inFlight);
  }, [accepted.data, cfg.data]);

  useEffect(() => {
    const rows = left.data?.invitations ?? [];
    if (rows.length === 0 || !cfg.data) return;
    void applyLefts(rows, cfg.data.folders, leftCursorRef, leftInFlight);
  }, [left.data, cfg.data]);

  return null;
}

async function applyAccepts(
  rows: CloudInvitation[],
  folders: FolderConfiguration[],
  cursorRef: React.MutableRefObject<string | null>,
  inFlight: React.MutableRefObject<Set<string>>,
) {
  // Process oldest first so a failure in the middle still advances the
  // cursor past the rows we did succeed on.
  const sorted = [...rows].sort((a, b) =>
    (a.acceptedAt ?? a.updatedAt).localeCompare(b.acceptedAt ?? b.updatedAt),
  );

  let highWater = cursorRef.current;

  for (const inv of sorted) {
    if (!inv.recipientDeviceId || inv.status !== "accepted") continue;
    if (inFlight.current.has(inv.id)) continue;
    const folder = folders.find((f) => f.id === inv.folderId);
    if (!folder) {
      // Owner deleted the folder after sending — nothing to do, but
      // still advance past this row.
      highWater = advance(highWater, inv);
      continue;
    }
    if (folder.devices.some((d) => d.deviceID === inv.recipientDeviceId)) {
      // Already shared (maybe added manually or by a previous run on
      // another window). Advance the cursor and move on.
      highWater = advance(highWater, inv);
      continue;
    }

    inFlight.current.add(inv.id);
    try {
      await ensureDeviceKnown(inv.recipientDeviceId);
      const updated: FolderConfiguration = {
        ...folder,
        devices: [...folder.devices, { deviceID: inv.recipientDeviceId }],
      };
      await client.putFolder(updated);
      highWater = advance(highWater, inv);
    } catch (e) {
      // Leave cursor unchanged; next poll retries this row.
      console.warn("InvitationBridge: failed to share folder", inv.id, e);
      break;
    } finally {
      inFlight.current.delete(inv.id);
    }
  }

  if (highWater && highWater !== cursorRef.current) {
    cursorRef.current = highWater;
    try {
      localStorage.setItem(CURSOR_KEY, highWater);
    } catch {
      // Quota/private-mode — non-fatal, we just re-process on reload.
    }
  }
}

// applyLefts handles the inverse of applyAccepts: when a recipient
// leaves a project, drop their deviceID from folder.devices on the
// owner's local daemon so the Team panel reflects the change.
async function applyLefts(
  rows: CloudInvitation[],
  folders: FolderConfiguration[],
  cursorRef: React.MutableRefObject<string | null>,
  inFlight: React.MutableRefObject<Set<string>>,
) {
  // Server sorts by updated_at ASC; we use updated_at as the cursor
  // because left rows don't have a dedicated leave_at column.
  const sorted = [...rows].sort((a, b) =>
    a.updatedAt.localeCompare(b.updatedAt),
  );
  let highWater = cursorRef.current;

  for (const inv of sorted) {
    if (!inv.recipientDeviceId || inv.status !== "left") continue;
    if (inFlight.current.has(inv.id)) continue;
    const folder = folders.find((f) => f.id === inv.folderId);
    if (!folder) {
      // Folder gone already; nothing to do but advance.
      highWater = advanceUpdated(highWater, inv);
      continue;
    }
    if (!folder.devices.some((d) => d.deviceID === inv.recipientDeviceId)) {
      // Already removed (maybe by another tab); just advance.
      highWater = advanceUpdated(highWater, inv);
      continue;
    }
    inFlight.current.add(inv.id);
    try {
      const updated: FolderConfiguration = {
        ...folder,
        devices: folder.devices.filter(
          (d) => d.deviceID !== inv.recipientDeviceId,
        ),
      };
      await client.putFolder(updated);
      highWater = advanceUpdated(highWater, inv);
    } catch (e) {
      console.warn("InvitationBridge: failed to drop device on leave", inv.id, e);
      break;
    } finally {
      inFlight.current.delete(inv.id);
    }
  }

  if (highWater && highWater !== cursorRef.current) {
    cursorRef.current = highWater;
    try {
      localStorage.setItem(LEFT_CURSOR_KEY, highWater);
    } catch {
      /* see note above */
    }
  }
}

// advanceUpdated mirrors `advance` but uses updatedAt as the cursor
// timestamp — left invitations don't have an acceptedAt to bump past.
function advanceUpdated(curr: string | null, inv: CloudInvitation): string {
  const next = new Date(new Date(inv.updatedAt).getTime() + 1).toISOString();
  if (!curr) return next;
  return next > curr ? next : curr;
}

// ensureDeviceKnown adds the recipient device to the local daemon if
// it isn't already known. The sync daemon won't let you share a folder with
// an unknown device, so we have to register it first. defaultDevice()
// gives us reasonable transport defaults.
async function ensureDeviceKnown(deviceID: string) {
  // Refresh config from the daemon directly — we may be racing with
  // the React Query cache after a recent putFolder.
  const live = await client.config();
  if (live.devices.some((d) => d.deviceID === deviceID)) return;
  const def = await client.defaultDevice();
  await client.addDevice({
    ...def,
    deviceID,
    // Short slug as a placeholder name. The owner can rename later;
    // the recipient's display name will arrive via the cloud /v1/me
    // mapping in a future pass.
    name: deviceID.slice(0, 7),
  });
}

function advance(curr: string | null, inv: CloudInvitation): string {
  const t = inv.acceptedAt ?? inv.updatedAt;
  // Server returns RFC3339; we add 1ms so the next `since` query
  // doesn't re-include this row.
  const next = new Date(new Date(t).getTime() + 1).toISOString();
  if (!curr) return next;
  return next > curr ? next : curr;
}

function readCursor(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
