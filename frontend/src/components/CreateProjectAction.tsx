import { Button } from "./Button";
import { HIDE_BILLING } from "../App";
import type { ProjectQuota } from "../api/cloud/useProjectQuota";

// CreateProjectAction renders the "+ New project" CTA plus its
// surrounding context — quota label, soft warning, hard cap upsell.
// Shared between Dashboard and YourProjects so the gating logic
// lives in one place.
//
// Three states:
//   1. Unlimited (Studio tier, or no auth)  → plain button, no label
//   2. Under cap                            → button + "n of M used"
//   3. At cap                               → disabled button +
//                                             "Upgrade for more" link
//
// The button is intentionally not a full-width banner — Dashboard
// puts it in the page header, so it stays compact.

export function CreateProjectAction({
  quota,
  onCreate,
  onOpenPricing,
  label = "+ New project",
}: {
  quota: ProjectQuota;
  onCreate: () => void;
  // Optional — undefined when auth is disabled. Quota is unlimited
  // in that case so this branch is never reached.
  onOpenPricing?: () => void;
  label?: string;
}) {
  const unlimited = quota.max < 0;
  return (
    <div className="flex flex-col items-end gap-1">
      <Button
        variant="primary"
        onClick={onCreate}
        disabled={!quota.canCreate}
        title={
          quota.canCreate
            ? undefined
            : quota.trialExpired
              ? HIDE_BILLING
                ? "Your free trial has ended."
                : "Your free trial has ended. Upgrade to keep creating projects."
              : quota.subscriptionInactive
                ? `Your ${quota.inactiveTierLabel ?? "paid"} subscription isn't active. Renew it to keep creating projects.`
                : HIDE_BILLING
                  ? `Plan limit reached (${quota.max} project${quota.max === 1 ? "" : "s"}).`
                  : `Plan limit reached (${quota.max} project${quota.max === 1 ? "" : "s"}). Upgrade for more.`
        }
      >
        {label}
      </Button>
      {!unlimited && (
        <QuotaLabel quota={quota} onOpenPricing={onOpenPricing} />
      )}
    </div>
  );
}

function QuotaLabel({
  quota,
  onOpenPricing,
}: {
  quota: ProjectQuota;
  onOpenPricing?: () => void;
}) {
  // Entitlement lapses (free trial ended, subscription inactive) are
  // surfaced by the top-of-app EntitlementBanner — don't double up
  // with a smaller inline notice next to the CTA. The CTA's own
  // disabled tooltip still explains why the button is greyed out.
  if (quota.trialExpired || quota.subscriptionInactive) {
    return null;
  }
  if (!quota.canCreate) {
    if (HIDE_BILLING) {
      return (
        <span className="text-[11px] text-amber-300">
          At your {quota.max}-project limit
        </span>
      );
    }
    return (
      <span className="text-[11px] text-amber-300">
        At your {quota.max}-project limit ·{" "}
        {onOpenPricing ? (
          <button
            type="button"
            onClick={onOpenPricing}
            className="rounded text-indigo-400 hover:underline"
          >
            Upgrade →
          </button>
        ) : (
          "Upgrade for more"
        )}
      </span>
    );
  }
  return (
    <span
      className={
        "text-[11px] " +
        (quota.nearLimit ? "text-amber-400" : "text-fg-soft")
      }
    >
      {quota.count} of {quota.max} projects used
    </span>
  );
}
