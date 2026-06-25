import { useEffect, useState } from "react";
import { Modal } from "./Modal";
import { useConfigOptions, usePatchConfigOptions } from "../api/hooks";
import {
  getNotificationsEnabled,
  requestNotificationPermission,
  setNotificationsEnabled,
} from "../api/useDesktopNotifications";
import { MyDevicesPanel } from "./MyDevicesPanel";
import { AccountPanel } from "./AccountPanel";
import { AUTH_ENABLED } from "../App";

// SettingsModal: global daemon-level settings the editor cares about.
// Currently exposes upload/download bandwidth caps — the daemon stores
// these as kilobits per second on Options.{maxRecvKbps,maxSendKbps}.
// 0 = unlimited.

const MBPS_TO_KBPS = 1000; // megabit -> kilobit (the daemon uses Kbps)

export function SettingsModal({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const opts = useConfigOptions();
  const patch = usePatchConfigOptions();
  const [maxSendMbps, setMaxSendMbps] = useState("0");
  const [maxRecvMbps, setMaxRecvMbps] = useState("0");
  const [notify, setNotify] = useState(false);
  const [notifyState, setNotifyState] = useState<NotificationPermission | "unsupported">(
    typeof Notification === "undefined" ? "unsupported" : Notification.permission,
  );
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (!opts.data) return;
    const sendKbps = (opts.data.maxSendKbps as number | undefined) ?? 0;
    const recvKbps = (opts.data.maxRecvKbps as number | undefined) ?? 0;
    setMaxSendMbps(String(sendKbps / MBPS_TO_KBPS));
    setMaxRecvMbps(String(recvKbps / MBPS_TO_KBPS));
    setNotify(getNotificationsEnabled());
  }, [opts.data, open]);

  const onToggleNotify = async (next: boolean) => {
    if (next) {
      const result = await requestNotificationPermission();
      setNotifyState(result);
      if (result !== "granted") {
        setNotify(false);
        setNotificationsEnabled(false);
        setErr(
          result === "denied"
            ? "Notifications are blocked. Enable them in your system settings for Vidsync, then try again."
            : "Notifications were not granted.",
        );
        return;
      }
    }
    setErr(null);
    setNotify(next);
    setNotificationsEnabled(next);
  };

  const submit = async () => {
    setErr(null);
    const send = parseFloat(maxSendMbps) || 0;
    const recv = parseFloat(maxRecvMbps) || 0;
    if (send < 0 || recv < 0) {
      setErr("Limits must be non-negative.");
      return;
    }
    try {
      await patch.mutateAsync({
        maxSendKbps: Math.round(send * MBPS_TO_KBPS),
        maxRecvKbps: Math.round(recv * MBPS_TO_KBPS),
      });
      onClose();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Settings"
      primaryLabel="Save"
      primaryDisabled={patch.isPending}
      onPrimary={submit}
    >
      <section className="space-y-6">
        {AUTH_ENABLED && (
          <>
            <div>
              <h3 className="mb-1 text-sm font-semibold text-fg">
                Account
              </h3>
              <AccountPanel />
            </div>

            <div>
              <h3 className="mb-1 text-sm font-semibold text-fg">
                My devices
              </h3>
              <MyDevicesPanel />
            </div>
          </>
        )}

        <div>
          <h3 className="mb-1 text-sm font-semibold text-fg">
            Bandwidth
          </h3>
          <p className="mb-3 text-xs text-fg-soft">
            Cap upload and download across all peers. <strong>0</strong> means
            unlimited. Set this if Vidsync is competing with your editor for
            bandwidth.
          </p>
          <Field label="Max upload (Mbps)">
            <input
              type="number"
              min={0}
              step={0.1}
              value={maxSendMbps}
              onChange={(e) => setMaxSendMbps(e.target.value)}
              className={inputClass}
            />
          </Field>
          <Field label="Max download (Mbps)">
            <input
              type="number"
              min={0}
              step={0.1}
              value={maxRecvMbps}
              onChange={(e) => setMaxRecvMbps(e.target.value)}
              className={inputClass}
            />
          </Field>
        </div>

        <div>
          <h3 className="mb-1 text-sm font-semibold text-fg">
            Notifications
          </h3>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={notify}
              disabled={notifyState === "unsupported"}
              onChange={(e) => onToggleNotify(e.target.checked)}
            />
            <span>
              Show a desktop notification when a project finishes syncing.
            </span>
          </label>
          {notifyState === "unsupported" && (
            <p className="mt-1 text-xs text-fg-soft">
              Desktop notifications aren't available on this system.
            </p>
          )}
          {notifyState === "denied" && (
            <p className="mt-1 text-xs text-amber-700">
              Notifications are blocked in your system settings.
            </p>
          )}
        </div>

        {err && <p className="text-sm text-rose-700">{err}</p>}
      </section>
    </Modal>
  );
}

const inputClass =
  "w-full rounded border border-line px-2 py-1.5 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500";

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <label className="mb-3 block">
      <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-fg-soft">
        {label}
      </span>
      {children}
    </label>
  );
}
