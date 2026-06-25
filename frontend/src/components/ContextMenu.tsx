import { useEffect, useLayoutEffect, useRef, useState } from "react";

// Floating, positioned-at-cursor menu that closes on Escape, blur, or
// click outside. After the first paint we re-measure and clamp to the
// viewport so the menu never spills off-screen on right-click near the
// edges of the window.

export interface ContextMenuItem {
  label: string;
  onSelect: () => void;
  // Optional small description shown below the label in a muted color.
  hint?: string;
  // When true the row renders muted and is not clickable.
  disabled?: boolean;
  // When true the row renders in red — for destructive actions.
  danger?: boolean;
  // Inserts a 1px divider above this row.
  separatorBefore?: boolean;
}

export function ContextMenu({
  x,
  y,
  items,
  onClose,
}: {
  x: number;
  y: number;
  items: ContextMenuItem[];
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: x, top: y });

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let left = x;
    let top = y;
    if (left + rect.width > vw - 4) left = vw - rect.width - 4;
    if (top + rect.height > vh - 4) top = vh - rect.height - 4;
    if (left < 4) left = 4;
    if (top < 4) top = 4;
    setPos({ left, top });
  }, [x, y]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    const onClick = (e: MouseEvent) => {
      const el = ref.current;
      if (!el) return;
      if (!el.contains(e.target as Node)) onClose();
    };
    const onContext = (e: MouseEvent) => {
      const el = ref.current;
      if (el && !el.contains(e.target as Node)) onClose();
    };
    const onScroll = () => onClose();
    window.addEventListener("keydown", onKey);
    window.addEventListener("mousedown", onClick);
    window.addEventListener("contextmenu", onContext);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("blur", onClose);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("mousedown", onClick);
      window.removeEventListener("contextmenu", onContext);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("blur", onClose);
    };
  }, [onClose]);

  return (
    <div
      ref={ref}
      role="menu"
      style={{ position: "fixed", left: pos.left, top: pos.top, zIndex: 100 }}
      className="min-w-[200px] overflow-hidden rounded-md border border-line bg-panel py-1 shadow-xl ring-1 ring-black/40"
      onContextMenu={(e) => e.preventDefault()}
    >
      {items.map((it, i) => (
        <div key={i}>
          {it.separatorBefore && (
            <div className="my-1 h-px bg-elevated" aria-hidden />
          )}
          <button
            type="button"
            role="menuitem"
            disabled={it.disabled}
            onClick={() => {
              if (it.disabled) return;
              it.onSelect();
              onClose();
            }}
            className={
              "block w-full px-3 py-1.5 text-left text-sm transition-colors " +
              (it.disabled
                ? "cursor-default text-fg-soft"
                : it.danger
                  ? "text-rose-400 hover:bg-rose-500/10"
                  : "text-fg-strong hover:bg-elevated")
            }
          >
            <div>{it.label}</div>
            {it.hint && (
              <div className="mt-0.5 text-[11px] text-fg-soft">{it.hint}</div>
            )}
          </button>
        </div>
      ))}
    </div>
  );
}
