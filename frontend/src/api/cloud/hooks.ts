// React-Query hooks over the CloudClient. Keys are namespaced under
// "cloud" so they never collide with the sync-daemon hooks in
// api/hooks.ts.

import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCloudClient } from "./provider";
import {
  getLastKnownEmail,
  loadDurableEmail,
  rehydrateLocalCache,
  setLastKnownEmail,
} from "../lastKnownEmail";
import type {
  Me,
  CloudDevice,
  CloudInvitation,
  Tier,
  VerificationRequired,
} from "./client";

export const cloudKeys = {
  me: ["cloud", "me"] as const,
  devices: ["cloud", "devices"] as const,
  tiers: ["cloud", "tiers"] as const,
  myInvitations: ["cloud", "invitations", "mine"] as const,
  acceptedSince: ["cloud", "invitations", "accepted"] as const,
  leftSince: ["cloud", "invitations", "left"] as const,
  folderInvitations: (folderID: string) =>
    ["cloud", "invitations", "folder", folderID] as const,
};

// /v1/me changes only on subscription transitions (rare) and device
// registration (also rare). 5 minutes is plenty; the desktop client
// will also refetch on window focus to catch external changes.
const ME_REFETCH_MS = 5 * 60_000;

// useCloudMe accepts the current sync daemon device id so the backend
// can tell us whether *this* device is the active one or has been
// revoked. Pass undefined before the daemon has reported its id;
// the request still works, just without device-context.
export function useCloudMe(deviceID?: string) {
  const client = useCloudClient();
  return useQuery<Me>({
    queryKey: [...cloudKeys.me, deviceID ?? ""],
    queryFn: () => client.me(deviceID),
    refetchInterval: ME_REFETCH_MS,
    refetchOnWindowFocus: true,
    retry: 1,
  });
}

// useAccountEmail returns the best-known signed-in email for display. It
// prefers the live /v1/me value but falls back to a persisted last-known
// value, so a cold start or a transient /v1/me failure never downgrades the
// UI to a generic "Signed in". The fallback is seeded synchronously from the
// localStorage cache, then rehydrated from the durable Go-side store on mount
// (the macOS webview may not keep localStorage across launches). The live
// value is persisted to both layers whenever it arrives; both are cleared on
// sign-out (localStorage via bearerAuth, the Go file via the auth bridge).
export function useAccountEmail(): string {
  const me = useCloudMe();
  const live = me.data?.email ?? "";
  const [sticky, setSticky] = useState<string>(() => getLastKnownEmail());

  // Persist every fresh live value to both cache layers.
  useEffect(() => {
    if (live) {
      setLastKnownEmail(live);
      setSticky(live);
    }
  }, [live]);

  // Rehydrate from the durable Go store once on mount, in case the webview
  // didn't retain the localStorage cache from the last launch.
  useEffect(() => {
    let cancelled = false;
    void loadDurableEmail().then((email) => {
      if (cancelled || !email) return;
      rehydrateLocalCache(email);
      setSticky((cur) => cur || email);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  return live || sticky;
}

export function useCloudDevices() {
  const client = useCloudClient();
  return useQuery({
    queryKey: cloudKeys.devices,
    queryFn: () => client.listDevices(),
    refetchInterval: ME_REFETCH_MS,
  });
}

export function useCloudTiers() {
  const client = useCloudClient();
  return useQuery<{ tiers: Tier[] }>({
    queryKey: cloudKeys.tiers,
    queryFn: () => client.listTiers(),
    staleTime: Infinity, // pricing doesn't change without a deploy
  });
}

export function useRegisterDevice() {
  const qc = useQueryClient();
  const client = useCloudClient();
  return useMutation({
    mutationFn: (args: { syncthingDeviceId: string; name: string }) =>
      client.registerDevice(args),
    onSuccess: (result: CloudDevice | VerificationRequired) => {
      // Only invalidate when we actually registered. The
      // verification_required path doesn't change cloud state yet.
      if ("error" in result) return;
      qc.invalidateQueries({ queryKey: cloudKeys.me });
      qc.invalidateQueries({ queryKey: cloudKeys.devices });
    },
  });
}

export function useVerifyDevice() {
  const qc = useQueryClient();
  const client = useCloudClient();
  return useMutation({
    mutationFn: (args: { verificationId: string; code: string }) =>
      client.verifyDevice(args),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: cloudKeys.me });
      qc.invalidateQueries({ queryKey: cloudKeys.devices });
    },
  });
}

export function useResendVerification() {
  const client = useCloudClient();
  return useMutation({
    mutationFn: (verificationId: string) =>
      client.resendVerificationCode(verificationId),
  });
}

export function useDeleteCloudDevice() {
  const qc = useQueryClient();
  const client = useCloudClient();
  return useMutation({
    mutationFn: (id: string) => client.deleteDevice(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: cloudKeys.me });
      qc.invalidateQueries({ queryKey: cloudKeys.devices });
    },
  });
}

// useStartCheckout: calls the backend to mint a Checkout session and
// resolves with the hosted URL. The caller is responsible for
// navigating the window — typically window.location.assign(url).
export function useStartCheckout() {
  const client = useCloudClient();
  return useMutation({
    mutationFn: (args: {
      tier: "pro" | "studio";
      interval: "monthly" | "yearly";
    }) => client.startCheckout(args),
  });
}

// useOpenPortal: mints a Customer Portal URL so users can self-serve
// cancellations, switch plans, update payment methods, download
// invoices.
export function useOpenPortal() {
  const client = useCloudClient();
  return useMutation({
    mutationFn: () => client.openPortal(),
  });
}

