// Small formatting helpers for the player UI.

// formatClock turns seconds into M:SS (or MM:SS / H:MM:SS for longer
// videos). NaN/Infinity (before metadata loads) render as "0:00".
export function formatClock(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) seconds = 0;
  const total = Math.floor(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const ss = String(s).padStart(2, "0");
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${ss}`;
  return `${m}:${ss}`;
}

// formatTimecodeMs renders seconds as a millisecond-precise timecode:
// "MM:SS.mmm" (or "H:MM:SS.mmm" past an hour). Used by the range editor where
// the user needs to read and set in/out points down to the millisecond.
export function formatTimecodeMs(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) seconds = 0;
  const totalMs = Math.round(seconds * 1000);
  const h = Math.floor(totalMs / 3_600_000);
  const m = Math.floor((totalMs % 3_600_000) / 60_000);
  const s = Math.floor((totalMs % 60_000) / 1000);
  const ms = totalMs % 1000;
  const mm = String(m).padStart(2, "0");
  const ss = String(s).padStart(2, "0");
  const mmm = String(ms).padStart(3, "0");
  if (h > 0) return `${h}:${mm}:${ss}.${mmm}`;
  return `${mm}:${ss}.${mmm}`;
}

// parseTimecodeMs parses a typed timecode back into seconds. Accepts
// "H:MM:SS.mmm", "MM:SS.mmm", "SS.mmm", or a bare seconds number; the
// fractional part (after "." or ",") is read as milliseconds. Returns null on
// anything unparseable so the caller can revert the field.
export function parseTimecodeMs(input: string): number | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  const [clock, frac] = trimmed.split(/[.,]/);
  const parts = (clock ?? "").split(":").map((p) => p.trim());
  if (parts.length > 3) return null;
  if (parts.some((p) => p !== "" && !/^\d+$/.test(p))) return null;
  const nums = parts.map((p) => Number(p || 0));
  let secs: number;
  if (nums.length === 1) secs = nums[0];
  else if (nums.length === 2) secs = nums[0] * 60 + nums[1];
  else secs = nums[0] * 3600 + nums[1] * 60 + nums[2];
  if (frac !== undefined && frac !== "") {
    if (!/^\d+$/.test(frac)) return null;
    secs += Number((frac + "000").slice(0, 3)) / 1000;
  }
  return Number.isFinite(secs) ? secs : null;
}

// formatRange renders a point ("0:32") or a duration ("0:32 – 0:38")
// timecode, mirroring the in→out display in the reference review UIs.
export function formatRange(t: number, tEnd?: number): string {
  if (tEnd !== undefined && tEnd > t) {
    return `${formatClock(t)} – ${formatClock(tEnd)}`;
  }
  return formatClock(t);
}

// formatRelative renders a compact "time ago" like the review UI: "now",
// "1min", "2h", "3d". Falls back to "" for an unparseable date.
export function formatRelative(iso: string, now: number = Date.now()): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "";
  const secs = Math.max(0, Math.round((now - then) / 1000));
  if (secs < 45) return "now";
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${Math.max(1, mins)}min`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.round(hours / 24);
  return `${days}d`;
}

// displayName derives a human label from an email when no name is set:
// "brian.edington@x.com" → "Brian Edington".
export function displayName(name: string | undefined, email: string): string {
  const trimmed = (name ?? "").trim();
  if (trimmed) return trimmed;
  const local = email.includes("@") ? email.split("@")[0] : email;
  const words = local.split(/[._-]+/).filter(Boolean);
  if (words.length === 0) return email || "You";
  return words.map((w) => w[0].toUpperCase() + w.slice(1)).join(" ");
}
