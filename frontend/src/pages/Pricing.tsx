import { useState } from "react";
import {
  useCloudMe,
  useCloudTiers,
  useOpenPortal,
  useStartCheckout,
} from "../api/cloud/hooks";
import type { Tier } from "../api/cloud/client";

// Pricing: the standalone plan-comparison + checkout page. The
// AccountPanel inside Settings shows the *current* plan and a manage
// button; everything related to picking/changing plans lives here so
// users can compare side-by-side.
//
// Behavior:
//   - Free tier always shows as the baseline ("Current" if user is
//     on Free, otherwise "Included with paid tiers" for clarity).
//   - Paid tiers offer monthly + yearly Checkout buttons. The
//     currently active paid tier swaps both buttons for one "Manage
//     subscription" CTA (Stripe Customer Portal).
//   - Hidden behind AUTH_ENABLED at the App.tsx level — this page
//     never renders without Clerk + cloud configured.

type Interval = "monthly" | "yearly";

export function Pricing() {
  const me = useCloudMe();
  const tiers = useCloudTiers();
  const checkout = useStartCheckout();
  const portal = useOpenPortal();
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const currentName = me.data?.tier.name ?? "free";
  const isOnPaid = currentName !== "free";

  async function pick(tier: "pro" | "studio", interval: Interval) {
    const key = `${tier}-${interval}`;
    setBusyKey(key);
    setErr(null);
    try {
      const { url } = await checkout.mutateAsync({ tier, interval });
      // Stay in-window: navigate the embedded WebView2 to Stripe.
      // Stripe's configured success/cancel URLs point back at
      // wails.localhost, and App.tsx persists the current view to
      // localStorage so we land back on Billing after the round-trip.
      window.location.assign(url);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      setBusyKey(null);
    }
  }

  async function manage() {
    setBusyKey("portal");
    setErr(null);
    try {
      const { url } = await portal.mutateAsync();
      window.location.assign(url);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      setBusyKey(null);
    }
  }

  return (
    <div className="h-full overflow-y-auto px-6 py-8">
      <header className="mx-auto mb-8 max-w-3xl text-center">
        <h1 className="text-3xl font-semibold text-fg-strong">
          Choose your plan
        </h1>
        <p className="mt-2 text-sm text-fg-soft">
          Every plan includes the same P2P sync engine. Paid tiers unlock
          more projects on this device. Switching machines always
          requires email verification — no shared keys, no SaaS storage.
        </p>
      </header>

      {tiers.isLoading ? (
        <p className="text-center text-sm text-fg-soft">Loading plans…</p>
      ) : tiers.isError ? (
        <p className="mx-auto max-w-md rounded-md border border-rose-500/30 bg-rose-500/5 px-4 py-3 text-center text-sm text-rose-300">
          Couldn't load pricing: {(tiers.error as Error)?.message}
        </p>
      ) : (
        <div className="mx-auto grid max-w-5xl gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {(tiers.data?.tiers ?? []).map((t) => (
            <PlanCard
              key={t.name}
              tier={t}
              isCurrent={t.name === currentName}
              isOnPaid={isOnPaid}
              busyKey={busyKey}
              onPick={pick}
              onManage={manage}
            />
          ))}
        </div>
      )}

      {err && (
        <p className="mx-auto mt-6 max-w-md text-center text-sm text-rose-400">
          {err}
        </p>
      )}
    </div>
  );
}

