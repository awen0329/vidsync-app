// PresenceAvatar: initial-based avatar with a status dot in the
// corner. Color is deterministic from the label so the same person
// gets the same hue across sessions. Used in Team rows; if you ever
// need an actual photo, this is the swap-in point.
//
// Status states map to:
//   online   — indigo dot (synced and present)
//   syncing  — amber dot, pulses (handing off data right now)
//   offline  — gray dot
//
// Avatars are intentionally small (h-8 w-8) so they don't dominate
// the row; the name to their right stays the primary read.

import { cn } from "../lib/utils";

export type PresenceState = "online" | "syncing" | "offline";

// Six muted palettes. We pick by hashing the label so the same
// collaborator gets the same swatch across sessions / refreshes.
const PALETTES = [
  "bg-indigo-500/20 text-indigo-200 ring-indigo-400/30",
  "bg-emerald-500/20 text-emerald-200 ring-emerald-400/30",
  "bg-amber-500/20 text-amber-200 ring-amber-400/30",
  "bg-violet-500/20 text-violet-200 ring-violet-400/30",
  "bg-rose-500/20 text-rose-200 ring-rose-400/30",
  "bg-cyan-500/20 text-cyan-200 ring-cyan-400/30",
];

function hashIndex(s: string, mod: number): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = (h * 31 + s.charCodeAt(i)) >>> 0;
  }
  return h % mod;
}

// initialsOf turns "anthony@example.com" → "AN", "Sarah Connor" → "SC".
// We try a name-shaped string first (two words → first letter of each);
// otherwise fall back to the first two chars of the local-part of an
// email, or just the first two chars of whatever we got.
export function initialsOf(label: string): string {
  const trimmed = (label || "").trim();
  if (!trimmed) return "?";
  const beforeAt = trimmed.includes("@") ? trimmed.split("@")[0] : trimmed;
  const words = beforeAt
    .split(/[\s._-]+/)
    .map((w) => w.trim())
    .filter(Boolean);
  if (words.length >= 2) {
    return (words[0][0] + words[1][0]).toUpperCase();
  }
  return beforeAt.slice(0, 2).toUpperCase();
}

export function PresenceAvatar({
  label,
  state,
}: {
  label: string;
  state: PresenceState;
}) {
  const palette = PALETTES[hashIndex(label.toLowerCase(), PALETTES.length)];
  const dot =
    state === "online"
      ? "bg-indigo-400"
      : state === "syncing"
        ? "bg-amber-400 animate-pulse"
        : "bg-fg-faint";
  return (
    <span className="relative inline-flex shrink-0">
      <span
        className={cn(
          "flex h-8 w-8 items-center justify-center rounded-full text-[11px] font-semibold ring-1",
          palette,
        )}
        aria-hidden
      >
        {initialsOf(label)}
      </span>
      <span
        className={cn(
          "absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 rounded-full ring-2 ring-elevated",
          dot,
        )}
        title={state}
        aria-label={state}
      />
    </span>
  );
}
