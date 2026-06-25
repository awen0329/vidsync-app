// pickFolder opens the OS-native "choose folder" dialog when running
// inside Wails, and returns the picked absolute path. Returns null
// when not running in Wails (dev/browser) so callers can fall back
// to the in-app FolderPicker modal.
//
// Empty string back from the host means the user cancelled — also
// reported as null so callers can treat "no choice" uniformly.
//
// The dialog seeds itself with the parent of whatever the caller
// passes as `defaultDir` (so editing an existing project drops you
// in its parent, ready to pick a sibling), and falls back to the
// parent of the most recently picked folder when the caller has
// nothing to seed with. The last pick is persisted to localStorage
// so the hint survives across app restarts.

interface WailsAppBindings {
  PickFolder(title: string, defaultDir: string): Promise<string>;
}

function bindings(): WailsAppBindings | null {
  const w = window as unknown as {
    go?: { main?: { App?: WailsAppBindings } };
  };
  return w.go?.main?.App?.PickFolder ? (w.go.main.App as WailsAppBindings) : null;
}

// isNativeDialogAvailable lets callers decide whether to show their
// own modal-based picker as a fallback (when false) or skip it
// entirely (when true, since the OS dialog covers the need).
export function isNativeDialogAvailable(): boolean {
  return bindings() !== null;
}

const LAST_PICKED_KEY = "vidsync.folderpicker.lastPath";

function loadLastPicked(): string {
  try {
    return localStorage.getItem(LAST_PICKED_KEY) ?? "";
  } catch {
    return "";
  }
}

function saveLastPicked(p: string): void {
  try {
    localStorage.setItem(LAST_PICKED_KEY, p);
  } catch {
    // localStorage can throw in private-browsing / quota-exceeded
    // states; the dialog still works without the hint, so swallow it.
  }
}

// parentDir returns the containing directory of p with a trailing
// separator preserved so the host can tell "list this dir" from
// "select this entry". Returns "" for paths with no separator.
function parentDir(p: string): string {
  if (!p) return "";
  const stripped = p.replace(/[\\/]+$/, "");
  const idx = Math.max(stripped.lastIndexOf("/"), stripped.lastIndexOf("\\"));
  if (idx < 0) return "";
  return stripped.slice(0, idx + 1);
}

// lastPickedParent exposes the persisted parent for callers that
// need to seed their own pickers (e.g. the in-app FolderPicker
// fallback) the same way the native dialog seeds itself.
export function lastPickedParent(): string {
  return parentDir(loadLastPicked());
}

export async function pickFolder(
  title = "Choose a folder",
  defaultDir = "",
): Promise<string | null> {
  const app = bindings();
  if (!app) return null;
  // Prefer the parent of the most recently picked folder (the user's
  // expressed intent — typically they pick siblings in the same
  // workspace dir across modals). Fall back to the parent of whatever
  // the caller seeded us with, then to the caller's seed itself, for
  // first-run when nothing's been remembered yet.
  const seed = parentDir(loadLastPicked()) || parentDir(defaultDir) || defaultDir;
  try {
    const path = await app.PickFolder(title, seed);
    if (!path) return null;
    saveLastPicked(path);
    return path;
  } catch {
    return null;
  }
}