function PlanCard({
  tier,
  isCurrent,
  isOnPaid,
  busyKey,
  onPick,
  onManage,
}: {
  tier: Tier;
  isCurrent: boolean;
  isOnPaid: boolean;
  busyKey: string | null;
  onPick: (t: "pro" | "studio", interval: Interval) => void;
  onManage: () => void;
}) {
  const isFree = tier.name === "free";
  const highlight = tier.name === "pro";
  const anyBusy = busyKey !== null;

  return (
    <div
      className={
        "relative flex flex-col rounded-lg border p-6 " +
        (highlight
          ? "border-indigo-500/40 bg-indigo-500/5 shadow-lg shadow-indigo-500/5"
          : "border-line-strong bg-panel/40")
      }
    >
      {highlight && (
        <span className="absolute -top-2.5 left-6 rounded-full bg-indigo-500 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-fg-strong">
          Popular
        </span>
      )}
      {isCurrent && (
        <span className="absolute -top-2.5 right-6 rounded-full border border-indigo-400 bg-base px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-indigo-300">
          Current
        </span>
      )}
      <h2 className="mb-1 text-lg font-semibold text-fg-strong">
        {tier.displayName}
      </h2>
      <PriceLabel tier={tier} />
      <ul className="mt-4 space-y-1.5 text-sm text-fg">
        <Feature>
          <span className="font-medium">
            {tier.maxProjects < 0
              ? "Unlimited projects"
              : `${tier.maxProjects} project${tier.maxProjects === 1 ? "" : "s"}`}
            {tier.maxDays > 0 && (
              <>
                {" "}
                <span className="font-normal text-fg-soft">
                  ({tier.maxDays}-day trial)
                </span>
              </>
            )}
          </span>
        </Feature>
        <Feature>1 active computer, transferable by email code</Feature>
        <Feature>Direct peer-to-peer sync — no cloud storage</Feature>
        <Feature>Version history and conflict tracking built in</Feature>
        {tier.name === "studio" && (
          <Feature>Priority email support</Feature>
        )}
      </ul>

      <div className="mt-6 space-y-2">
        {isFree ? (
          <p className="rounded border border-line-strong px-3 py-2 text-center text-xs text-fg-soft">
            {isCurrent
              ? "You're on the Free plan."
              : "Free tier is always available."}
          </p>
        ) : isCurrent ? (
          <button
            type="button"
            onClick={onManage}
            disabled={anyBusy}
            className="w-full rounded-md border border-indigo-500/40 bg-indigo-500/10 px-4 py-2 text-sm font-medium text-indigo-300 hover:bg-indigo-500/15 disabled:opacity-50"
          >
            {busyKey === "portal" ? "Opening…" : "Manage subscription"}
          </button>
        ) : (
          <>
            <button
              type="button"
              onClick={() => onPick(tier.name as "pro" | "studio", "monthly")}
              disabled={anyBusy || isOnPaid || tier.monthlyCents === 0}
              className="w-full rounded-md border border-line bg-elevated px-4 py-2 text-sm text-fg-strong hover:bg-hover disabled:opacity-50"
            >
              {busyKey === `${tier.name}-monthly`
                ? "Opening…"
                : `Subscribe · $${(tier.monthlyCents / 100).toFixed(0)}/mo`}
            </button>
            <button
              type="button"
              onClick={() => onPick(tier.name as "pro" | "studio", "yearly")}
              disabled={anyBusy || isOnPaid || tier.yearlyCents === 0}
              className={
                "w-full rounded-md px-4 py-2 text-sm font-medium disabled:opacity-50 " +
                (highlight
                  ? "bg-indigo-600 text-white hover:bg-indigo-500"
                  : "border border-indigo-500/40 bg-indigo-500/10 text-indigo-300 hover:bg-indigo-500/15")
              }
            >
              {busyKey === `${tier.name}-yearly`
                ? "Opening…"
                : `Subscribe · $${(tier.yearlyCents / 100).toFixed(0)}/yr`}
            </button>
            {isOnPaid && (
              <p className="text-center text-[11px] text-fg-soft">
                Use "Manage" on your current plan to switch.
              </p>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function PriceLabel({ tier }: { tier: Tier }) {
  if (tier.monthlyCents === 0 && tier.yearlyCents === 0) {
    return (
      <div className="text-3xl font-bold text-fg-strong">
        $0
        <span className="ml-1 text-sm font-normal text-fg-soft">forever</span>
      </div>
    );
  }
  const monthly = (tier.monthlyCents / 100).toFixed(0);
  const yearlyMonthly = (tier.yearlyCents / 100 / 12).toFixed(0);
  return (
    <div>
      <div className="text-3xl font-bold text-fg-strong">
        ${monthly}
        <span className="ml-1 text-sm font-normal text-fg-soft">/ month</span>
      </div>
      {tier.yearlyCents > 0 && (
        <div className="mt-1 text-xs text-indigo-400">
          ${yearlyMonthly}/mo billed yearly · 2 months free
        </div>
      )}
    </div>
  );
}

function Feature({ children }: { children: React.ReactNode }) {
  return (
    <li className="flex items-start gap-2">
      <svg
        className="mt-0.5 h-4 w-4 shrink-0 text-indigo-400"
        viewBox="0 0 20 20"
        fill="currentColor"
        aria-hidden
      >
        <path
          fillRule="evenodd"
          d="M16.704 5.296a1 1 0 010 1.408l-7.999 8a1 1 0 01-1.412 0l-3.997-4a1 1 0 111.414-1.414L8 12.583l7.295-7.287a1 1 0 011.41 0z"
          clipRule="evenodd"
        />
      </svg>
      <span>{children}</span>
    </li>
  );
}
