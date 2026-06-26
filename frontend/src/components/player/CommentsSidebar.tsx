import { useState } from "react";
import EmojiPicker, { EmojiStyle, Theme } from "emoji-picker-react";
import { cn } from "../../lib/utils";
import { humanBytes } from "../../lib/format";
import { initialsOf } from "../PresenceAvatar";
import type { Comment, CommentThread, UseComments } from "./comments";
import type { MediaInfo, Selection } from "./VideoStage";
import { formatClock, formatRange, formatRelative } from "./format";
import type { VideoPreviewFile } from "../VideoPreviewModal";
import { ALL_FIELDS } from "../../lib/mediaFields";
import { FieldGlyph } from "../FieldGlyph";

type Tab = "comments" | "fields";

// CommentsSidebar: the right rail of the review player. The Comments tab is
// the primary surface; Inspector shows clip metadata. Timestamp chips seek
// the video; the composer pins new comments to the current playhead.

export function CommentsSidebar({
  file,
  media,
  comments,
  currentTime,
  selection,
  onClearSelection,
  onSeek,
  activeMarkerId,
  setActiveMarkerId,
}: {
  file: VideoPreviewFile;
  media: MediaInfo | null;
  comments: UseComments;
  currentTime: number;
  selection: Selection | null;
  onClearSelection: () => void;
  onSeek: (t: number) => void;
  activeMarkerId: string | null;
  setActiveMarkerId: (id: string | null) => void;
}) {
  const [tab, setTab] = useState<Tab>("comments");

  return (
    <aside className="flex h-full w-full flex-col">
      <nav className="flex items-center gap-4 border-b border-line-strong px-4 pt-3 text-sm">
        <TabButton
          label="Comments"
          active={tab === "comments"}
          onClick={() => setTab("comments")}
          count={comments.threads.length}
        />
        <TabButton label="Fields" active={tab === "fields"} onClick={() => setTab("fields")} />
      </nav>

      {tab === "comments" ? (
        <CommentsTab
          comments={comments}
          currentTime={currentTime}
          selection={selection}
          onClearSelection={onClearSelection}
          onSeek={onSeek}
          activeMarkerId={activeMarkerId}
          setActiveMarkerId={setActiveMarkerId}
        />
      ) : (
        <FieldsTab file={file} media={media} comments={comments} />
      )}
    </aside>
  );
}

type FieldFilter = "none" | "empty" | "filled";

type CommentFilter = "all" | "open" | "resolved";
const COMMENT_FILTERS: Record<CommentFilter, string> = {
  all: "All comments",
  open: "Open",
  resolved: "Resolved",
};

// EmojiButton: a face icon that opens a full emoji picker (categories, search,
// recently used). Picking one calls onPick. We render native (OS-font) emoji
// so it works offline in the desktop WebView — no CDN image fetch.
function EmojiButton({
  onPick,
  align = "left",
}: {
  onPick: (emoji: string) => void;
  align?: "left" | "right";
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="relative">
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          setOpen((o) => !o);
        }}
        title="Emoji"
        aria-label="Insert emoji"
        className={cn(
          "rounded-md p-1.5 transition-colors hover:bg-hover hover:text-fg-strong",
          open ? "text-pink-400" : "text-fg-soft",
        )}
      >
        <svg viewBox="0 0 20 20" fill="none" className="h-[18px] w-[18px]" aria-hidden>
          <circle cx="10" cy="10" r="7" stroke="currentColor" strokeWidth="1.5" />
          <path d="M7.5 8h.01M12.5 8h.01M7 12.5c1.5 1.3 4.5 1.3 6 0" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        </svg>
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-30" onClick={() => setOpen(false)} />
          <div
            onClick={(e) => e.stopPropagation()}
            className={cn(
              "absolute bottom-full z-40 mb-1.5 overflow-hidden rounded-xl shadow-2xl shadow-black/60",
              align === "right" ? "right-0" : "left-0",
            )}
          >
            <EmojiPicker
              onEmojiClick={(d) => {
                onPick(d.emoji);
                setOpen(false);
              }}
              theme={Theme.DARK}
              emojiStyle={EmojiStyle.NATIVE}
              lazyLoadEmojis
              width={320}
              height={400}
              previewConfig={{ showPreview: true }}
              skinTonesDisabled
            />
          </div>
        </>
      )}
    </div>
  );
}

