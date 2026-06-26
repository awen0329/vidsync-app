import { useEffect, useRef, useState } from "react";
import { AUTH_ENABLED, HIDE_BILLING } from "../App";
import { useBearerAuth } from "../api/bearerAuth";
import { useAccountEmail, useRevokeCurrentSession } from "../api/cloud/hooks";
import { dropboxAvailable, dropboxConnect, dropboxDisconnect } from "../lib/dropbox";
import { useDropboxAccount, refreshDropboxAccount } from "./useDropboxAccount";
import { openExternal } from "../lib/openExternal";
import { pushToast } from "../lib/toast";
import { VidSyncLogo } from "./VidSyncLogo";
import { DropboxGlyph } from "./DropboxGlyph";
import { cn } from "../lib/utils";
import type { Section } from "./Sidebar";

// NavRail: the slim 64px icon rail — col 1 of the Frame.io-style shell.
// Brand/Home at the top, primary destinations under it, and account-
// flavored actions (Help / Billing / Dropbox / Profile) pinned to the
// bottom. Project lists live in the ProjectsNav beside it, never here.
//
// The Profile button opens a small popover carrying the actions the old
// wide Sidebar exposed inline (Settings, Sign out) — the rail trades the
// text labels for icons, so those move into the menu.

const FAQ_URL = "https://thevidsync.com/faq";

export function NavRail({
  section,
  onSection,
  onOpenSettings,
  pendingCount,
  transferCount,
}: {
  section: Section;
  onSection: (s: Section) => void;
  onOpenSettings: () => void;
  pendingCount: number;
  transferCount: number;
}) {
  return (
    <nav className="flex w-[60px] shrink-0 flex-col items-center rounded-xl border border-line bg-rail py-4">
      <button
        type="button"
        onClick={() => onSection("projects")}
        title="Home"
        aria-label="Home"
        className="mb-5 flex h-10 w-10 items-center justify-center rounded-xl ring-1 ring-line transition-transform hover:scale-105"
      >
        <VidSyncLogo className="h-7 w-7" />
      </button>

      <div className="flex flex-1 flex-col items-center gap-1.5">
        <RailButton
          label="Search"
          active={false}
          onClick={() => onSection("projects")}
        >
          <SearchIcon />
        </RailButton>
        <RailButton
          label="Notifications"
          active={section === "invitations"}
          badge={pendingCount}
          onClick={() => onSection("invitations")}
        >
          <BellIcon />
        </RailButton>
        <RailButton
          label="Transfers"
          active={section === "transfers"}
          badge={transferCount}
          badgeTone="accent"
          onClick={() => onSection("transfers")}
        >
          <TransferIcon />
        </RailButton>
        <RailButton
          label="Activity"
          active={section === "activity"}
          onClick={() => onSection("activity")}
        >
          <PulseIcon />
        </RailButton>
      </div>

      <div className="flex flex-col items-center gap-2">
        <RailButton label="Help & FAQ" active={false} onClick={() => openExternal(FAQ_URL)}>
          <HelpIcon />
        </RailButton>
        {AUTH_ENABLED && !HIDE_BILLING && (
          <RailButton
            label="Billing"
            active={section === "billing"}
            onClick={() => onSection("billing")}
          >
            <BillingIcon />
          </RailButton>
        )}
        <DropboxRailButton />
        {AUTH_ENABLED ? (
          <ProfileMenu onOpenSettings={onOpenSettings} />
        ) : (
          <RailButton label="Settings" active={false} onClick={onOpenSettings}>
            <SettingsIcon />
          </RailButton>
        )}
      </div>
    </nav>
  );
}

function RailButton({
  children,
  label,
  active,
  badge = 0,
  badgeTone = "rose",
  onClick,
}: {
  children: React.ReactNode;
  label: string;
  active: boolean;
  badge?: number;
  badgeTone?: "rose" | "accent";
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={badge > 0 ? `${label} (${badge})` : label}
      aria-label={label}
      className={cn(
        "relative flex h-10 w-10 items-center justify-center rounded-xl transition-colors",
        active
          ? "bg-accent/15 text-accent"
          : "text-fg-soft hover:bg-hover hover:text-fg-strong",
      )}
    >
      {active && (
        <span className="absolute left-0 h-5 w-[3px] -translate-x-3 rounded-full bg-accent" aria-hidden />
      )}
      {children}
      {badge > 0 && (
        <span
          className={cn(
            "absolute right-1.5 top-1.5 h-2 w-2 rounded-full ring-2 ring-rail",
            badgeTone === "accent" ? "bg-accent" : "bg-rose-500",
          )}
          aria-hidden
        />
      )}
    </button>
  );
}

