import { useConfig } from "../hooks";
import { useCloudMe } from "./hooks";
import { AUTH_ENABLED } from "../../App";

// Project quota = total projects on this device (owned + invited)
// against the tier's MaxProjects. Each synced folder consumes one
// project slot regardless of who created it, because the cap models
// resource usage on the daemon, not ownership.
//
// We branch on AUTH_ENABLED at the top into two implementations.
// React's rules-of-hooks only require that the *order* of hook calls
// is stable across renders, which holds here because AUTH_ENABLED is
// a module-level constant frozen at import time. Without this split,
// the local-only path would call useCloudMe() and crash with
// "useCloudClient called outside <CloudProvider>".

export interface ProjectQuota {
  count: number;
  // -1 = unlimited (no cap)
  max: number;
  canCreate: boolean;
  // True at >= 80% of the cap. Useful for soft-warning UI.
  nearLimit: boolean;
  // True when the Free-tier user's 1-day trial has elapsed.
  // Mutually exclusive with subscriptionInactive — exactly one of
  // the gating flags can be set when canCreate is false.
  trialExpired: boolean;
  // True when a paid-tier user's subscription is no longer active
  // (past_due / canceled / unpaid / incomplete). canCreate is
  // false but the right user-facing message is "renew your
  // subscription", NOT "at your 10-project limit" — the cap is
  // never the actual blocker in this state.
  subscriptionInactive: boolean;
  // The paid plan's name when subscriptionInactive is true, so
  // the UI can read "Your Pro subscription is inactive".
  inactiveTierLabel?: string;
  // ISO timestamp when the Free trial ends. Undefined on paid plans.
  trialEndsAt?: string;
  isLoading: boolean;
}

const UNLIMITED = -1;

export function useProjectQuota(): ProjectQuota {
  return AUTH_ENABLED ? useCloudQuota() : useLocalQuota();
}

// Used when auth is wired up. Counts all projects on this device
// (owned + invited) against the current tier's MaxProjects, AND
// gates on whether the user's plan is still entitled. A Free user
// whose 1-day trial has elapsed reads canCreate=false regardless
// of count, with trialExpired=true so the UI can show the upgrade
// pitch instead of the cap label.
function useCloudQuota(): ProjectQuota {
  const cfg = useConfig();
  const me = useCloudMe();

  const count = countAll(cfg.data?.folders);
  const max = me.data?.tier.maxProjects ?? UNLIMITED;
  const entitled = me.data?.entitled ?? true;
  const underCap = max === UNLIMITED || count < max;
  const canCreate = entitled && underCap;
  const nearLimit = max > 0 && count >= Math.floor(max * 0.8);
  // Two distinct "you can't create" reasons. Without splitting them
  // the CTA label was always reading "At your N-project limit" even
  // for a paid user whose subscription went past_due or was canceled
  // — confusing because that user might have 0 projects.
  const onFree = me.data?.tier.name === "free";
  const trialExpired = !entitled && onFree;
  const subscriptionInactive = !entitled && !onFree;

  return {
    count,
    max,
    canCreate,
    nearLimit,
    trialExpired,
    subscriptionInactive,
    inactiveTierLabel: subscriptionInactive
      ? me.data?.tier.displayName
      : undefined,
    trialEndsAt: me.data?.trialEndsAt,
    isLoading: me.isLoading,
  };
}

// Used when the frontend runs as a pure local app (no Clerk
// configured). The UI never blocks project creation and never shows
// the upsell — useful for self-hosters who just want the daemon UI.
function useLocalQuota(): ProjectQuota {
  const cfg = useConfig();
  return {
    count: countAll(cfg.data?.folders),
    max: UNLIMITED,
    canCreate: true,
    nearLimit: false,
    trialExpired: false,
    subscriptionInactive: false,
    isLoading: false,
  };
}

function countAll(folders: { id: string }[] | undefined): number {
  return folders?.length ?? 0;
}
