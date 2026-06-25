import { cn } from "../lib/utils";

// UnreadBadge: a small filled comment-bubble glyph in the accent color,
// shown on files (and parent folders) that have unread comments.
export function UnreadBadge({ className }: { className?: string }) {
  return (
    <span
      title="Unread comments"
      aria-label="Unread comments"
      className={cn("inline-flex shrink-0 items-center justify-center text-red-500", className)}
    >
      <svg viewBox="0 0 20 20" fill="currentColor" className="h-3.5 w-3.5" aria-hidden>
        <path d="M4 3.5h12A2.5 2.5 0 0 1 18.5 6v5A2.5 2.5 0 0 1 16 13.5H9.2l-3.6 2.7A.6.6 0 0 1 4.6 16l.1-2.6A2.5 2.5 0 0 1 1.5 11V6A2.5 2.5 0 0 1 4 3.5z" />
      </svg>
    </span>
  );
}
