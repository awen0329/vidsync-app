import { useEffect, useRef, useState } from "react";
import { cn } from "../lib/utils";
import { dismissToast, subscribeToasts, type ToastItem } from "../lib/toast";

// Toaster renders the in-app toast stack (bottom-right). Subscribes to the
// module-level toast store; each toast auto-dismisses after a few seconds and
// can be clicked (if it has an onClick) or dismissed with the ✕.

const AUTO_DISMISS_MS = 6000;

export function Toaster() {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  // Per-toast dismissal timers, so a new toast doesn't reset existing ones.
  const timers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  useEffect(() => subscribeToasts(setToasts), []);

  useEffect(() => {
    const seen = new Set(toasts.map((t) => t.id));
    // Schedule dismissal for newly-arrived toasts.
    for (const t of toasts) {
      if (!timers.current.has(t.id)) {
        timers.current.set(
          t.id,
          setTimeout(() => dismissToast(t.id), AUTO_DISMISS_MS),
        );
      }
    }
    // Drop timers for toasts that are already gone.
    for (const [id, handle] of timers.current) {
      if (!seen.has(id)) {
        clearTimeout(handle);
        timers.current.delete(id);
      }
    }
  }, [toasts]);

  useEffect(() => {
    const map = timers.current;
    return () => {
      for (const handle of map.values()) clearTimeout(handle);
      map.clear();
    };
  }, []);

  if (toasts.length === 0) return null;
  return (
    <div className="pointer-events-none fixed bottom-4 right-4 z-[60] flex w-80 flex-col gap-2">
      {toasts.map((t) => (
        <div
          key={t.id}
          onClick={() => {
            t.onClick?.();
            dismissToast(t.id);
          }}
          className={cn(
            "pointer-events-auto rounded-lg border border-line-strong bg-elevated p-3 shadow-2xl",
            t.onClick && "cursor-pointer hover:border-accent",
          )}
        >
          <div className="flex items-start gap-2">
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm font-medium text-fg-strong">
                {t.title}
              </div>
              {t.body && (
                <div className="mt-0.5 max-h-10 overflow-hidden text-xs text-fg-soft">
                  {t.body}
                </div>
              )}
            </div>
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                dismissToast(t.id);
              }}
              aria-label="Dismiss"
              className="shrink-0 rounded p-0.5 text-fg-faint hover:bg-hover hover:text-fg-strong"
            >
              <svg className="h-4 w-4" viewBox="0 0 20 20" fill="currentColor" aria-hidden>
                <path
                  fillRule="evenodd"
                  d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z"
                  clipRule="evenodd"
                />
              </svg>
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}
