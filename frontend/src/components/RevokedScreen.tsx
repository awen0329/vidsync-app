import { useState } from "react";
import { useBearerAuth } from "../api/bearerAuth";
import { useRegisterDevice, useRevokeCurrentSession } from "../api/cloud/hooks";
import { useSystemStatus } from "../api/hooks";
import { DeviceVerifyModal } from "./DeviceVerifyModal";

// RevokedScreen replaces the AppShell when /v1/me reports this
// device has been displaced by a newer sign-in. The user can either
// take the subscription back here (which triggers the email-OTP
// flow again, this time from the *previously* active device's
// perspective) or sign out.

export function RevokedScreen({
  onTakeBackSuccess,
}: {
  // Called after a successful verification on this device. The
  // parent typically refetches /v1/me so the AppShell can mount.
  onTakeBackSuccess: () => void;
}) {
  const { signOut } = useBearerAuth();
  const sys = useSystemStatus();
  const register = useRegisterDevice();
  const revoke = useRevokeCurrentSession();

  // Sign-out from the revoked screen: still best-effort revoke, then
  // wipe the local token. The session might already be invalid from
  // the displacement; we don't gate on that.
  async function handleSignOut() {
    try {
      await revoke.mutateAsync();
    } catch {
      // ignore; sign out locally anyway
    }
    signOut();
  }
  const [pending, setPending] = useState<{
    verificationId: string;
    expiresAt: string;
  } | null>(null);
  const [err, setErr] = useState<string | null>(null);

  async function takeBack() {
    setErr(null);
    const id = sys.data?.myID;
    if (!id) {
      setErr("Still connecting to your local workspace — try again in a moment.");
      return;
    }
    try {
      const result = await register.mutateAsync({
        syncthingDeviceId: id,
        name: defaultDeviceName(),
      });
      if ("error" in result) {
        setPending({
          verificationId: result.verificationId,
          expiresAt: result.expiresAt,
        });
        return;
      }
      onTakeBackSuccess();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  }

  if (pending) {
    return (
      <DeviceVerifyModal
        verificationId={pending.verificationId}
        expiresAt={pending.expiresAt}
        onResend={(verificationId, expiresAt) =>
          setPending({ verificationId, expiresAt })
        }
        onVerified={() => {
          setPending(null);
          onTakeBackSuccess();
        }}
      />
    );
  }

  return (
    <div className="flex h-full items-center justify-center bg-base px-6 text-fg-strong">
      <div className="max-w-md rounded-lg border border-amber-500/30 bg-amber-500/5 p-6">
        <h1 className="mb-2 text-lg font-semibold text-amber-200">
          Signed out by another device
        </h1>
        <p className="mb-4 text-sm text-fg">
          Vidsync now allows one active device per account, and another
          machine just took over. You can take the subscription back
          here — we'll email you a code to confirm — or sign out.
        </p>
        {err && (
          <p className="mb-3 text-sm text-rose-300">{err}</p>
        )}
        <div className="flex gap-2">
          <button
            type="button"
            onClick={takeBack}
            disabled={register.isPending}
            className="flex-1 rounded-md bg-indigo-600 px-3 py-2 text-sm font-medium text-white hover:bg-indigo-500 disabled:opacity-50"
          >
            {register.isPending ? "Working…" : "Take it back here"}
          </button>
          <button
            type="button"
            onClick={handleSignOut}
            disabled={revoke.isPending}
            className="rounded-md border border-line px-3 py-2 text-sm text-fg hover:bg-elevated disabled:opacity-60"
          >
            {revoke.isPending ? "Signing out…" : "Sign out"}
          </button>
        </div>
      </div>
    </div>
  );
}

function defaultDeviceName(): string {
  if (typeof navigator === "undefined") return "Unnamed device";
  const ua = navigator.userAgent;
  if (/Mac/.test(ua)) return "Mac";
  if (/Windows/.test(ua)) return "Windows PC";
  if (/Linux/.test(ua)) return "Linux PC";
  return "Unnamed device";
}
