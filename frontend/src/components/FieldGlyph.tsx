import type { FieldIcon } from "../lib/mediaFields";

// FieldGlyph: the small type indicator beside each media field (text "T",
// number "1", a clock for time, a checkbox for booleans, a chevron for the
// status enum), matching the Frame.io field rows.
export function FieldGlyph({ icon }: { icon: FieldIcon }) {
  const box =
    "flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded bg-panel text-[10px] font-semibold text-fg-faint ring-1 ring-line";
  if (icon === "text") return <span className={box}>T</span>;
  if (icon === "number") return <span className={box}>1</span>;
  if (icon === "time") {
    return (
      <span className={box}>
        <svg viewBox="0 0 20 20" fill="none" className="h-3 w-3" aria-hidden>
          <circle cx="10" cy="10" r="6.5" stroke="currentColor" strokeWidth="1.6" />
          <path d="M10 6.5V10l2.2 1.4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
        </svg>
      </span>
    );
  }
  if (icon === "select") {
    return (
      <span className={box}>
        <svg viewBox="0 0 20 20" fill="none" className="h-3 w-3" aria-hidden>
          <rect x="4" y="4" width="12" height="12" rx="2.5" stroke="currentColor" strokeWidth="1.6" />
        </svg>
      </span>
    );
  }
  // status
  return (
    <span className={box}>
      <svg viewBox="0 0 20 20" fill="none" className="h-3 w-3" aria-hidden>
        <rect x="3.5" y="5" width="13" height="10" rx="2" stroke="currentColor" strokeWidth="1.6" />
        <path d="M8 9l2 2 2-2" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </span>
  );
}
