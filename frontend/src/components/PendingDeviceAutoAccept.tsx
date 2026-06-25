import { useEffect, useRef } from "react";
import { useAddDevice, useConfig, usePendingDevices } from "../api/hooks";
import { client } from "../api/client";

// PendingDeviceAutoAccept trusts collaborator devices in the background, so a
// project share "just starts syncing" without ever surfacing a manual
// "device wants to connect" prompt.
//
// When a device tries to connect, the daemon lists it as pending until it's
// in the device list. We auto-add any pending device that's already
// referenced by one of our shared folders — i.e. a peer we (or the
// InvitationBridge, off a cloud-verified accepted invite) already agreed to
// sync a project with. Devices we share nothing with are left alone (they
// still show in Invitations for manual review), so this never blindly trusts
// a stranger.
//
// This also self-heals older shares that were created before the accept flow
// registered the owner's device: the dangling folder.devices entry triggers
// an auto-add here, clearing the recurring pending-device prompt.
//
// Invisible — renders null; exists for its side effects.
export function PendingDeviceAutoAccept() {
  const pending = usePendingDevices();
  const cfg = useConfig();
  const addDevice = useAddDevice();
  // Guard so a burst of PendingDevicesChanged events doesn't fire N adds for
  // the same device before the first one lands in config.
  const inFlight = useRef<Set<string>>(new Set());

  useEffect(() => {
    const pendingMap = pending.data ?? {};
    const ids = Object.keys(pendingMap);
    if (ids.length === 0 || !cfg.data) return;

    const known = new Set(cfg.data.devices.map((d) => d.deviceID));
    const sharedWith = new Set<string>();
    for (const f of cfg.data.folders) {
      for (const d of f.devices) sharedWith.add(d.deviceID);
    }

    for (const deviceID of ids) {
      if (known.has(deviceID)) continue; // already trusted
      if (!sharedWith.has(deviceID)) continue; // not a known collaborator → leave for manual review
      if (inFlight.current.has(deviceID)) continue;

      inFlight.current.add(deviceID);
      const name = pendingMap[deviceID]?.name || deviceID.slice(0, 7);
      void (async () => {
        try {
          const def = await client.defaultDevice();
          await addDevice.mutateAsync({ ...def, deviceID, name });
        } catch (e) {
          // Non-fatal: next PendingDevicesChanged tick retries.
          console.warn("auto-accept collaborator device failed", deviceID, e);
        } finally {
          inFlight.current.delete(deviceID);
        }
      })();
    }
  }, [pending.data, cfg.data, addDevice]);

  return null;
}
