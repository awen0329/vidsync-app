// Human-readable formatters for bytes, rates, durations, and relative
// timestamps. Kept tiny so it can be imported anywhere without pulling
// in date-fns or numeral.js.

export function humanBytes(n: number | undefined | null): string {
  if (n === undefined || n === null || Number.isNaN(n)) return "—";
  if (n < 1024) return `${Math.round(n)} B`;
  const units = ["KiB", "MiB", "GiB", "TiB", "PiB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(1)} ${units[i]}`;
}

// Rates below this are treated as idle. The daemon's TLS keepalives
// produce ~1–10 B/s per peer, which is visually noisy and not useful.
const RATE_NOISE_FLOOR_BPS = 100;

// humanRate formats a throughput in *bits per second* (bps / Kbps /
// Mbps / Gbps) — the familiar "what's my internet speed" unit.
// Input is bytes/sec because that's what the daemon reports; we
// multiply by 8 here so callers don't have to. Decimal prefixes (1000)
// per ISP and network-equipment convention, not the binary 1024 used
// for file sizes.
export function humanRate(bytesPerSec: number | undefined | null): string {
  if (
    bytesPerSec === undefined ||
    bytesPerSec === null ||
    Number.isNaN(bytesPerSec) ||
    bytesPerSec < RATE_NOISE_FLOOR_BPS
  ) {
    return "0 bps";
  }
  const bps = bytesPerSec * 8;
  if (bps < 1000) return `${Math.round(bps)} bps`;
  if (bps < 1_000_000) return `${(bps / 1000).toFixed(1)} Kbps`;
  if (bps < 1_000_000_000) return `${(bps / 1_000_000).toFixed(1)} Mbps`;
  return `${(bps / 1_000_000_000).toFixed(2)} Gbps`;
}

export function isActiveRate(bytesPerSec: number | undefined | null): boolean {
  return (
    bytesPerSec !== undefined &&
    bytesPerSec !== null &&
    !Number.isNaN(bytesPerSec) &&
    bytesPerSec >= RATE_NOISE_FLOOR_BPS
  );
}

// humanRuntime formats a clip-roll runtime tightly for a stat card:
// "4h 12m", "47m", "2d 4h". Always two-segment so the column width is
// stable — humanDuration's "0s" tail leaks for short clips which looks
// twitchy on a fixed-size headline number.
export function humanRuntime(seconds: number | undefined | null): string {
  if (seconds === undefined || seconds === null || !Number.isFinite(seconds) || seconds <= 0) {
    return "0";
  }
  const s = Math.floor(seconds);
  const days = Math.floor(s / 86400);
  const hours = Math.floor((s % 86400) / 3600);
  const minutes = Math.floor((s % 3600) / 60);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m`;
  return "<1m";
}

// humanDuration formats a number of seconds as e.g. "1h 23m", "8m 12s",
// "42s". Returns "—" for unknown / non-finite, "<1s" for tiny.
export function humanDuration(seconds: number | undefined | null): string {
  if (
    seconds === undefined ||
    seconds === null ||
    !Number.isFinite(seconds) ||
    seconds < 0
  ) {
    return "—";
  }
  if (seconds < 1) return "<1s";
  const s = Math.floor(seconds);
  const days = Math.floor(s / 86400);
  const hours = Math.floor((s % 86400) / 3600);
  const minutes = Math.floor((s % 3600) / 60);
  const secs = s % 60;
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${secs}s`;
  return `${secs}s`;
}

// isUnsetTime returns true for timestamps that aren't meaningful —
// missing, unparseable, or Go's zero time (`0001-01-01T00:00:00Z`,
// which the daemon ships for "never seen" peer connections and would
// otherwise format as "739751d ago"). Callers can use this to choose
// "never" / "—" instead of running the value through humanRelative.
export function isUnsetTime(iso: string | undefined | null): boolean {
  if (!iso) return true;
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return true;
  // Anything before 1970-01-01 is, in practice, an unset value the
  // daemon serialized from a zero time.Time.
  return t <= 0;
}

// humanizeFolderError rewrites the daemon's raw folder-state errors
// into something a user can act on. The daemon's strings are aimed at
// operators ("folder marker missing — search docs/forum…"); in our UI
// the same messages show up beside the Activity tab badge, where they
// need to be both short and actionable.
//
// Falls through unchanged for anything we don't recognise so unexpected
// errors still surface verbatim instead of being silently swallowed.
export function humanizeFolderError(raw: string | undefined | null): string {
  if (!raw) return "";
  const s = raw.toLowerCase();
  if (s.includes("folder marker missing")) {
    return "Project folder marker is missing — the folder may have been moved or its contents cleared. Edit the project to repoint it.";
  }
  if (s.includes("folder path missing")) {
    return "Project folder not found — it may have been moved or its drive disconnected. Edit the project to update the path.";
  }
  return raw;
}

// humanRelative formats an ISO timestamp as "2m ago", "3h ago", etc.
// Returns "just now" for under 5s, "in <N>" for future timestamps,
// "—" for unset/zero timestamps so we never render the bogus
// "~2000 years ago" for an `0001-01-01T00:00:00Z` value.
export function humanRelative(iso: string | undefined | null): string {
  if (isUnsetTime(iso)) return "—";
  const t = new Date(iso!).getTime();
  const delta = (Date.now() - t) / 1000;
  if (Math.abs(delta) < 5) return "just now";
  const future = delta < 0;
  const abs = Math.abs(delta);
  let text: string;
  if (abs < 60) text = `${Math.round(abs)}s`;
  else if (abs < 3600) text = `${Math.round(abs / 60)}m`;
  else if (abs < 86400) text = `${Math.round(abs / 3600)}h`;
  else text = `${Math.round(abs / 86400)}d`;
  return future ? `in ${text}` : `${text} ago`;
}
