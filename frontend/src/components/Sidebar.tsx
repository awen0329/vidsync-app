import { useEffect, useState } from "react";
import { AUTH_ENABLED, HIDE_BILLING } from "../App";
import { useBearerAuth } from "../api/bearerAuth";
import { useAccountEmail, useRevokeCurrentSession } from "../api/cloud/hooks";
import { cn } from "../lib/utils";
import { VidSyncLogo } from "./VidSyncLogo";
import { DropboxGlyph } from "./DropboxGlyph";
import { dropboxAvailable, dropboxConnect, dropboxDisconnect } from "../lib/dropbox";
import { useDropboxAccount, refreshDropboxAccount } from "./useDropboxAccount";
import { pushToast } from "../lib/toast";

// Persisted collapse state. The rail shrinks to an icon-only strip so
// the user can reclaim horizontal space for the project file tree /
// content area; the choice sticks across launches.
const COLLAPSE_KEY = "vidsync.sidebarCollapsed";

function loadCollapsed(): boolean {
  try {
    return localStorage.getItem(COLLAPSE_KEY) === "true";
  } catch {
    return false;
  }
}

// Sidebar: navigation-only left rail. Iconik / Frame.io shape — brand
// at top, primary destinations underneath, a flex spacer, then
// account-flavored actions at the bottom. Project lists and detail
// content never live in here; they belong in the main area.

export type Section =
  | "projects"
  | "transfers"
  | "invitations"
  | "activity"
  | "billing";

interface NavItem {
  id: Section;
  label: string;
  icon: React.ReactNode;
  authOnly?: boolean;
}

export function Sidebar({
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
  const top: NavItem[] = [
    { id: "projects", label: "Projects", icon: <FolderIcon /> },
    { id: "invitations", label: "Invitations", icon: <MailIcon /> },
    { id: "transfers", label: "Transfers", icon: <TransferIcon /> },
    { id: "activity", label: "Activity", icon: <PulseIcon /> },
  ];
  const bottom: NavItem[] =
    AUTH_ENABLED && !HIDE_BILLING
      ? [{ id: "billing", label: "Billing", icon: <BillingIcon />, authOnly: true }]
      : [];

  const [collapsed, setCollapsed] = useState(loadCollapsed);
  useEffect(() => {
    try {
      localStorage.setItem(COLLAPSE_KEY, String(collapsed));
    } catch {
      // localStorage disabled / full — non-fatal, just don't persist.
    }
  }, [collapsed]);

  return (
    <aside
      className={cn(
        "flex h-full shrink-0 flex-col border-r border-line bg-panel transition-[width] duration-200",
        collapsed ? "w-[60px]" : "w-[220px]",
      )}
    >
      <div
        className={cn(
          "flex items-center pb-2 pt-5",
          collapsed ? "justify-center px-2" : "justify-between px-5",
        )}
      >
        <Brand collapsed={collapsed} />
        {!collapsed && (
          <CollapseButton collapsed={collapsed} onClick={() => setCollapsed((c) => !c)} />
        )}
      </div>
      {collapsed && (
        <div className="flex justify-center pb-1">
          <CollapseButton collapsed={collapsed} onClick={() => setCollapsed((c) => !c)} />
        </div>
      )}

      <nav
        className={cn(
          "flex flex-1 flex-col gap-0.5 py-4",
          collapsed ? "px-2" : "px-3",
        )}
      >
        {top.map((item) => (
          <NavRow
            key={item.id}
            item={item}
            active={section === item.id}
            collapsed={collapsed}
            badge={
              item.id === "invitations"
                ? pendingCount
                : item.id === "transfers"
                  ? transferCount
                  : 0
            }
            onClick={() => onSection(item.id)}
          />
        ))}
      </nav>

      <div
        className={cn(
          "flex flex-col gap-0.5 border-t border-line py-4",
          collapsed ? "px-2" : "px-3",
        )}
      >
        <DropboxNavButton collapsed={collapsed} />
        {bottom.map((item) => (
          <NavRow
            key={item.id}
            item={item}
            active={section === item.id}
            collapsed={collapsed}
            onClick={() => onSection(item.id)}
          />
        ))}
        <button
          type="button"
          onClick={onOpenSettings}
          title={collapsed ? "Settings" : undefined}
          className={cn(
            "flex items-center gap-3 rounded-lg py-2 text-sm font-medium text-fg-soft transition-colors hover:bg-hover hover:text-fg-strong",
            collapsed ? "justify-center px-0" : "px-3",
          )}
        >
          <SettingsIcon />
          {!collapsed && <span>Settings</span>}
        </button>
        {AUTH_ENABLED && <AccountRow collapsed={collapsed} />}
      </div>
    </aside>
  );
}

// DropboxNavButton lets the user connect (or disconnect) their own Dropbox
// account, account-wide, from the sidebar — the prerequisite for turning on
// per-project backup. Hidden outside the desktop host. Shows a green glyph
// when connected.
function DropboxNavButton({ collapsed }: { collapsed: boolean }) {
  const acct = useDropboxAccount();
  const [busy, setBusy] = useState(false);

  if (!dropboxAvailable()) return null;
  // `configured` reflects whether this build has the Dropbox app credentials.
  // Until they're set, the button is shown but disabled so the user knows the
  // feature exists and why it's not yet actionable.
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

  const label = connected ? "Dropbox" : "Connect Dropbox";
  const title = collapsed
    ? label
    : !configured
      ? "Dropbox isn't configured on this build yet (missing Dropbox app credentials)"
      : connected
        ? `Connected${acct?.email ? ` as ${acct.email}` : ""} — click to disconnect`
        : "Connect your Dropbox account";

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={cn(
        "relative flex items-center rounded-lg py-2 text-sm font-medium transition-colors",
        collapsed ? "justify-center px-0" : "gap-3 px-3",
        disabled
          ? "cursor-not-allowed text-fg-faint opacity-60"
          : "text-fg-soft hover:bg-hover hover:text-fg-strong",
      )}
    >
      <span className="shrink-0">
        <DropboxGlyph
          className={cn("h-[18px] w-[18px]", connected && "text-emerald-400")}
        />
      </span>
      {!collapsed && <span className="flex-1 text-left">{label}</span>}
    </button>
  );
}

