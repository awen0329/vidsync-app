import { useEffect, useState } from "react";

// DaemonFatalBanner surfaces the unrecoverable daemon states the Go
// side emits as Wails events. The OfflineBanner already handles the
// transient "can't reach the daemon" case (ping fails → "Reconnecting…"),
// and the backend auto-restarts a crashed daemon once — so this banner
// is only for the cases where the engine is genuinely down and won't
// come back on its own:
//
//   - daemon:failed   — the daemon never started this session.
//   - daemon:exited   — it died and the one auto-restart also failed.
//
// daemon:recovered (emitted after a successful auto-restart) clears it,
// in case it was briefly shown during a restart race.
//
// Events come from cmd/vidsync/app.go via the Wails runtime. In a
// browser/dev build with no Wails runtime the listener simply never
// attaches, so this renders nothing.
export function DaemonFatalBanner() {
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    const rt = (
      window as unknown as {
        runtime?: {
          EventsOn: (n: string, cb: (...args: unknown[]) => void) => () => void;
        };
      }
    ).runtime;
    if (!rt?.EventsOn) return;

    const asText = (args: unknown[]) =>
      typeof args[0] === "string" && args[0] ? args[0] : null;

    const offFailed = rt.EventsOn("daemon:failed", (...args) =>
      setMessage(
        asText(args) ?? "The local sync engine failed to start.",
      ),
    );
    const offExited = rt.EventsOn("daemon:exited", (...args) =>
      setMessage(
        asText(args) ??
          "The sync engine stopped unexpectedly. Restart Vidsync to resume syncing.",
      ),
    );
    const offRecovered = rt.EventsOn("daemon:recovered", () =>
      setMessage(null),
    );

    return () => {
      offFailed();
      offExited();
      offRecovered();
    };
  }, []);

  if (!message) return null;

  return (
    <div className="border-b border-rose-500/40 bg-rose-500/15 px-4 py-2 text-sm text-rose-100">
      <span className="font-medium">Sync engine stopped.</span>{" "}
      <span className="text-rose-200/90">{message}</span>
    </div>
  );
}