// useRevokeCurrentSession: server-side half of sign-out. Resolves the
// current desktop session (heuristic in CloudClient.revokeCurrentSession)
// and revokes it via DELETE /v1/sessions/{id}. Callers chain this
// before the local ClearAuthToken so a stolen auth.bin can't keep
// authing after the user signs out.
export function useRevokeCurrentSession() {
  const client = useCloudClient();
  return useMutation({
    mutationFn: () => client.revokeCurrentSession(),
  });
}

// --- invitations ---

// Recipient + owner-bridge poll cadence. We used to run this at 30s
// but that made the owner side feel broken: the recipient would click
// Accept, then for up to half a minute the owner's daemon would see
// the recipient's daemon as a "pending device" (because the bridge
// hadn't applied the share yet), so the owner had to manually accept.
// 3s is small enough that the bridge usually wins the race against
// daemon discovery, eliminating the spurious pending-device step.
const INVITATIONS_REFETCH_MS = 3_000;

export function useMyInvitations(enabled = true) {
  const client = useCloudClient();
  return useQuery<{ invitations: CloudInvitation[] }>({
    queryKey: cloudKeys.myInvitations,
    queryFn: () => client.listMyInvitations(),
    refetchInterval: INVITATIONS_REFETCH_MS,
    refetchOnWindowFocus: true,
    enabled,
  });
}

// Owner: list all invites (any status) for one of their folders.
// Used on the Team tab to show a Pending Invites sub-section.
export function useFolderInvitations(folderID: string | null) {
  const client = useCloudClient();
  return useQuery<{ invitations: CloudInvitation[] }>({
    queryKey: cloudKeys.folderInvitations(folderID ?? ""),
    queryFn: () => client.listInvitationsForFolder(folderID!),
    enabled: !!folderID,
    refetchInterval: INVITATIONS_REFETCH_MS,
  });
}

// Any member: the full project roster (owner + accepted members). Lets the
// Team tab show everyone, including sibling collaborators a recipient's
// daemon isn't directly peered with.
export function useProjectMembers(folderID: string | null) {
  const client = useCloudClient();
  return useQuery({
    queryKey: ["project-members", folderID ?? ""],
    queryFn: () => client.projectMembers(folderID!),
    enabled: !!folderID,
    refetchInterval: INVITATIONS_REFETCH_MS,
  });
}

// Recipient: my accepted invitation for a folder (carries the owner's
// device id + email/name). Used by the Team tab to label the owner's
// device with the owner's name instead of its raw hostname.
export function useMyAcceptedForFolder(folderID: string | null) {
  const client = useCloudClient();
  return useQuery({
    queryKey: ["invitations", "accepted-for-folder", folderID ?? ""],
    queryFn: () => client.findMyAcceptedForFolder(folderID!),
    enabled: !!folderID,
    refetchInterval: INVITATIONS_REFETCH_MS,
  });
}

// Owner: see what's been accepted recently. The bridge polls this
// and reacts to new accepts by calling the local daemon to share
// the folder with the recipient's device. We expose the raw fetch
// (no caching) since the bridge wants tight control over `since`.
export function useAcceptedSince(since: string | null, enabled = true) {
  const client = useCloudClient();
  return useQuery<{ invitations: CloudInvitation[] }>({
    queryKey: [...cloudKeys.acceptedSince, since ?? ""],
    queryFn: () => client.listAcceptedSince(since ?? undefined),
    enabled,
    refetchInterval: INVITATIONS_REFETCH_MS,
    refetchOnWindowFocus: false,
  });
}

export function useCreateInvitation() {
  const qc = useQueryClient();
  const client = useCloudClient();
  return useMutation({
    mutationFn: (args: {
      folderID: string;
      email: string;
      folderLabel: string;
      ownerDeviceId: string;
      folderSizeBytes?: number;
    }) => client.createInvitation(args),
    onSuccess: (_data, vars) => {
      qc.invalidateQueries({
        queryKey: cloudKeys.folderInvitations(vars.folderID),
      });
    },
  });
}

export function useAcceptInvitation() {
  const qc = useQueryClient();
  const client = useCloudClient();
  return useMutation({
    mutationFn: (args: { id: string; recipientDeviceId: string }) =>
      client.acceptInvitation(args),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: cloudKeys.myInvitations });
    },
  });
}

export function useDeclineInvitation() {
  const qc = useQueryClient();
  const client = useCloudClient();
  return useMutation({
    mutationFn: (id: string) => client.declineInvitation(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: cloudKeys.myInvitations });
    },
  });
}

// useLeaveInvitation: recipient-side mutation that flips an accepted
// invitation to "left" on the cloud. Called when the user clicks
// "Leave" on an invited project — the owner's bridge sees the left
// event on its next poll and removes the recipient's device from the
// folder.
export function useLeaveInvitation() {
  const client = useCloudClient();
  return useMutation({
    mutationFn: (id: string) => client.leaveInvitation(id),
  });
}

// Owner-side: poll for invitations recipients have left, so the
// bridge can drop those devices from folder.devices.
export function useLeftSince(since: string | null, enabled = true) {
  const client = useCloudClient();
  return useQuery<{ invitations: CloudInvitation[] }>({
    queryKey: [...cloudKeys.leftSince, since ?? ""],
    queryFn: () => client.listLeftSince(since ?? undefined),
    enabled,
    refetchInterval: INVITATIONS_REFETCH_MS,
    refetchOnWindowFocus: false,
  });
}

export function useRevokeInvitation() {
  const qc = useQueryClient();
  const client = useCloudClient();
  return useMutation({
    mutationFn: (args: { id: string; folderID: string }) =>
      client.revokeInvitation(args.id),
    onSuccess: (_data, vars) => {
      qc.invalidateQueries({
        queryKey: cloudKeys.folderInvitations(vars.folderID),
      });
    },
  });
}
