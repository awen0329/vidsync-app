import { useEffect, useState } from "react";
import { AcceptFolderModal } from "../components/AcceptFolderModal";
import { AUTH_ENABLED, HIDE_BILLING } from "../App";
import { useProjectQuota } from "../api/cloud/useProjectQuota";
import {
  useAddDevice,
  useConfig,
  useDismissPendingDevice,
  useDismissPendingFolder,
  usePendingDevices,
  usePendingFolders,
  useSystemStatus,
} from "../api/hooks";
import {
  useAcceptedSince,
  useAcceptInvitation,
  useCloudDevices,
  useDeclineInvitation,
  useMyInvitations,
} from "../api/cloud/hooks";
import type { CloudInvitation } from "../api/cloud/client";
import { rememberAcceptedInvitation } from "../api/cloud/acceptedInvitations";
import {
  loadSelfDevices,
  rememberSelfDevices,
} from "../api/cloud/selfDevices";
import { client } from "../api/client";
import { humanRelative } from "../lib/format";

// Invitations: a single inbox combining three sources:
//
//   1. Cloud email invitations — somebody used the email-based invite
//      flow. Owner's app holds the canonical "I want to share X with
//      this email" record; recipient sees it here. Accepting maps the
//      recipient's current device into the row, then the owner's
//      InvitationBridge picks up the accept and shares the folder.
//
//   2. Pending folder offers from the daemon — a known device is
//      offering to share a folder right now. Accepting opens
//      AcceptFolderModal so the user picks a local download path. This
//      is what shows up after the cloud accept completes and peering
//      establishes, OR for legacy / non-cloud shares.
//
//   3. Pending device requests — another device wants to connect to
//      ours. Rare in the email-invite flow, but kept for completeness.
//
// All three are presented uniformly so the user doesn't have to think
// about which mechanism produced an offer.

interface PendingFolderRow {
  folderID: string;
  deviceID: string;
  label: string;
  fromName: string;
  // Resolved owner email when the offering device belongs to a
  // known Vidsync user (matched against the recipient's own cloud
  // invitations, which carry ownerDeviceId + ownerEmail). Falls
  // back to the daemon-level device name if we can't resolve it.
  fromEmail?: string;
  receivedAt: string | null;
}

interface PendingDeviceRow {
  deviceID: string;
  name: string;
  receivedAt: string | null;
}

