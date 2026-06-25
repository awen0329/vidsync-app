// Persistent cache of sync daemon device IDs that have, at some point,
// been registered to the cloud account signed into this browser. The
// Invitations page reads /v1/devices to drop folder offers coming from
// "another seat of me" — but that endpoint is empty when the user is
// signed out, has just wiped their account, or the cloud row has been
// removed for any other reason. The local daemon, meanwhile, still
// has the peer device paired, so the offer keeps coming back. This
// cache lets the filter outlive cloud-side state.
//
// Conservative on purpose: we only ever add, never remove on logout
// — the goal is "stop showing me invites from machines that used to
// be mine". A user who genuinely wants to receive an invite from
// a previously-owned device can clear localStorage.

const KEY = "vidsync.selfDeviceIDs";

export function loadSelfDevices(): Set<string> {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return new Set();
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return new Set();
    return new Set(arr.filter((x): x is string => typeof x === "string"));
  } catch {
    return new Set();
  }
}

export function rememberSelfDevices(ids: Iterable<string>): void {
  try {
    const existing = loadSelfDevices();
    let changed = false;
    for (const id of ids) {
      if (id && !existing.has(id)) {
        existing.add(id);
        changed = true;
      }
    }
    if (changed) {
      localStorage.setItem(KEY, JSON.stringify([...existing]));
    }
  } catch {
    /* quota / private-mode — silent */
  }
}
