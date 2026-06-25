import { useEffect, useRef } from "react";
import { useConfig, usePatchFolder } from "../api/hooks";
import { useCloudMe } from "../api/cloud/hooks";
import { AUTH_ENABLED } from "../App";
import { client } from "../api/client";

// EntitlementGate enforces the cloud-side entitlement on the daemon's
// folders: when the user's plan lapses (free trial expired, subscription
// past_due / canceled / unpaid), every folder is paused so the daemon
// stops moving bytes; when the user upgrades or renews, the folders the
// gate paused are unpaused so sync resumes without the user touching
// each one.
//
// Folders the user paused themselves are NOT auto-resumed — we only
// flip back the ones we recorded as auto-paused in localStorage.

const STORAGE_KEY = "vidsync.entitlement.autoPausedIDs";

function readAutoPaused(): string[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

function writeAutoPaused(ids: string[]): void {
  try {
    if (ids.length === 0) {
      localStorage.removeItem(STORAGE_KEY);
    } else {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(ids));
    }
  } catch {
    /* private mode etc. — non-fatal */
  }
}

export function useEntitlementEnforcement() {
  const cfg = useConfig();
  const me = useCloudMe();
  const patch = usePatchFolder();
  // Inflight guard so a rapidly-toggling entitled flag doesn't spam
  // the daemon with overlapping pause/resume batches.
  const inflight = useRef(false);

  useEffect(() => {
    if (!AUTH_ENABLED) return;
    if (me.isLoading || !me.data) return;
    if (!cfg.data?.folders) return;
    if (inflight.current) return;

    const entitled = me.data.entitled;
    const folders = cfg.data.folders;

    if (!entitled) {
      // Lapsed plan: pause anything still running. Capture the IDs we
      // paused so we know which to flip back when the user upgrades.
      const toPause = folders.filter((f) => !f.paused);
      if (toPause.length === 0) return;
      const known = new Set(readAutoPaused());
      for (const f of toPause) known.add(f.id);
      writeAutoPaused([...known]);
      inflight.current = true;
      void Promise.allSettled(
        toPause.map((f) =>
          client.patchFolder(f.id, { paused: true }).catch(() => {
            /* best-effort; next render will retry */
          }),
        ),
      ).finally(() => {
        inflight.current = false;
      });
      return;
    }

    // Entitled: unpause anything we paused on the user's behalf.
    const autoPaused = readAutoPaused();
    if (autoPaused.length === 0) return;
    const currentIDs = new Set(folders.map((f) => f.id));
    const toResume = folders.filter(
      (f) => f.paused && autoPaused.includes(f.id),
    );
    // Prune stale entries (deleted folders) so the list doesn't grow
    // unbounded across project deletions.
    const remaining = autoPaused.filter((id) => currentIDs.has(id));
    if (toResume.length === 0) {
      if (remaining.length !== autoPaused.length) writeAutoPaused(remaining);
      return;
    }
    inflight.current = true;
    void Promise.allSettled(
      toResume.map((f) =>
        client.patchFolder(f.id, { paused: false }).catch(() => {
          /* best-effort */
        }),
      ),
    )
      .then(() => {
        // Clear the IDs we just resumed; keep any others (shouldn't
        // happen in practice but safe to be defensive).
        const resumedIDs = new Set(toResume.map((f) => f.id));
        writeAutoPaused(remaining.filter((id) => !resumedIDs.has(id)));
      })
      .finally(() => {
        inflight.current = false;
      });
  }, [cfg.data, me.data, me.isLoading, patch]);
}

export function EntitlementBanner({
  onOpenPricing,
}: {
  onOpenPricing?: () => void;
}) {
  const me = useCloudMe();
  if (!AUTH_ENABLED) return null;
  if (me.isLoading || !me.data) return null;
  if (me.data.entitled) return null;

  const onFree = me.data.tier.name === "free";
  const tierLabel = me.data.tier.displayName ?? "paid";
  const heading = onFree
    ? "Your free trial has ended"
    : `Your ${tierLabel} subscription isn't active`;
  const body = onFree
    ? "Sync is paused on every project. Upgrade to resume syncing and unlock the full project cap."
    : "Sync is paused on every project until the subscription is renewed. Reactivating it picks up exactly where you left off.";
  const cta = onFree ? "Upgrade plan" : "Renew subscription";

  return (
    <section className="mx-4 mt-3 flex flex-col gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-sm sm:flex-row sm:items-center sm:justify-between">
      <div className="min-w-0">
        <p className="font-semibold text-amber-200">{heading}</p>
        <p className="mt-0.5 text-amber-100/80">{body}</p>
      </div>
      {onOpenPricing && (
        <button
          type="button"
          onClick={onOpenPricing}
          className="shrink-0 self-start rounded-md bg-amber-500/90 px-3 py-1.5 text-xs font-semibold text-ink-900 transition-colors hover:bg-amber-400 sm:self-auto"
        >
          {cta} →
        </button>
      )}
    </section>
  );
}