export function Invitations({
  onOpenProject,
}: {
  // Navigate to a project's detail page. Optional so the page still
  // renders in contexts without a router; when present, accepting a
  // folder offer jumps straight into the newly-synced project.
  onOpenProject?: (folderID: string) => void;
} = {}) {
  const devices = usePendingDevices();
  const folders = usePendingFolders();
  const cfg = useConfig();
  const status = useSystemStatus();
  const cloudInvites = useMyInvitations(AUTH_ENABLED);
  // My own devices on the cloud — used to recognise folder offers
  // coming from a previous device of the same account so we don't
  // present them as a third-party invitation. Includes revoked
  // devices (after switching seats, the displaced daemon may still
  // be running and advertising folders). Disabled in local-only mode.
  const myCloudDevices = useCloudDevices();
  // Owner-side: which recipient devices have already accepted invites
  // we sent? Used below to filter out the brief "pending device" rows
  // that show up while the InvitationBridge is still applying the
  // share — clicking them isn't necessary and just creates duplicate
  // work.
  const acceptedByMe = useAcceptedSince(null, AUTH_ENABLED);
  const addDevice = useAddDevice();
  const dismissDevice = useDismissPendingDevice();
  const dismissFolder = useDismissPendingFolder();
  const acceptCloud = useAcceptInvitation();
  const declineCloud = useDeclineInvitation();
  const quota = useProjectQuota();

  const myID = status.data?.myID ?? "";

  // Accepting an invitation consumes a project slot exactly like
  // creating one — invited folders are counted in the quota (see
  // useProjectQuota.countAll). Gate accepts on the same canCreate flag
  // so the Free trial's 1-project cap can't be sidestepped by accepting
  // someone else's project. canCreate is false when at the cap, when
  // the trial has expired, or when a paid subscription is inactive.
  const canAcceptProject = quota.canCreate;
  const acceptBlockedReason = quota.trialExpired
    ? `Your free trial has ended.${HIDE_BILLING ? "" : " Upgrade to take on more projects."}`
    : quota.subscriptionInactive
      ? `Your ${quota.inactiveTierLabel ?? "paid"} subscription isn't active.${HIDE_BILLING ? "" : " Renew it to take on more projects."}`
      : !canAcceptProject
        ? `You're at your ${quota.max}-project limit — invited projects count toward it.${HIDE_BILLING ? "" : " Upgrade for more."}`
        : undefined;

  const [acceptingFolder, setAcceptingFolder] = useState<{
    folderID: string;
    deviceID: string;
    label: string;
    // Set on cloud-invite accepts so the modal's submit can register
    // the device + POST the cloud accept *before* adding the folder
    // locally. Keeps the invitation pending until the user has
    // actually committed in the modal — closing without confirming
    // leaves the cloud row in place.
    cloudInviteID?: string;
    // Project total size (bytes) carried on the cloud invitation, when
    // the owner supplied it. Undefined for daemon pending-folder offers
    // (no cloud record to carry it).
    sizeBytes?: number;
  } | null>(null);
  const [busyDevice, setBusyDevice] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  // The local sync daemon takes a beat to start on a fresh
  // launch; until it answers /rest/system/status with our myID, any
  // Accept click would land in the "not registered yet" branch. Clear
  // a stale message once the daemon catches up so the banner doesn't
  // linger after the underlying condition has resolved.
  useEffect(() => {
    if (myID) setErr(null);
  }, [myID]);

  // Whenever the live cloud-device list updates, persist the IDs into
  // localStorage so the self-invite filter still works after sign-out
  // or DB wipe — by which point /v1/devices returns empty and we'd
  // otherwise lose the "this device is also me" signal.
  useEffect(() => {
    const ids = (myCloudDevices.data?.devices ?? []).map(
      (d) => d.syncthingDeviceId,
    );
    if (ids.length > 0) rememberSelfDevices(ids);
  }, [myCloudDevices.data]);

  const cloudRows: CloudInvitation[] = (
    cloudInvites.data?.invitations ?? []
  ).filter((i) => i.status === "pending");

  // Owner-side filter: deviceIDs the bridge is about to add (or has
  // already added) shouldn't be presented as something the owner has
  // to manually accept.
  const bridgeDeviceIDs = new Set<string>();
  for (const inv of acceptedByMe.data?.invitations ?? []) {
    if (inv.recipientDeviceId) bridgeDeviceIDs.add(inv.recipientDeviceId);
  }
  const deviceRows: PendingDeviceRow[] = Object.entries(
    devices.data ?? {},
  )
    .filter(([deviceID]) => !bridgeDeviceIDs.has(deviceID))
    .map(([deviceID, info]) => ({
      deviceID,
      name: info.name || deviceID.slice(0, 7),
      receivedAt: info.time ?? null,
    }));

  // Skip folder offers for folders the local daemon already has
  // configured. That covers two cases the user shouldn't see in the
  // invitations inbox:
  //   - Owner side: the recipient's daemon advertises the folder back
  //     during the brief window between bridge.addDevice and
  //     bridge.putFolder, which briefly registers as "pending" on the
  //     owner. The owner already has the folder; there's nothing to
  //     accept.
  //   - Recipient side: after our acceptCloudInvite pre-adds the
  //     folder locally, any subsequent re-advertise from the owner
  //     would also land as pending; ignore that too.
  const ownedFolderIDs = new Set(
    (cfg.data?.folders ?? []).map((f) => f.id),
  );
  // Devices belonging to the current cloud account — used to drop
  // folder offers from "another machine I've signed into" so the
  // inbox doesn't show what is effectively a self-invitation. We
  // union the live list with a localStorage cache of every device
  // ID this browser has ever seen as ours, so the filter still works
  // when /v1/devices returns empty (signed out, fresh DB, etc.).
  const myCloudDeviceIDs = new Set<string>(
    (myCloudDevices.data?.devices ?? []).map((d) => d.syncthingDeviceId),
  );
  for (const id of loadSelfDevices()) myCloudDeviceIDs.add(id);
  // syncthingDeviceId -> ownerEmail map built from invitations the
  // current user has received. Lets us label "from <person>" using
  // the cloud-side email rather than the daemon's device hostname.
  const emailByDevice = new Map<string, string>();
  for (const inv of cloudInvites.data?.invitations ?? []) {
    if (inv.ownerDeviceId && inv.ownerEmail) {
      emailByDevice.set(inv.ownerDeviceId, inv.ownerEmail);
    }
  }
  const folderRows: PendingFolderRow[] = [];
  for (const [folderID, pf] of Object.entries(folders.data ?? {})) {
    if (ownedFolderIDs.has(folderID)) continue;
    for (const [deviceID, offer] of Object.entries(pf.offeredBy)) {
      // Hide offers coming from another of my own seats. The cloud
      // device list is the source of truth; the local daemon has no
      // way to know two device IDs share an account.
      if (myCloudDeviceIDs.has(deviceID)) continue;
      const fromName =
        cfg.data?.devices.find((d) => d.deviceID === deviceID)?.name ??
        deviceID.slice(0, 7);
      folderRows.push({
        folderID,
        deviceID,
        label: offer.label || folderID,
        fromName,
        fromEmail: emailByDevice.get(deviceID),
        receivedAt: offer.time ?? null,
      });
    }
  }

  const total = cloudRows.length + deviceRows.length + folderRows.length;

  const acceptDevice = async (row: PendingDeviceRow) => {
    setBusyDevice(row.deviceID);
    setErr(null);
    try {
      const def = await client.defaultDevice();
      await addDevice.mutateAsync({
        ...def,
        deviceID: row.deviceID,
        name: row.name,
      });
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyDevice(null);
    }
  };

  // Accepting a cloud invite is a two-phase commit:
  //   Phase 1 (click "Accept"): just open the destination-picker
  //     modal. Nothing irreversible has happened — the invitation
  //     row stays pending so the user can back out.
  //   Phase 2 (confirm in modal): register the owner's device,
  //     POST /v1/invitations/:id/accept, remember the link, then
  //     add the local folder at the chosen path. This all runs in
  //     `prepareCloudAccept` below, passed to the modal as
  //     `beforeAddFolder`.
  //
  // Closing the modal without confirming leaves Phase 2 unrun, so
  // the cloud invitation stays in the recipient's list.
  const acceptCloudInvite = (inv: CloudInvitation) => {
    if (!myID) {
      setErr("This device isn't registered yet — try again in a moment.");
      return;
    }
    if (!canAcceptProject) {
      setErr(acceptBlockedReason ?? "You can't take on another project right now.");
      return;
    }
    setErr(null);
    setAcceptingFolder({
      folderID: inv.folderId,
      deviceID: inv.ownerDeviceId,
      label: inv.folderLabel,
      cloudInviteID: inv.id,
      sizeBytes: inv.folderSizeBytes,
    });
  };

  // Runs from inside the accept modal's submit — only when the user
  // actually commits a destination path.
  const prepareCloudAccept = async (
    cloudInviteID: string,
    ownerDeviceID: string,
    folderID: string,
  ) => {
    if (!myID) {
      throw new Error("This device isn't registered yet — try again in a moment.");
    }
    const live = await client.config();
    const known = live.devices.some((d) => d.deviceID === ownerDeviceID);
    if (!known) {
      const def = await client.defaultDevice();
      await addDevice.mutateAsync({
        ...def,
        deviceID: ownerDeviceID,
        name: ownerDeviceID.slice(0, 7),
      });
    }
    await acceptCloud.mutateAsync({
      id: cloudInviteID,
      recipientDeviceId: myID,
    });
    rememberAcceptedInvitation(folderID, cloudInviteID);
  };

  return (
    <div className="mx-auto h-full max-w-5xl overflow-y-auto px-8 py-10">
      <header className="mb-8">
        <h1 className="text-3xl font-semibold tracking-tight text-fg-strong">
          Invitations
        </h1>
        <p className="mt-1 text-sm text-fg-soft">
          {total === 0
            ? "Nothing waiting on you."
            : `${total} pending invitation${total === 1 ? "" : "s"}.`}
        </p>
      </header>

      {err && (
        <div className="mb-4 rounded-lg border border-rose-500/30 bg-rose-500/5 px-4 py-3 text-sm text-rose-300">
          {err}
        </div>
      )}

      {!canAcceptProject && (cloudRows.length > 0 || folderRows.length > 0) && (
        <div className="mb-4 rounded-lg border border-amber-500/30 bg-amber-500/5 px-4 py-3 text-sm text-amber-200">
          {acceptBlockedReason}
        </div>
      )}

      {total === 0 ? (
        <div className="rounded-xl border border-dashed border-line-strong bg-elevated/40 px-6 py-20 text-center">
          <p className="text-sm text-fg-soft">
            When a collaborator invites you to a project or wants to connect
            with this device, you'll see it here.
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {cloudRows.map((inv) => (
            <div
              key={inv.id}
              className="flex items-center justify-between gap-4 rounded-lg border border-line bg-elevated p-4"
            >
              <div className="min-w-0 flex-1">
                <div className="text-sm font-medium text-fg-strong">
                  Project invitation: {inv.folderLabel}
                </div>
                <div className="mt-0.5 text-xs text-fg-soft">
                  {/* These rows are pending invites *to me*, so the
                      sender is the load-bearing identity. Lead with
                      it; keep recipientEmail visible secondary so a
                      user signed into multiple Clerk addresses can
                      still tell which mailbox the invite came in on. */}
                  From{" "}
                  <span
                    className="text-fg"
                    title={inv.ownerEmail ?? inv.ownerDeviceId.slice(0, 7)}
                  >
                    {inv.ownerName ?? inv.ownerEmail ?? "an unknown user"}
                  </span>
                  {" · to "}
                  <span className="text-fg">{inv.recipientEmail}</span>
                  {inv.createdAt && (
                    <>
                      {" · "}
                      <span title={new Date(inv.createdAt).toLocaleString()}>
                        {humanRelative(inv.createdAt)}
                      </span>
                    </>
                  )}
                </div>
              </div>
              <div className="flex shrink-0 gap-2">
                <button
                  type="button"
                  disabled={declineCloud.isPending}
                  onClick={() => declineCloud.mutate(inv.id)}
                  className="rounded-md px-3 py-1.5 text-sm text-fg-soft hover:bg-hover hover:text-fg-strong disabled:opacity-60"
                >
                  Decline
                </button>
                <button
                  type="button"
                  disabled={!myID || !canAcceptProject}
                  title={
                    !myID
                      ? "Connecting to your local workspace…"
                      : !canAcceptProject
                        ? acceptBlockedReason
                        : undefined
                  }
                  onClick={() => acceptCloudInvite(inv)}
                  className="rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-accent-fg hover:bg-accent-hover disabled:opacity-60"
                >
                  {!myID ? "Connecting…" : "Accept"}
                </button>
              </div>
            </div>
          ))}

          {folderRows.map((row) => (
            <div
              key={`${row.folderID}-${row.deviceID}`}
              className="flex items-center justify-between gap-4 rounded-lg border border-line bg-elevated p-4"
            >
              <div className="min-w-0 flex-1">
                <div className="text-sm font-medium text-fg-strong">
                  Project ready to sync: {row.label}
                </div>
                <div className="mt-0.5 text-xs text-fg-soft">
                  From{" "}
                  <span
                    className="text-fg"
                    title={row.fromEmail ?? row.fromName}
                  >
                    {row.fromEmail ?? row.fromName}
                  </span>
                  {row.receivedAt && (
                    <>
                      {" · "}
                      <span title={new Date(row.receivedAt).toLocaleString()}>
                        {humanRelative(row.receivedAt)}
                      </span>
                    </>
                  )}
                </div>
              </div>
              <div className="flex shrink-0 gap-2">
                <button
                  type="button"
                  onClick={() =>
                    dismissFolder.mutate({
                      folderID: row.folderID,
                      deviceID: row.deviceID,
                      label: row.label,
                    })
                  }
                  className="rounded-md px-3 py-1.5 text-sm text-fg-soft hover:bg-hover hover:text-fg-strong"
                >
                  Decline
                </button>
                <button
                  type="button"
                  disabled={!canAcceptProject}
                  title={!canAcceptProject ? acceptBlockedReason : undefined}
                  onClick={() => {
                    if (!canAcceptProject) {
                      setErr(
                        acceptBlockedReason ??
                          "You can't take on another project right now.",
                      );
                      return;
                    }
                    setAcceptingFolder({
                      folderID: row.folderID,
                      deviceID: row.deviceID,
                      label: row.label,
                    });
                  }}
                  className="rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-accent-fg hover:bg-accent-hover disabled:opacity-60"
                >
                  Choose folder
                </button>
              </div>
            </div>
          ))}

          {deviceRows.map((row) => (
            <div
              key={row.deviceID}
              className="flex items-center justify-between gap-4 rounded-lg border border-line bg-elevated p-4"
            >
              <div className="min-w-0 flex-1">
                <div className="text-sm font-medium text-fg-strong">
                  New collaborator: {row.name}
                </div>
                <div className="mt-0.5 text-xs text-fg-soft">
                  Wants to connect to this device
                  {row.receivedAt && (
                    <>
                      {" · "}
                      <span title={new Date(row.receivedAt).toLocaleString()}>
                        {humanRelative(row.receivedAt)}
                      </span>
                    </>
                  )}
                </div>
              </div>
              <div className="flex shrink-0 gap-2">
                <button
                  type="button"
                  onClick={() => dismissDevice.mutate(row.deviceID)}
                  className="rounded-md px-3 py-1.5 text-sm text-fg-soft hover:bg-hover hover:text-fg-strong"
                >
                  Decline
                </button>
                <button
                  type="button"
                  disabled={busyDevice === row.deviceID}
                  onClick={() => acceptDevice(row)}
                  className="rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-accent-fg hover:bg-accent-hover disabled:opacity-60"
                >
                  {busyDevice === row.deviceID ? "Adding…" : "Accept"}
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {acceptingFolder && (
        <AcceptFolderModal
          info={acceptingFolder}
          sizeBytes={acceptingFolder.sizeBytes}
          onClose={() => setAcceptingFolder(null)}
          onAccepted={(folderID) => {
            setAcceptingFolder(null);
            onOpenProject?.(folderID);
          }}
          // Cloud invites carry an ID; non-cloud (pending-folder) flows
          // pass none. The modal calls beforeAddFolder right before it
          // tries to add the local folder, so closing the modal first
          // means the cloud accept never runs.
          beforeAddFolder={
            acceptingFolder.cloudInviteID
              ? () =>
                  prepareCloudAccept(
                    acceptingFolder.cloudInviteID!,
                    acceptingFolder.deviceID,
                    acceptingFolder.folderID,
                  )
              : undefined
          }
        />
      )}
    </div>
  );
}