// CollapseButton toggles the rail between full and icon-only. A
// chevron that points the direction the rail will move when clicked.
function CollapseButton({
  collapsed,
  onClick,
}: {
  collapsed: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
      title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
      className="flex h-7 w-7 items-center justify-center rounded-md text-fg-soft transition-colors hover:bg-hover hover:text-fg-strong"
    >
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        className={cn("h-4 w-4 transition-transform", collapsed && "rotate-180")}
        aria-hidden
      >
        <path d="m15 6-6 6 6 6" />
      </svg>
    </button>
  );
}

// AccountRow: avatar-style chip + Sign out button. Replaces Clerk's
// <UserButton> in the desktop app — the embedded sign-in widget can't
// run against production Clerk (origin restriction), so the only
// account action available in the desktop is "Sign out", which wipes
// the local bearer token. The user can manage their account on
// thevidsync.com.
function AccountRow({ collapsed }: { collapsed: boolean }) {
  const { signOut } = useBearerAuth();
  const revoke = useRevokeCurrentSession();
  const email = useAccountEmail();
  const initial = (email[0] ?? "?").toUpperCase();

  // Sign-out is server-revoke first, then wipe-local. We swallow
  // revoke errors (network down, server gone) so a flaky control plane
  // doesn't trap the user in a signed-in UI on their own machine —
  // the local-only ClearAuthToken always runs.
  const handleSignOut = async () => {
    try {
      await revoke.mutateAsync();
    } catch {
      // ignore; sign out locally anyway
    }
    signOut();
  };

  // Collapsed: just the avatar chip, which doubles as the sign-out
  // button (tooltip explains it) so the account area stays a single
  // centered glyph matching the nav icons.
  if (collapsed) {
    return (
      <button
        type="button"
        onClick={handleSignOut}
        disabled={revoke.isPending}
        title={`${email || "Signed in"} — sign out`}
        className="mx-auto mt-1 flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-indigo-500/20 text-xs font-semibold text-indigo-200 ring-1 ring-indigo-500/40 transition-opacity hover:opacity-80 disabled:opacity-60"
      >
        {initial}
      </button>
    );
  }

  return (
    <div
      className="mt-1 flex items-center gap-3 rounded-lg px-3 py-2"
      title={email || undefined}
    >
      <span
        className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-indigo-500/20 text-xs font-semibold text-indigo-200 ring-1 ring-indigo-500/40"
        aria-hidden
      >
        {initial}
      </span>
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-xs text-fg-strong">
          {email || "Signed in"}
        </span>
        <button
          type="button"
          onClick={handleSignOut}
          disabled={revoke.isPending}
          className="text-left text-[11px] text-fg-soft hover:text-fg-strong disabled:opacity-60"
        >
          {revoke.isPending ? "Signing out…" : "Sign out"}
        </button>
      </div>
    </div>
  );
}

