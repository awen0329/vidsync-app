// Maps the daemon's internal folder state to a label a media editor
// would actually read. The daemon emits native engine states like
// `idle`, `scanning`, `scan-waiting`, `sync-preparing` — those are
// engineering vocabulary that don't belong on the user surface.
//
// Status pills, dashboards, and lists should never echo raw daemon
// strings; they should call this helper and render the label /
// tone / dot color it returns.

export type HumanState =
  | "ready"
  | "syncing"
  | "paused"
  | "error"
  | "offline";

export interface HumanStateView {
  state: HumanState;
  label: string;
}

export function humanStateLabel(
  daemonState: string | undefined,
  paused: boolean,
): HumanStateView {
  if (paused) return { state: "paused", label: "Paused" };
  if (!daemonState || daemonState === "—") {
    return { state: "offline", label: "Offline" };
  }
  if (daemonState === "error") return { state: "error", label: "Error" };
  // Anything the daemon classifies as transient work ("syncing",
  // "scanning", "scan-waiting", "sync-preparing", "sync-waiting", etc.)
  // collapses to one word users actually care about.
  if (daemonState !== "idle") {
    return { state: "syncing", label: "Syncing" };
  }
  // `idle` means the daemon has nothing left to do — to a creative
  // user that reads as "this project is ready to work with."
  return { state: "ready", label: "Ready" };
}
