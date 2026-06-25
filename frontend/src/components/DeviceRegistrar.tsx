import { useEffect, useRef, useState } from "react";
import { useSystemStatus } from "../api/hooks";
import { useRegisterDevice } from "../api/cloud/hooks";
import { DeviceVerifyModal } from "./DeviceVerifyModal";

// DeviceRegistrar runs once per session: it learns the local
// sync daemon device ID from the daemon and POSTs it to the control
// plane. Three outcomes:
//
//   1. 200 + CloudDevice → this device is now the active one. Nothing
//      else to do; the AppShell renders as normal.
//   2. 403 verification_required → another device holds the slot. We
//      render <DeviceVerifyModal> over the AppShell to capture the
//      OTP from the user's email.
//   3. Any other error → silently bail; the user will see the
//      "not entitled" state via /v1/me on the next poll.
//
// Idempotency: the backend re-registers (un-revokes) the same
// syncthing_device_id on every boot, so calling this on every page
// reload is safe.

interface Pending {
  verificationId: string;
  expiresAt: string;
}

// Backoff schedule (seconds) for retrying a failed device registration.
// Tuned for the common failure: Clerk JWT template was just created
// or the backend just came up — both resolve in well under a minute.
const RETRY_DELAYS_S = [3, 5, 10, 30, 60];

export function DeviceRegistrar() {
  const sys = useSystemStatus();
  const register = useRegisterDevice();
  const succeeded = useRef(false);
  const inFlight = useRef(false);
  const [pending, setPending] = useState<Pending | null>(null);
  // Bumped from onError to re-run the effect after a backoff. Without
  // this the effect's deps don't change so the retry never fires.
  const [retry, setRetry] = useState(0);

  useEffect(() => {
    const deviceID = sys.data?.myID;
    if (!deviceID) return;
    if (succeeded.current) return;
    if (inFlight.current) return;
    inFlight.current = true;

    register.mutate(
      { syncthingDeviceId: deviceID, name: defaultDeviceName() },
      {
        onSuccess: (result) => {
          // Either we registered (CloudDevice) or a verification step
          // was emitted (VerificationRequired). Both are definitive
          // outcomes — stop retrying.
          succeeded.current = true;
          inFlight.current = false;
          if ("error" in result) {
            setPending({
              verificationId: result.verificationId,
              expiresAt: result.expiresAt,
            });
          }
        },
        // Most common failure modes here are transient: the Clerk JWT
        // template was just created and hasn't propagated, the backend
        // is cold-starting, or the network blipped. Without retry, the
        // user gets stuck — every cloud write returns 403 device_not_yours
        // because the devices row was never inserted, and the only fix
        // is to relaunch the app.
        onError: () => {
          inFlight.current = false;
          const delay = RETRY_DELAYS_S[Math.min(retry, RETRY_DELAYS_S.length - 1)];
          setTimeout(() => setRetry((r) => r + 1), delay * 1000);
        },
      },
    );
  }, [sys.data?.myID, register, retry]);

  if (!pending) return null;

  return (
    <DeviceVerifyModal
      verificationId={pending.verificationId}
      expiresAt={pending.expiresAt}
      onResend={(verificationId, expiresAt) =>
        setPending({ verificationId, expiresAt })
      }
      onVerified={() => setPending(null)}
    />
  );
}

// Best-effort device label. The user can rename it in the My Devices
// settings panel; this is only the bootstrap value.
function defaultDeviceName(): string {
  if (typeof navigator === "undefined") return "Unnamed device";
  const ua = navigator.userAgent;
  if (/Mac/.test(ua)) return "Mac";
  if (/Windows/.test(ua)) return "Windows PC";
  if (/Linux/.test(ua)) return "Linux PC";
  return "Unnamed device";
}
