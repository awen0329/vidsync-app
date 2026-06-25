import { APIError } from "../api/client";

// Best-effort, client-side mirror of the daemon's CheckFolderPathOverlap
// (lib/config/config.go). The daemon is authoritative — it expands ~,
// resolves absolute paths and symlinks/firmlinks, and rejects overlaps with
// HTTP 409 — but these helpers let the project-create and accept-invite
// modals show a friendly inline message before the request round-trips. We
// deliberately keep the normalization simple (the native folder picker
// already returns absolute paths); anything that slips through — notably
// macOS firmlink aliases like /Volumes/Macintosh_HD/Users/x vs /Users/x,
// which JS can't resolve — is still caught by the daemon's 409.

export function normalizePathForCompare(p: string): string {
  return p
    .replace(/[\\/]+/g, "/") // unify separators
    .replace(/\/+$/, "") // drop trailing slash
    .toLowerCase(); // folders are case-insensitive on Windows & macOS
}

// True when two folder roots are the same directory, or one is nested
// inside the other.
export function pathsOverlap(a: string, b: string): boolean {
  const na = normalizePathForCompare(a);
  const nb = normalizePathForCompare(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  return na.startsWith(nb + "/") || nb.startsWith(na + "/");
}

type FolderLike = { id: string; label?: string; path: string };

// Returns the first existing folder whose path overlaps `candidate`, or
// null. `excludeID` skips a folder being edited in place.
export function overlappingFolder<T extends FolderLike>(
  candidate: string,
  folders: readonly T[],
  excludeID?: string,
): T | null {
  if (!candidate) return null;
  for (const f of folders) {
    if (excludeID && f.id === excludeID) continue;
    if (pathsOverlap(candidate, f.path)) return f;
  }
  return null;
}

// isPathOverlapError reports whether an add-folder request was rejected by
// the daemon because the path overlaps an existing folder (HTTP 409). This
// is how aliases the lexical client-side check can't see — e.g. a macOS
// firmlink — surface, so the modal can show the same friendly alert it shows
// for a locally-detected conflict instead of a raw error.
export function isPathOverlapError(err: unknown): boolean {
  return err instanceof APIError && err.status === 409;
}

// folderErrorMessage turns an add-folder failure into a display-ready string.
// For the overlap 409 it uses the daemon's human-readable body (dropping the
// internal "(folderID)" suffix and the "METHOD PATH: STATUS" prefix that
// APIError.message carries); for anything else it falls back to the raw
// message so genuine errors stay debuggable.
export function folderErrorMessage(err: unknown): string {
  if (err instanceof APIError) {
    const body = err.body.replace(/\s*\([a-z0-9-]+\)\s*$/i, "").trim();
    if (isPathOverlapError(err) && body) {
      return body.charAt(0).toUpperCase() + body.slice(1);
    }
  }
  return err instanceof Error ? err.message : String(err);
}