// AttachButton: paperclip affordance matching the reference composer. File
// attachments aren't wired to the backend yet, so it surfaces that on hover.
function AttachButton() {
  return (
    <button
      type="button"
      title="Attach a file — coming soon"
      aria-label="Attach a file"
      onClick={(e) => e.stopPropagation()}
      className="rounded-md p-1.5 text-fg-soft transition-colors hover:bg-hover hover:text-fg-strong"
    >
      <svg viewBox="0 0 20 20" fill="none" className="h-[18px] w-[18px]" aria-hidden>
        <path
          d="M13.5 7l-5 5a2 2 0 0 0 2.83 2.83l5.17-5.17a3.5 3.5 0 0 0-4.95-4.95l-5.3 5.3a5 5 0 0 0 7.07 7.07L17 14"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </button>
  );
}

// StopwatchIcon: the little timer beside a comment's timecode/range chip.
function StopwatchIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 20 20" fill="none" className={className} aria-hidden>
      <circle cx="10" cy="11" r="6" stroke="currentColor" strokeWidth="1.5" />
      <path d="M10 11V8M8 3h4M10 5V3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

// SharedIcon: our own "visible to everyone on this project" marker — a small
// group-of-people glyph (replaces the Frame.io-style globe).
function SharedIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 20 20" fill="none" className={className} aria-hidden>
      <title>Visible to everyone on this project</title>
      <circle cx="7" cy="8" r="2.4" stroke="currentColor" strokeWidth="1.4" />
      <path d="M2.5 16c0-2.2 2-3.8 4.5-3.8s4.5 1.6 4.5 3.8" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
      <path d="M13 6.2a2.2 2.2 0 0 1 0 4.1M14.5 15.6c.6-.3 1-.9 1-1.6 0-1.3-1-2.4-2.6-2.9" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}

