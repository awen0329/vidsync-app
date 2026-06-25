import { type ReactNode, useEffect } from "react";
import { Button } from "./Button";

// Lightweight modal. shadcn/ui's Dialog (Radix) would be the upgrade
// path; this one keeps the dependency footprint small until then.
//
// Closes on backdrop click and Esc. Focus management is intentionally
// minimal — we'll revisit when accessibility hardens before launch.

// Only the topmost open Modal handles Esc, so a nested picker doesn't
// also dismiss its parent (e.g. FolderPicker inside NewProjectModal).
const modalStack: number[] = [];
let nextDepth = 1;

export function Modal({
  open,
  onClose,
  title,
  children,
  primaryLabel,
  onPrimary,
  primaryDisabled,
  primaryVariant = "primary",
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  primaryLabel?: string;
  onPrimary?: () => void;
  primaryDisabled?: boolean;
  primaryVariant?: "primary" | "danger";
}) {
  useEffect(() => {
    if (!open) return;
    const myDepth = nextDepth++;
    modalStack.push(myDepth);
    const handler = (e: KeyboardEvent) => {
      if (
        e.key === "Escape" &&
        modalStack[modalStack.length - 1] === myDepth
      ) {
        onClose();
      }
    };
    window.addEventListener("keydown", handler);
    return () => {
      window.removeEventListener("keydown", handler);
      const idx = modalStack.indexOf(myDepth);
      if (idx >= 0) modalStack.splice(idx, 1);
    };
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
      onClick={onClose}
    >
      <div
        className="w-full max-w-lg rounded-lg border border-line bg-panel text-fg shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="border-b border-line px-5 py-3 text-base font-semibold text-fg-strong">
          {title}
        </header>
        <div className="p-5">{children}</div>
        <footer className="flex justify-end gap-2 border-t border-line bg-elevated px-5 py-3">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          {onPrimary && (
            <Button
              variant={primaryVariant}
              onClick={onPrimary}
              disabled={primaryDisabled}
            >
              {primaryLabel ?? "Save"}
            </Button>
          )}
        </footer>
      </div>
    </div>
  );
}
