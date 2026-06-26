// ResizeHandle: a thin draggable column divider used between the dock
// panels (file list ⇆ player ⇆ comments). It reports incremental pointer
// deltas; the parent decides how to apply them to a panel width. The hit
// area is wider than the visible 1px line so it's easy to grab.
export function ResizeHandle({
  onResize,
  onResizeStart,
  onResizeEnd,
  ariaLabel = "Resize panel",
}: {
  onResize: (deltaX: number) => void;
  onResizeStart?: () => void;
  onResizeEnd?: () => void;
  ariaLabel?: string;
}) {
  const start = (e: React.PointerEvent) => {
    e.preventDefault();
    onResizeStart?.();
    let last = e.clientX;
    const move = (ev: PointerEvent) => {
      onResize(ev.clientX - last);
      last = ev.clientX;
    };
    const up = () => {
      document.removeEventListener("pointermove", move);
      document.removeEventListener("pointerup", up);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      onResizeEnd?.();
    };
    document.addEventListener("pointermove", move);
    document.addEventListener("pointerup", up);
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
  };
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={ariaLabel}
      onPointerDown={start}
      className="group relative flex w-0.5 shrink-0 cursor-col-resize items-stretch"
    >
      {/* Visible hairline; widens the grab area beyond the 2px column. */}
      <span className="w-full rounded-full bg-line transition-colors group-hover:bg-accent" />
      <span className="absolute inset-y-0 -left-1.5 -right-1.5" aria-hidden />
    </div>
  );
}