// FieldsTab: Frame.io-style metadata inspector — a header summary card plus a
// searchable, filterable list of the clip's fields. Values we can't read from
// the file / media element show as empty so the Only Empty / Only Filled
// filters stay meaningful.
function FieldsTab({
  file,
  media,
  comments,
}: {
  file: VideoPreviewFile;
  media: MediaInfo | null;
  comments: UseComments;
}) {
  const [q, setQ] = useState("");
  const [showSearch, setShowSearch] = useState(false);
  const [filter, setFilter] = useState<FieldFilter>("none");
  const [filterOpen, setFilterOpen] = useState(false);

  const ext = file.name.includes(".")
    ? file.name.split(".").pop()!.toUpperCase()
    : "";
  const kindWord =
    file.kind === "audio" ? "Audio" : file.kind === "image" ? "Image" : "Video";
  const resolution =
    media && media.width > 0 ? `${media.width} × ${media.height}` : "";
  const duration =
    media && media.duration > 0 ? formatClock(media.duration) : "";
  const created = file.modified
    ? new Date(file.modified).toLocaleString(undefined, {
        month: "short",
        day: "numeric",
        year: "numeric",
        hour: "numeric",
        minute: "2-digit",
      })
    : "";

  // Values we can derive from the file + loaded media element. Everything
  // else in the catalog renders empty (the daemon doesn't extract full
  // ffprobe metadata yet) so the Only Empty / Only Filled filters stay real.
  const values: Record<string, string> = {
    Name: file.name,
    Filename: file.name,
    "File Type": kindWord,
    Format: ext,
    "File Size": humanBytes(file.size),
    Duration: duration,
    "Start Time": duration ? formatClock(0) : "",
    "End Time": duration,
    "Resolution - Width": media?.width ? `${media.width}` : "",
    "Resolution - Height": media?.height ? `${media.height}` : "",
    "Comment Count": `${comments.pins.length}`,
  };
  const fields = ALL_FIELDS.map((f) => ({
    ...f,
    value: values[f.label] ?? "",
  }));

  const ql = q.trim().toLowerCase();
  const shown = fields.filter((f) => {
    if (ql && !f.label.toLowerCase().includes(ql)) return false;
    if (filter === "empty" && f.value) return false;
    if (filter === "filled" && !f.value) return false;
    return true;
  });

  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
      {/* Summary card */}
      <div className="rounded-xl border border-line bg-base/60 p-3">
        <div className="truncate text-sm font-medium text-fg-strong" title={file.name}>
          {file.name}
        </div>
        {created && (
          <div className="mt-0.5 text-[11px] text-fg-faint">Created {created}</div>
        )}
        <div className="mt-3 grid grid-cols-3 gap-2 text-center">
          <Stat label="Type" value={ext || kindWord} />
          <Stat label="Resolution" value={resolution || "—"} />
          <Stat label="Size" value={humanBytes(file.size)} />
        </div>
      </div>

      {/* Fields header: count + filter + search */}
      <div className="mt-4 flex items-center justify-between">
        <span className="text-xs font-medium text-fg-soft">
          All Fields ({fields.length})
        </span>
        <div className="flex items-center gap-1">
          <div className="relative">
            <button
              type="button"
              onClick={() => setFilterOpen((o) => !o)}
              title="Filter fields"
              aria-label="Filter fields"
              className={cn(
                "flex h-7 w-7 items-center justify-center rounded-md transition-colors",
                filter !== "none"
                  ? "bg-accent/15 text-accent"
                  : "text-fg-soft hover:bg-hover hover:text-fg-strong",
              )}
            >
              <svg viewBox="0 0 20 20" fill="none" className="h-4 w-4" aria-hidden>
                <path d="M3 5h14M6 10h8M9 15h2" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
              </svg>
            </button>
            {filterOpen && (
              <div className="absolute right-0 top-full z-30 mt-1.5 w-40 rounded-lg border border-line-strong bg-elevated p-1.5 shadow-2xl shadow-black/60">
                <div className="px-2 py-1 text-[11px] font-medium text-fg-faint">
                  Filter by…
                </div>
                {(
                  [
                    ["none", "None"],
                    ["empty", "Only Empty"],
                    ["filled", "Only Filled"],
                  ] as [FieldFilter, string][]
                ).map(([v, label]) => (
                  <button
                    key={v}
                    type="button"
                    onClick={() => {
                      setFilter(v);
                      setFilterOpen(false);
                    }}
                    className="flex w-full items-center justify-between rounded-md px-2 py-1.5 text-left text-sm text-fg transition-colors hover:bg-hover hover:text-fg-strong"
                  >
                    {label}
                    {filter === v && (
                      <svg viewBox="0 0 20 20" fill="currentColor" className="h-4 w-4 text-accent" aria-hidden>
                        <path d="M16.7 5.3a1 1 0 0 1 0 1.4l-7 7a1 1 0 0 1-1.4 0l-3-3a1 1 0 1 1 1.4-1.4l2.3 2.29 6.3-6.29a1 1 0 0 1 1.4 0z" />
                      </svg>
                    )}
                  </button>
                ))}
              </div>
            )}
          </div>
          <button
            type="button"
            onClick={() => setShowSearch((s) => !s)}
            title="Search fields"
            aria-label="Search fields"
            className={cn(
              "flex h-7 w-7 items-center justify-center rounded-md transition-colors",
              showSearch ? "bg-accent/15 text-accent" : "text-fg-soft hover:bg-hover hover:text-fg-strong",
            )}
          >
            <svg viewBox="0 0 20 20" fill="none" className="h-4 w-4" aria-hidden>
              <circle cx="9" cy="9" r="6" stroke="currentColor" strokeWidth="1.8" />
              <path d="m17 17-4.35-4.35" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
            </svg>
          </button>
        </div>
      </div>

      {showSearch && (
        <div className="relative mt-2">
          <input
            autoFocus
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search fields…"
            className="w-full rounded-lg border border-line bg-base px-3 py-1.5 pr-8 text-sm text-fg-strong placeholder:text-fg-faint focus:border-accent focus:outline-none"
          />
          <button
            type="button"
            onClick={() => {
              if (q) setQ("");
              else setShowSearch(false);
            }}
            aria-label="Clear search"
            title="Clear search"
            className="absolute right-2 top-1/2 flex h-5 w-5 -translate-y-1/2 items-center justify-center rounded text-fg-faint transition-colors hover:bg-hover hover:text-fg-strong"
          >
            <svg viewBox="0 0 20 20" fill="currentColor" className="h-3.5 w-3.5" aria-hidden>
              <path d="M10 8.6 5.7 4.3 4.3 5.7 8.6 10l-4.3 4.3 1.4 1.4L10 11.4l4.3 4.3 1.4-1.4L11.4 10l4.3-4.3-1.4-1.4z" />
            </svg>
          </button>
        </div>
      )}

      <div className="mt-2 space-y-px">
        {shown.map((f) => (
          <div
            key={f.label}
            className="flex items-center gap-2.5 rounded-md px-1 py-2"
          >
            <FieldGlyph icon={f.icon} />
            <span className="min-w-0 flex-1 truncate text-[13px] text-fg-soft">
              {f.label}
            </span>
            <span
              className={cn(
                "max-w-[45%] shrink-0 truncate text-right text-[13px]",
                f.value ? "text-fg-strong" : "text-fg-faint",
              )}
            >
              {f.value || "—"}
            </span>
          </div>
        ))}
        {shown.length === 0 && (
          <p className="py-6 text-center text-xs text-fg-faint">No fields match.</p>
        )}
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg bg-elevated px-1 py-2">
      <div className="text-[9px] font-semibold uppercase tracking-wide text-fg-faint">
        {label}
      </div>
      <div className="mt-0.5 truncate text-[12px] font-medium text-fg-strong">
        {value}
      </div>
    </div>
  );
}

