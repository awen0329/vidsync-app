import { useState } from "react";
import { useBearerAuth } from "../api/bearerAuth";
import {
  useAccountEmail,
  useCloudMe,
  useOpenPortal,
  useRevokeCurrentSession,
} from "../api/cloud/hooks";
import { HIDE_BILLING } from "../App";

// AccountPanel: email + current tier + manage / sign-out. The
// upgrade UX itself lives on the Pricing page (a dedicated tab) so
// users can compare plans side-by-side. This panel is intentionally
// brief — it's the "you are here" reminder inside Settings.

export function AccountPanel() {
  const { signOut } = useBearerAuth();
  const me = useCloudMe();
  const portal = useOpenPortal();
  const revoke = useRevokeCurrentSession();

  // Mirror Sidebar.AccountRow: revoke server session first (best-
  // effort, swallow failures), then wipe local token.
  async function handleSignOut() {
    try {
      await revoke.mutateAsync();
    } catch {
      // ignore; sign out locally anyway
    }
    signOut();
  }
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // Email previously came from Clerk's useUser(); now /v1/me is the
  // only source since the desktop app doesn't embed Clerk. Use the
  // sticky last-known value so a transient /v1/me failure doesn't blank
  // the address.
  const email = useAccountEmail();
  const currentTier = me.data?.tier;
  const status = me.data?.status;
  const entitled = me.data?.entitled ?? false;
  const isPaid = currentTier && currentTier.name !== "free";
  // Stripe's portal Cancel sets cancel_at_period_end=true and keeps
  // status=active until the period ends, so without these two fields
  // the Account panel would look identical before and after the user
  // hit Cancel. Surface them so the cancellation is visibly registered.
  const cancelPending = me.data?.cancelAtPeriodEnd ?? false;
  const cancelOn = me.data?.currentPeriodEnd;
  // Free plan is a 1-day trial. trialEndsAt is the moment access
  // flips off; entitled goes false once we're past it. Surface both
  // so the user sees their time remaining (or that it's expired).
  const trialEndsAt = me.data?.trialEndsAt;
  const onFreeTier = currentTier?.name === "free";
  const trialExpired = onFreeTier && !entitled;

  async function manage() {
    setBusy(true);
    setErr(null);
    try {
      const { url } = await portal.mutateAsync();
      window.location.assign(url);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between rounded-md border border-line px-3 py-2">
        <div className="min-w-0">
          <div className="truncate text-sm text-fg-strong">{email}</div>
          <div className="text-[11px] text-fg-soft">Signed in via thevidsync.com</div>
        </div>
        <button
          type="button"
          onClick={handleSignOut}
          disabled={revoke.isPending}
          className="shrink-0 rounded border border-line px-2 py-1 text-xs text-fg-soft hover:bg-panel disabled:opacity-60"
        >
          {revoke.isPending ? "Signing out…" : "Sign out"}
        </button>
      </div>

      <div className="rounded-md border border-line px-3 py-2 text-sm">
        <div className="flex items-baseline justify-between">
          <div>
            <span className="font-semibold text-fg-strong">
              {currentTier?.displayName ?? "—"}
            </span>
            <span className="ml-2 text-xs text-fg-soft">
              {cancelPending && cancelOn
                ? `cancels ${formatCancelDate(cancelOn)}`
                : status ?? ""}
            </span>
          </div>
          <span
            className={
              "rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide " +
              (cancelPending
                ? "bg-amber-100 text-amber-800"
                : entitled
                  ? "bg-indigo-100 text-indigo-800"
                  : "bg-amber-100 text-amber-800")
            }
          >
            {cancelPending ? "Canceling" : entitled ? "Active" : "Inactive"}
          </span>
        </div>
        {onFreeTier && trialEndsAt && (
          <p
            className={
              "mt-2 text-[11px] " +
              (trialExpired ? "text-amber-300" : "text-fg-soft")
            }
          >
            {trialExpired
              ? `Trial ended ${formatCancelDate(trialEndsAt)}`
              : `Trial ends ${formatCancelDate(trialEndsAt)}`}
          </p>
        )}
        {HIDE_BILLING ? null : isPaid ? (
          <button
            type="button"
            onClick={manage}
            disabled={busy}
            className="mt-2 w-full rounded border border-line px-2 py-1.5 text-xs text-fg hover:bg-panel disabled:opacity-50"
          >
            {busy ? "Opening…" : "Manage subscription"}
          </button>
        ) : (
          <p className="mt-2 text-[11px] text-fg-soft">
            Open the <strong>Pricing</strong> tab to compare plans and
            upgrade.
          </p>
        )}
      </div>

      {err && <p className="text-xs text-rose-700">{err}</p>}
    </div>
  );
}

// formatCancelDate renders an ISO timestamp as "Jan 15, 2026" for the
// "Cancels DD/MM" hint. We don't reuse humanRelative here because for
// a scheduled future cancellation an absolute date is friendlier than
// "in 23d" — the user wants to know the specific day they'll lose access.
function formatCancelDate(iso: string): string {
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return iso;
  return d.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}
