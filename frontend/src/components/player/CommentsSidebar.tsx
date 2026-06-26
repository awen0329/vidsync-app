import { useState } from "react";
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
          ? "border-accent-hover text-fg-strong"
          : "border-transparent text-fg-soft hover:text-fg-strong",
      )}
    >
      {label}
      {count !== undefined && count > 0 && (
        <span className="rounded-full bg-accent/15 px-1.5 text-[11px] text-accent">
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
                  <svg viewBox="0 0 20 20" fill="currentColor" className="h-4 w-4 text-accent" aria-hidden>
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
              onSeek={onSeek}
              isActive={activeMarkerId === thread.id}
              onFocus={() => setActiveMarkerId(thread.id)}
              onReply={comments.addReply}
              onToggleResolved={comments.toggleResolved}
              onDelete={comments.deleteComment}
            />
          ))
        )}
      </div>

      {/* Composer — a bordered card pinned to the playhead (or the in→out
          range when one is set), matching the reference. */}
      <div className="border-t border-line-strong p-3">
        <div className="rounded-xl border border-line bg-base p-2 focus-within:border-accent">
          <div className="mb-2 flex items-center gap-2">
            <span
              className={cn(
                "rounded px-1.5 py-0.5 font-mono text-[11px]",
                selection ? "bg-accent/15 text-accent" : "bg-elevated text-fg-soft",
              )}
            >
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
          <div className="mt-1 flex items-center gap-1">
            <span className="rounded-md px-1.5 py-1 text-[11px] text-fg-faint">
              ⏎ to send
            </span>
            <button
              type="button"
              onClick={submit}
              disabled={!draft.trim() || !comments.canComment}
              className="ml-auto inline-flex items-center gap-1.5 rounded-lg bg-accent px-3.5 py-1.5 text-xs font-semibold text-white hover:bg-accent-hover disabled:opacity-40"
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
  onSeek,
  isActive,
  onFocus,
  onReply,
  onToggleResolved,
  onDelete,
}: {
  thread: CommentThread;
  onSeek: (t: number) => void;
  isActive: boolean;
  onFocus: () => void;
  onReply: (parentId: string, body: string) => void;
  onToggleResolved: (id: string) => void;
  onDelete: (id: string) => void;
}) {
  const [showReplies, setShowReplies] = useState(true);
  const [replyDraft, setReplyDraft] = useState("");
  const [replying, setReplying] = useState(false);

  const submitReply = () => {
    onReply(thread.id, replyDraft);
    setReplyDraft("");
    setReplying(false);
  };

  return (
    <div
      onClick={onFocus}
      className={cn(
        "group rounded-lg px-2 py-3 transition-colors",
        isActive
          ? "bg-elevated/70 ring-1 ring-accent/30"
          : "hover:bg-hover/40",
      )}
    >
      <CommentRow comment={thread} onSeek={onSeek} resolved={thread.resolved} />

      {/* Action row — always visible, mirrors the reference card. */}
      <div className="mt-2 flex items-center gap-3 pl-9 text-[11px] text-fg-soft">
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            setReplying(true);
          }}
          className="hover:text-fg-strong"
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
            "hover:text-fg-strong",
            thread.resolved && "text-emerald-300",
          )}
        >
          {thread.resolved ? "Unresolve" : "Resolve"}
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
          className="mt-2 flex items-center gap-1 pl-9 text-xs text-fg-soft hover:text-fg-strong"
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
            <CommentRow comment={reply} onSeek={onSeek} isReply />
          </div>
        ))}

      {replying && (
        <div className="mt-2 flex items-end gap-2 pl-9">
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
            placeholder="Reply…"
            className="min-h-[32px] flex-1 resize-none rounded-md border border-line bg-base px-2 py-1 text-sm text-fg-strong placeholder:text-fg-faint focus:border-accent-hover focus:outline-none"
          />
          <button
            type="button"
            onClick={submitReply}
            disabled={!replyDraft.trim()}
            className="mb-0.5 shrink-0 rounded bg-accent px-2 py-1 text-xs text-white hover:bg-accent-hover disabled:opacity-40"
          >
            Reply
          </button>
        </div>
      )}
    </div>
  );
}

function CommentRow({
  comment,
  onSeek,
  isReply,
  resolved,
}: {
  comment: Comment;
  onSeek: (t: number) => void;
  isReply?: boolean;
  resolved?: boolean;
}) {
  const isRange = comment.tEnd !== undefined && comment.tEnd > comment.t;
  return (
    <div className="flex gap-2.5">
      <Avatar label={comment.author.name || comment.author.email} reply={isReply} />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-sm font-medium text-fg-strong">
            {comment.author.name || comment.author.email}
          </span>
          <span className="shrink-0 text-[11px] text-fg-faint">
            {formatRelative(comment.createdAt)}
          </span>
          {/* Resolved badge takes precedence; otherwise a range comment shows
              its in→out span here (top-right), matching the reference. */}
          {!isReply && resolved ? (
            <span className="ml-auto inline-flex shrink-0 items-center gap-1 rounded-full bg-emerald-500/15 px-1.5 py-0.5 text-[10px] text-emerald-300">
              <svg className="h-3 w-3" viewBox="0 0 20 20" fill="currentColor" aria-hidden>
                <path d="M16.7 5.3a1 1 0 0 1 0 1.4l-7 7a1 1 0 0 1-1.4 0l-3-3a1 1 0 1 1 1.4-1.4l2.3 2.29 6.3-6.29a1 1 0 0 1 1.4 0z" />
              </svg>
              Resolved
            </span>
          ) : !isReply && isRange ? (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onSeek(comment.t);
              }}
              className="ml-auto shrink-0 rounded bg-accent/15 px-1.5 py-0.5 font-mono text-[10px] text-accent hover:bg-accent/25"
            >
              {formatRange(comment.t, comment.tEnd)}
            </button>
          ) : null}
        </div>
        <div className="mt-1">
          {/* Point comments lead with an inline timecode chip; range comments
              carry their span in the header chip above. */}
          {!isReply && !isRange && (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onSeek(comment.t);
              }}
              className={cn(
                "mr-1.5 inline-block rounded bg-elevated px-1.5 py-0.5 align-middle font-mono text-[11px] hover:bg-base hover:text-accent",
                resolved ? "text-fg-soft" : "text-accent",
              )}
            >
              {formatRange(comment.t, comment.tEnd)}
            </button>
          )}
          <span
            className={cn(
              "align-middle text-sm text-fg",
              resolved && "text-fg-faint line-through",
            )}
          >
            {comment.body}
          </span>
        </div>
      </div>
    </div>
  );
}

const PALETTES = [
  "bg-accent/20 text-accent",
  "bg-emerald-500/20 text-emerald-200",
  "bg-amber-500/20 text-amber-200",
  "bg-violet-500/20 text-violet-200",
  "bg-rose-500/20 text-rose-200",
  "bg-cyan-500/20 text-cyan-200",
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
        "flex shrink-0 items-center justify-center rounded-full font-semibold",
        reply ? "h-6 w-6 text-[10px]" : "h-7 w-7 text-[11px]",
        palette,
      )}
      aria-hidden
    >
      {initialsOf(label)}
    </span>
  );
}