function TabButton({
  label,
  active,
  onClick,
  count,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
  count?: number;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "-mb-px flex items-center gap-1.5 border-b-2 pb-2 font-medium transition-colors",
        active
          ? "border-pink-500 text-fg-strong"
          : "border-transparent text-fg-soft hover:text-fg-strong",
      )}
    >
      {label}
      {count !== undefined && count > 0 && (
        <span className="rounded-full bg-pink-500/15 px-1.5 text-[11px] font-semibold text-pink-400">
          {count}
        </span>
      )}
    </button>
  );
}

function CommentsTab({
  comments,
  currentTime,
  selection,
  onClearSelection,
  onSeek,
  activeMarkerId,
  setActiveMarkerId,
}: {
  comments: UseComments;
  currentTime: number;
  selection: Selection | null;
  onClearSelection: () => void;
  onSeek: (t: number) => void;
  activeMarkerId: string | null;
  setActiveMarkerId: (id: string | null) => void;
}) {
  const [draft, setDraft] = useState("");
  const [filter, setFilter] = useState<CommentFilter>("all");
  const [filterOpen, setFilterOpen] = useState(false);

  // Pin to the in→out selection when one is set, otherwise the playhead.
  const start = selection ? selection.in : currentTime;
  const end = selection ? selection.out : undefined;

  const submit = () => {
    comments.addComment(start, draft, end);
    setDraft("");
    onClearSelection();
  };

  const visible = comments.threads.filter((t) =>
    filter === "open" ? !t.resolved : filter === "resolved" ? t.resolved : true,
  );

  return (
    <>
      {/* Filter bar (replaces a redundant heading — the tab already says
          "Comments"). Lets the reviewer scope to open vs resolved threads. */}
      <div className="relative flex items-center justify-between px-4 py-2.5">
        <button
          type="button"
          onClick={() => setFilterOpen((o) => !o)}
          className="inline-flex items-center gap-1.5 rounded-md bg-elevated px-2 py-1 text-xs text-fg ring-1 ring-line hover:ring-line-strong"
        >
          {COMMENT_FILTERS[filter]}
          <svg viewBox="0 0 20 20" fill="currentColor" className="h-3.5 w-3.5 text-fg-faint" aria-hidden>
            <path d="M6 8l4 4 4-4z" />
          </svg>
        </button>
        {filterOpen && (
          <div className="absolute left-4 top-full z-30 mt-1 w-40 rounded-lg border border-line-strong bg-elevated p-1.5 shadow-2xl shadow-black/60">
            {(Object.keys(COMMENT_FILTERS) as CommentFilter[]).map((key) => (
              <button
                key={key}
                type="button"
                onClick={() => {
                  setFilter(key);
                  setFilterOpen(false);
                }}
                className="flex w-full items-center justify-between rounded-md px-2 py-1.5 text-left text-sm text-fg transition-colors hover:bg-hover hover:text-fg-strong"
              >
                {COMMENT_FILTERS[key]}
                {filter === key && (
                  <svg viewBox="0 0 20 20" fill="currentColor" className="h-4 w-4 text-pink-400" aria-hidden>
                    <path d="M16.7 5.3a1 1 0 0 1 0 1.4l-7 7a1 1 0 0 1-1.4 0l-3-3a1 1 0 1 1 1.4-1.4l2.3 2.29 6.3-6.29a1 1 0 0 1 1.4 0z" />
                  </svg>
                )}
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-2">
        {comments.loading ? (
          <div className="flex items-center justify-center gap-2 pt-8 text-sm text-fg-soft">
            <svg className="h-4 w-4 animate-spin text-accent-hover" viewBox="0 0 24 24" fill="none" aria-hidden>
              <circle cx="12" cy="12" r="9" stroke="currentColor" strokeOpacity="0.25" strokeWidth="3" />
              <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
            </svg>
            Loading comments…
          </div>
        ) : comments.threads.length === 0 ? (
          <p className="pt-8 text-center text-sm text-fg-faint">
            No comments yet. Add one at the current frame below.
          </p>
        ) : visible.length === 0 ? (
          <p className="pt-8 text-center text-sm text-fg-faint">
            No {filter === "open" ? "open" : "resolved"} comments.
          </p>
        ) : (
          visible.map((thread) => (
            <ThreadView
              key={thread.id}
              thread={thread}
              index={comments.threads.findIndex((t) => t.id === thread.id) + 1}
              onSeek={onSeek}
              isActive={activeMarkerId === thread.id}
              onFocus={() => setActiveMarkerId(thread.id)}
              onReply={comments.addReply}
              onToggleResolved={comments.toggleResolved}
              onDelete={comments.deleteComment}
              onToggleReaction={comments.toggleReaction}
            />
          ))
        )}
      </div>

      {/* Composer — a bordered card pinned to the playhead (or the in→out
          range when one is set), matching the reference. */}
      <div className="border-t border-line-strong p-3">
        <div className="rounded-xl border border-line bg-base p-2 transition-colors focus-within:border-pink-500/60">
          <div className="mb-2 flex items-center gap-2">
            <span
              className={cn(
                "inline-flex items-center gap-1 rounded px-1.5 py-0.5 font-mono text-[11px]",
                selection
                  ? "bg-rose-500/10 text-rose-300"
                  : "bg-elevated text-fg-soft",
              )}
            >
              <StopwatchIcon className="h-3 w-3" />
              {formatRange(start, end)}
            </span>
            <span className="text-[11px] text-fg-faint">
              {selection ? "range selected" : "at current frame"}
            </span>
            {selection && (
              <button
                type="button"
                onClick={onClearSelection}
                title="Clear range"
                className="ml-auto rounded p-0.5 text-fg-faint hover:bg-hover hover:text-fg-strong"
              >
                <svg className="h-3.5 w-3.5" viewBox="0 0 20 20" fill="currentColor" aria-hidden>
                  <path d="M10 8.6 5.7 4.3 4.3 5.7 8.6 10l-4.3 4.3 1.4 1.4L10 11.4l4.3 4.3 1.4-1.4L11.4 10l4.3-4.3-1.4-1.4z" />
                </svg>
              </button>
            )}
          </div>
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                submit();
              }
            }}
            rows={2}
            disabled={!comments.canComment}
            placeholder={
              comments.canComment
                ? `Add a comment at ${formatRange(start, end)}…`
                : "Comments are read-only here"
            }
            className="w-full resize-none bg-transparent px-1 text-sm text-fg-strong placeholder:text-fg-faint focus:outline-none disabled:opacity-60"
          />
          <div className="mt-1 flex items-center gap-0.5">
            <EmojiButton onPick={(em) => setDraft((d) => d + em)} />
            <AttachButton />
            <span className="ml-1 text-[11px] text-fg-faint">⏎ to send</span>
            <button
              type="button"
              onClick={submit}
              disabled={!draft.trim() || !comments.canComment}
              className="ml-auto inline-flex items-center gap-1.5 rounded-lg bg-pink-500 px-3.5 py-1.5 text-xs font-semibold text-white shadow-sm shadow-pink-500/30 hover:bg-pink-400 disabled:opacity-40 disabled:shadow-none"
            >
              Comment
            </button>
          </div>
        </div>
      </div>
    </>
  );
}

function ThreadView({
  thread,
  index,
  onSeek,
  isActive,
  onFocus,
  onReply,
  onToggleResolved,
  onDelete,
  onToggleReaction,
}: {
  thread: CommentThread;
  index: number;
  onSeek: (t: number) => void;
  isActive: boolean;
  onFocus: () => void;
  onReply: (parentId: string, body: string) => void;
  onToggleResolved: (id: string) => void;
  onDelete: (id: string) => void;
  onToggleReaction: (id: string, emoji: string) => void;
}) {
  const [showReplies, setShowReplies] = useState(true);
  const [replyDraft, setReplyDraft] = useState("");
  const [replying, setReplying] = useState(false);

  const submitReply = () => {
    onReply(thread.id, replyDraft);
    setReplyDraft("");
    setReplying(false);
  };

  const openReplyWith = (seed = "") => {
    setReplying(true);
    setReplyDraft((d) => d + seed);
  };

  return (
    <div
      onClick={onFocus}
      className={cn(
        "group rounded-xl px-2.5 py-3 transition-colors",
        isActive
          ? "bg-pink-500/10 ring-1 ring-pink-500/40"
          : "hover:bg-hover/50",
      )}
    >
      <CommentRow
        comment={thread}
        index={index}
        onSeek={onSeek}
        resolved={thread.resolved}
        onReact={(em) => onToggleReaction(thread.id, em)}
      />

      {/* Action row — always visible, mirrors the reference card. */}
      <div className="mt-2 flex items-center gap-3 pl-[42px] text-[11px] text-fg-soft">
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            openReplyWith();
          }}
          className="font-medium hover:text-fg-strong"
        >
          Reply
        </button>
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onToggleResolved(thread.id);
          }}
          className={cn(
            "inline-flex items-center gap-1 font-medium hover:text-fg-strong",
            thread.resolved && "text-emerald-400",
          )}
        >
          {thread.resolved ? (
            <>
              <svg className="h-3.5 w-3.5" viewBox="0 0 20 20" fill="currentColor" aria-hidden>
                <path d="M10 2a8 8 0 1 0 0 16 8 8 0 0 0 0-16zm3.7 6.3-4 4a1 1 0 0 1-1.4 0l-2-2a1 1 0 1 1 1.4-1.4l1.3 1.29 3.3-3.29a1 1 0 0 1 1.4 1.4z" />
              </svg>
              Resolved
            </>
          ) : (
            "Resolve"
          )}
        </button>
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onDelete(thread.id);
          }}
          className="ml-auto opacity-0 transition-opacity hover:text-rose-400 group-hover:opacity-100"
        >
          Delete
        </button>
      </div>

      {thread.replies.length > 0 && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            setShowReplies((s) => !s);
          }}
          className="mt-2 flex items-center gap-1 pl-[42px] text-xs font-medium text-pink-400 hover:text-pink-300"
        >
          {thread.replies.length} {thread.replies.length === 1 ? "Reply" : "Replies"}
          <svg
            className={cn("h-3 w-3 transition-transform", showReplies && "rotate-180")}
            viewBox="0 0 20 20"
            fill="currentColor"
            aria-hidden
          >
            <path d="M5 8l5 5 5-5z" />
          </svg>
        </button>
      )}

      {showReplies &&
        thread.replies.map((reply) => (
          <div key={reply.id} className="mt-3 pl-6">
            <CommentRow
              comment={reply}
              onSeek={onSeek}
              isReply
              onReact={(em) => onToggleReaction(reply.id, em)}
            />
          </div>
        ))}

      {replying && (
        <div className="mt-2 pl-[42px]" onClick={(e) => e.stopPropagation()}>
          <div className="rounded-lg border border-line bg-base p-1.5 transition-colors focus-within:border-pink-500/60">
            <textarea
              autoFocus
              value={replyDraft}
              onChange={(e) => setReplyDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  submitReply();
                }
                if (e.key === "Escape") setReplying(false);
              }}
              rows={1}
              placeholder="Leave your reply here…"
              className="min-h-[28px] w-full resize-none bg-transparent px-1 text-sm text-fg-strong placeholder:text-fg-faint focus:outline-none"
            />
            <div className="mt-0.5 flex items-center gap-0.5">
              <EmojiButton onPick={(em) => setReplyDraft((d) => d + em)} />
              <AttachButton />
              <button
                type="button"
                onClick={() => setReplying(false)}
                className="ml-auto rounded-md px-2.5 py-1 text-xs font-medium text-fg-soft hover:bg-hover hover:text-fg-strong"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={submitReply}
                disabled={!replyDraft.trim()}
                className="rounded-md bg-pink-500 px-2.5 py-1 text-xs font-semibold text-white hover:bg-pink-400 disabled:opacity-40"
              >
                Reply
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function CommentRow({
  comment,
  index,
  onSeek,
  isReply,
  resolved,
  onReact,
}: {
  comment: Comment;
  index?: number;
  onSeek: (t: number) => void;
  isReply?: boolean;
  resolved?: boolean;
  onReact?: (emoji: string) => void;
}) {
  const reactions = comment.reactions ?? [];
  return (
    <div className="flex gap-2.5">
      <Avatar label={comment.author.name || comment.author.email} reply={isReply} />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-sm font-semibold text-fg-strong">
            {comment.author.name || comment.author.email}
          </span>
          <span className="shrink-0 text-[11px] text-fg-faint">
            {formatRelative(comment.createdAt)}
          </span>
          {/* Top-level comments show a pink index badge and a "shared with the
              project" people glyph — our own marks, not Frame.io's globe. */}
          {!isReply && (
            <span className="ml-auto flex shrink-0 items-center gap-1.5">
              {index !== undefined && (
                <span className="rounded-md bg-pink-500/12 px-1.5 py-0.5 text-[10px] font-semibold tabular-nums text-pink-300">
                  #{index}
                </span>
              )}
              <SharedIcon className="h-3.5 w-3.5 text-fg-faint" />
            </span>
          )}
        </div>

        {/* Timecode / range chip in coral, with a stopwatch — seeks on click.
            Replies inherit the thread's time and don't repeat it. */}
        {!isReply && (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onSeek(comment.t);
            }}
            className="mt-1 inline-flex items-center gap-1 rounded bg-rose-500/10 px-1.5 py-0.5 font-mono text-[11px] text-rose-300 transition-colors hover:bg-rose-500/20 hover:text-rose-200"
          >
            <StopwatchIcon className="h-3 w-3" />
            {formatRange(comment.t, comment.tEnd)}
          </button>
        )}

        <p
          className={cn(
            "mt-1 whitespace-pre-wrap break-words text-sm",
            resolved ? "text-fg-faint line-through" : "text-fg",
          )}
        >
          {comment.body}
        </p>

        {/* Emoji reactions: each pill toggles the current user's reaction;
            the trailing button opens the picker to add a new one. */}
        {(reactions.length > 0 || onReact) && (
          <div className="mt-1.5 flex flex-wrap items-center gap-1">
            {reactions.map((r) => (
              <button
                key={r.emoji}
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  onReact?.(r.emoji);
                }}
                title={r.mine ? "Remove your reaction" : "React"}
                className={cn(
                  "inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-xs leading-none ring-1 transition-colors",
                  r.mine
                    ? "bg-pink-500/15 text-pink-200 ring-pink-500/40"
                    : "bg-elevated text-fg-soft ring-line hover:bg-hover",
                )}
              >
                <span className="text-sm leading-none">{r.emoji}</span>
                <span className="tabular-nums">{r.count}</span>
              </button>
            ))}
            {onReact && <AddReactionButton onPick={onReact} />}
          </div>
        )}
      </div>
    </div>
  );
}

