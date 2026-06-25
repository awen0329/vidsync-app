// The Dropbox glyph (two stacked chevrons), as a fill-based SVG that takes
// currentColor. Shared by the sidebar Connect-Dropbox button and the
// per-project backup toggles. Pass a className to size/tint it.

export function DropboxGlyph({ className }: { className?: string }) {
  return (
    <svg
      className={className ?? "h-[18px] w-[18px]"}
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden
    >
      <path d="M6 2 1 5.2l5 3.2 5-3.2L6 2Zm12 0-5 3.2 5 3.2 5-3.2L18 2ZM1 11.6l5 3.2 5-3.2-5-3.2-5 3.2Zm17-3.2-5 3.2 5 3.2 5-3.2-5-3.2ZM6 16.5l5 3.2 5-3.2-5-3.2-5 3.2Z" />
    </svg>
  );
}
