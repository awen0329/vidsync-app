import { useEffect, useState } from "react";
import { cn } from "../lib/utils";

// useMountTransition keeps a node mounted across its exit animation: when
// `show` flips false we drop `visible` immediately (so CSS animates out) but
// only unmount (`rendered` → false) after `duration` ms.
export function useMountTransition(show: boolean, duration: number) {
  const [rendered, setRendered] = useState(show);
  const [visible, setVisible] = useState(show);
  useEffect(() => {
    let raf = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    if (show) {
      setRendered(true);
      // Two RAFs so the browser paints the collapsed state before we expand.
      raf = requestAnimationFrame(() =>
        requestAnimationFrame(() => setVisible(true)),
      );
    } else {
      setVisible(false);
      timer = setTimeout(() => setRendered(false), duration);
    }
    return () => {
      cancelAnimationFrame(raf);
      if (timer) clearTimeout(timer);
    };
  }, [show, duration]);
  return { rendered, visible };
}

// SlidePanel animates a dock in/out for the layout toggles. When `width` is
// given it collapses that fixed width to 0 (smooth — neighbours fill the
// space); otherwise it just fades + slides (used for the flex-1 player). It
// always fades opacity and slides from `from`. Returns null once fully hidden.
export function SlidePanel({
  show,
  width,
  from = "left",
  duration = 320,
  className,
  children,
}: {
  show: boolean;
  width?: number;
  from?: "left" | "right";
  duration?: number;
  className?: string;
  children: React.ReactNode;
}) {
  const { rendered, visible } = useMountTransition(show, duration);
  if (!rendered) return null;
  const tx = from === "left" ? "-14px" : "14px";
  return (
    <div
      className={cn("overflow-hidden", className)}
      style={{
        transitionProperty: "width, opacity, transform",
        transitionDuration: `${duration}ms`,
        transitionTimingFunction: "cubic-bezier(0.4, 0, 0.2, 1)",
        width: width !== undefined ? (visible ? width : 0) : undefined,
        opacity: visible ? 1 : 0,
        transform: visible ? "translateX(0)" : `translateX(${tx})`,
      }}
    >
      {children}
    </div>
  );
}