// AddReactionButton: a compact "react" trigger (smiley + plus) that opens the
// emoji picker; picking calls onPick to toggle that reaction.
function AddReactionButton({ onPick }: { onPick: (emoji: string) => void }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="relative">
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          setOpen((o) => !o);
        }}
        title="Add reaction"
        aria-label="Add reaction"
        className={cn(
          "inline-flex items-center gap-0.5 rounded-full px-1.5 py-1 text-fg-faint ring-1 ring-line transition-colors hover:bg-hover hover:text-fg-strong",
          open && "bg-hover text-pink-400",
        )}
      >
        <svg viewBox="0 0 20 20" fill="none" className="h-3.5 w-3.5" aria-hidden>
          <circle cx="9" cy="9" r="6" stroke="currentColor" strokeWidth="1.5" />
          <path d="M6.8 7.4h.01M11.2 7.4h.01M6.6 11c1.1.9 3.1.9 4.2 0" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        </svg>
        <span className="text-[11px] font-semibold leading-none">+</span>
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-30" onClick={() => setOpen(false)} />
          <div
            onClick={(e) => e.stopPropagation()}
            className="absolute bottom-full left-0 z-40 mb-1.5 overflow-hidden rounded-xl shadow-2xl shadow-black/60"
          >
            <EmojiPicker
              onEmojiClick={(d) => {
                onPick(d.emoji);
                setOpen(false);
              }}
              theme={Theme.DARK}
              emojiStyle={EmojiStyle.NATIVE}
              lazyLoadEmojis
              width={300}
              height={380}
              previewConfig={{ showPreview: false }}
              skinTonesDisabled
            />
          </div>
        </>
      )}
    </div>
  );
}

// Pink-forward palette to match the review theme; still hashed per author so
// distinct collaborators stay visually distinguishable.
const PALETTES = [
  "bg-pink-500 text-white",
  "bg-fuchsia-500 text-white",
  "bg-rose-500 text-white",
  "bg-violet-500 text-white",
  "bg-purple-500 text-white",
  "bg-pink-600 text-white",
];

function hashIndex(s: string, mod: number): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h % mod;
}

function Avatar({ label, reply }: { label: string; reply?: boolean }) {
  const palette = PALETTES[hashIndex(label.toLowerCase(), PALETTES.length)];
  return (
    <span
      className={cn(
        "flex shrink-0 items-center justify-center rounded-lg font-semibold shadow-sm",
        reply ? "h-6 w-6 text-[10px]" : "h-8 w-8 text-xs",
        palette,
      )}
      aria-hidden
    >
      {initialsOf(label)}
    </span>
  );
}