// DropboxRailButton mirrors the old Sidebar.DropboxNavButton but icon-only:
// connect (or disconnect) the account-wide Dropbox link that powers
// per-project backup. Hidden outside the desktop host; green when linked.
function DropboxRailButton() {
  const acct = useDropboxAccount();
  const [busy, setBusy] = useState(false);

  if (!dropboxAvailable()) return null;
  const configured = acct?.configured ?? false;
  const connected = acct?.connected ?? false;
  const disabled = busy || !configured;

  const onClick = async () => {
    if (!configured) return;
    setBusy(true);
    try {
      if (connected) {
        const ok = window.confirm(
          "Disconnect Dropbox? Project backups will pause until you reconnect.",
        );
        if (!ok) return;
        await dropboxDisconnect();
      } else {
        await dropboxConnect();
      }
      await refreshDropboxAccount();
    } catch (e) {
      pushToast({
        title: "Dropbox",
        body: e instanceof Error ? e.message : String(e),
      });
    } finally {
      setBusy(false);
    }
  };

  const title = !configured
    ? "Dropbox isn't configured on this build yet"
    : connected
      ? `Connected${acct?.email ? ` as ${acct.email}` : ""} — click to disconnect`
      : "Connect your Dropbox account";

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      aria-label={connected ? "Dropbox connected" : "Connect Dropbox"}
      className={cn(
        "flex h-10 w-10 items-center justify-center rounded-xl transition-colors",
        disabled
          ? "cursor-not-allowed text-fg-faint opacity-60"
          : connected
            ? "text-emerald-400 hover:bg-hover"
            : "text-fg-soft hover:bg-hover hover:text-fg-strong",
      )}
    >
      <DropboxGlyph className="h-[18px] w-[18px]" />
    </button>
  );
}

// ProfileMenu: the avatar chip + a popover that carries the account
// actions the wide Sidebar used to render inline. Settings and Sign out
// both live here now that the rail is icon-only.
function ProfileMenu({ onOpenSettings }: { onOpenSettings: () => void }) {
  const { signOut } = useBearerAuth();
  const revoke = useRevokeCurrentSession();
  const email = useAccountEmail();
  const initial = (email[0] ?? "?").toUpperCase();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const handleSignOut = async () => {
    setOpen(false);
    try {
      await revoke.mutateAsync();
    } catch {
      // ignore; sign out locally anyway
    }
    signOut();
  };

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        title={email || "Account"}
        aria-label="Account menu"
        className="mt-1 flex h-8 w-8 items-center justify-center rounded-full bg-accent/20 text-xs font-semibold text-accent ring-1 ring-accent/40 transition-opacity hover:opacity-80"
      >
        {initial}
      </button>
      {open && (
        <div className="absolute bottom-0 left-12 z-50 w-56 overflow-hidden rounded-xl border border-line-strong bg-elevated shadow-2xl shadow-black/60">
          <div className="border-b border-line px-4 py-3">
            <div className="truncate text-sm font-medium text-fg-strong">
              {email || "Signed in"}
            </div>
            <div className="text-[11px] text-fg-faint">VidSync account</div>
          </div>
          <div className="p-1.5">
            <button
              type="button"
              onClick={() => {
                setOpen(false);
                onOpenSettings();
              }}
              className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm text-fg transition-colors hover:bg-hover hover:text-fg-strong"
            >
              <SettingsIcon className="h-4 w-4" />
              Settings
            </button>
            <button
              type="button"
              onClick={handleSignOut}
              disabled={revoke.isPending}
              className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm text-fg transition-colors hover:bg-hover hover:text-fg-strong disabled:opacity-60"
            >
              <SignOutIcon />
              {revoke.isPending ? "Signing out…" : "Sign out"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// --- icons (lucide-style, hand-traced) ---

function SearchIcon() {
  return (
    <svg viewBox="0 0 20 20" fill="none" className="h-[19px] w-[19px]" aria-hidden>
      <circle cx="9" cy="9" r="6" stroke="currentColor" strokeWidth="1.9" />
      <path d="m17 17-4.35-4.35" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" />
    </svg>
  );
}

function BellIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" className="h-[19px] w-[19px]" aria-hidden>
      <path d="M6 9a6 6 0 1 1 12 0c0 4 1.5 5 2 6H4c.5-1 2-2 2-6zM9.5 19a2.5 2.5 0 0 0 5 0" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function TransferIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" className="h-[19px] w-[19px]" aria-hidden>
      <path d="M8 17V5m0 12-3-3m3 3 3-3M16 7v12m0-12 3 3m-3-3-3 3" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function PulseIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" className="h-[19px] w-[19px]" aria-hidden>
      <path d="M22 12h-4l-3 9L9 3l-3 9H2" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function HelpIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" className="h-[19px] w-[19px]" aria-hidden>
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="1.7" />
      <path d="M9.5 9a2.5 2.5 0 1 1 3.5 2.3c-.7.3-1 .8-1 1.7M12 16h.01" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
    </svg>
  );
}

function BillingIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" className="h-[19px] w-[19px]" aria-hidden>
      <rect x="2.5" y="6" width="19" height="12" rx="2" stroke="currentColor" strokeWidth="1.7" />
      <path d="M2.5 10h19" stroke="currentColor" strokeWidth="1.7" />
    </svg>
  );
}

function SettingsIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={className ?? "h-[19px] w-[19px]"} aria-hidden>
      <circle cx="12" cy="12" r="3" stroke="currentColor" strokeWidth="1.8" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" stroke="currentColor" strokeWidth="1.4" />
    </svg>
  );
}

function SignOutIcon() {
  return (
    <svg viewBox="0 0 20 20" fill="currentColor" className="h-4 w-4" aria-hidden>
      <path fillRule="evenodd" d="M3 4a1 1 0 0 1 1-1h6a1 1 0 1 1 0 2H5v10h5a1 1 0 1 1 0 2H4a1 1 0 0 1-1-1V4zm10.293 2.293a1 1 0 0 1 1.414 0l3 3a1 1 0 0 1 0 1.414l-3 3a1 1 0 0 1-1.414-1.414L14.586 11H8a1 1 0 1 1 0-2h6.586l-1.293-1.293a1 1 0 0 1 0-1.414z" clipRule="evenodd" />
    </svg>
  );
}
