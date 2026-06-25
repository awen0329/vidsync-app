import { useEffect, useRef, useState } from "react";
import {
  useCloudMe,
  useResendVerification,
  useVerifyDevice,
} from "../api/cloud/hooks";

// DeviceVerifyModal: full-screen overlay shown after a new device
// tries to register and the backend responded with 403
// verification_required. The user types the 6-digit code emailed to
// their address; we trade it for an active device row, then close.
//
// Distinct from the daemon-status Modal — this isn't dismissable, and
// it owns the post-sign-in entry to the app. If you close it without
// verifying, the AppShell behind it would not be entitled.

export function DeviceVerifyModal({
  verificationId,
  expiresAt,
  onResend,
  onVerified,
}: {
  verificationId: string;
  expiresAt: string;
  // Called by the modal when the user clicks "Resend" — the parent
  // owns the verificationId reference, so it gets the new id.
  onResend: (newVerificationId: string, newExpiresAt: string) => void;
  onVerified: () => void;
}) {
  const me = useCloudMe();
  const verify = useVerifyDevice();
  const resend = useResendVerification();
  const [code, setCode] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [remaining, setRemaining] = useState(() =>
    Math.max(0, Math.round((new Date(expiresAt).getTime() - Date.now()) / 1000)),
  );
  const inputRef = useRef<HTMLInputElement>(null);

  // Live countdown to expiry. Cheap; runs while modal is mounted.
  useEffect(() => {
    const target = new Date(expiresAt).getTime();
    const t = setInterval(() => {
      setRemaining(Math.max(0, Math.round((target - Date.now()) / 1000)));
    }, 1000);
    return () => clearInterval(t);
  }, [expiresAt]);

  useEffect(() => {
    inputRef.current?.focus();
  }, [verificationId]);

  async function submit() {
    setErr(null);
    const trimmed = code.replace(/\s/g, "");
    if (trimmed.length !== 6) {
      setErr("Enter the 6-digit code from your email.");
      return;
    }
    try {
      await verify.mutateAsync({ verificationId, code: trimmed });
      onVerified();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  }

  async function clickResend() {
    setErr(null);
    setCode("");
    try {
      const next = await resend.mutateAsync(verificationId);
      onResend(next.verificationId, next.expiresAt);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  }

  const email = me.data?.email ?? "your email";

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-base/95">
      <div className="w-full max-w-md rounded-lg border border-line-strong bg-panel p-6 shadow-xl">
        <h2 className="mb-2 text-lg font-semibold text-fg-strong">
          Verify this device
        </h2>
        <p className="mb-4 text-sm text-fg-soft">
          You're signed in on another device. To move your subscription
          to this one, enter the 6-digit code we sent to{" "}
          <span className="font-medium text-fg-strong">{email}</span>.
        </p>

        <label className="mb-3 block">
          <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-fg-soft">
            Verification code
          </span>
          <input
            ref={inputRef}
            value={code}
            onChange={(e) => setCode(e.target.value.replace(/[^0-9]/g, "").slice(0, 6))}
            inputMode="numeric"
            autoComplete="one-time-code"
            placeholder="123456"
            className="w-full rounded-md border border-line bg-elevated px-3 py-2 text-center font-mono text-lg tracking-[0.5em] text-fg-strong placeholder:text-fg-soft focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500"
            onKeyDown={(e) => {
              if (e.key === "Enter") submit();
            }}
          />
        </label>

        {err && (
          <p className="mb-3 text-sm text-rose-400">{err}</p>
        )}

        <div className="mb-4 flex items-center justify-between text-xs text-fg-soft">
          <span>
            {remaining > 0
              ? `Code expires in ${formatRemaining(remaining)}`
              : "Code expired"}
          </span>
          <button
            type="button"
            onClick={clickResend}
            disabled={resend.isPending || verify.isPending}
            className="text-indigo-400 hover:underline disabled:opacity-50"
          >
            {resend.isPending ? "Sending…" : "Resend code"}
          </button>
        </div>

        <button
          type="button"
          onClick={submit}
          disabled={verify.isPending || code.length !== 6}
          className="w-full rounded-md bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-500 disabled:opacity-50"
        >
          {verify.isPending ? "Verifying…" : "Verify and take over"}
        </button>
        <p className="mt-3 text-center text-[11px] text-fg-soft">
          Verifying signs your other device out of Vidsync. You can
          switch back the same way.
        </p>
      </div>
    </div>
  );
}

function formatRemaining(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}