function NavRow({
  item,
  active,
  badge = 0,
  collapsed,
  onClick,
}: {
  item: NavItem;
  active: boolean;
  badge?: number;
  collapsed: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      // Tooltip carries the label (and any pending count) when the rail
      // is collapsed and the text is hidden.
      title={collapsed ? (badge > 0 ? `${item.label} (${badge})` : item.label) : undefined}
      className={cn(
        "relative flex items-center rounded-lg py-2 text-sm font-medium transition-colors",
        collapsed ? "justify-center px-0" : "gap-3 px-3",
        active
          ? "bg-accent/15 text-accent"
          : "text-fg-soft hover:bg-hover hover:text-fg-strong",
      )}
    >
      <span className="shrink-0">{item.icon}</span>
      {!collapsed && <span className="flex-1 text-left">{item.label}</span>}
      {badge > 0 &&
        (collapsed ? (
          // Compact dot anchored to the icon corner — no room for the
          // numeric pill in icon-only mode.
          <span className="absolute right-1 top-1 h-2 w-2 rounded-full bg-accent ring-2 ring-panel" />
        ) : (
          <span className="rounded-full bg-accent px-2 py-0.5 text-[10px] font-semibold text-accent-fg">
            {badge}
          </span>
        ))}
    </button>
  );
}

function Brand({ collapsed }: { collapsed: boolean }) {
  return (
    <div className="flex items-center gap-2.5" title={collapsed ? "VidSync" : undefined}>
      <VidSyncLogo className="h-9 w-9 shrink-0 text-fg-strong" />
      {!collapsed && (
        <span className="text-base font-semibold tracking-tight text-fg-strong">
          VidSync
        </span>
      )}
    </div>
  );
}

// --- icon set (lucide-style, hand-traced to skip the dependency) ---

function FolderIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="h-[18px] w-[18px]"
      aria-hidden
    >
      <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z" />
    </svg>
  );
}

function MailIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="h-[18px] w-[18px]"
      aria-hidden
    >
      <rect x="3" y="5" width="18" height="14" rx="2" />
      <path d="m3 7 9 6 9-6" />
    </svg>
  );
}

function TransferIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="h-[18px] w-[18px]"
      aria-hidden
    >
      <path d="M17 3l4 4-4 4" />
      <path d="M3 7h18" />
      <path d="M7 21l-4-4 4-4" />
      <path d="M21 17H3" />
    </svg>
  );
}

function PulseIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="h-[18px] w-[18px]"
      aria-hidden
    >
      <path d="M22 12h-4l-3 9L9 3l-3 9H2" />
    </svg>
  );
}

function BillingIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="h-[18px] w-[18px]"
      aria-hidden
    >
      <rect x="2" y="6" width="20" height="13" rx="2" />
      <path d="M2 11h20" />
    </svg>
  );
}

function SettingsIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="h-[18px] w-[18px]"
      aria-hidden
    >
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  );
}
