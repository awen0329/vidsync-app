import { useState } from "react";
import { cn } from "../../lib/utils";
import { humanBytes } from "../../lib/format";
import { initialsOf } from "../PresenceAvatar";
import type { Comment, CommentThread, UseComments } from "./comments";
import type { MediaInfo, Selection } from "./VideoStage";
import { formatClock, formatRange, formatRelative } from "./format";
import type { VideoPreviewFile } from "../VideoPreviewModal";

type Tab = "comments" | "inspector";

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
    <aside className="flex w-[340px] shrink-0 flex-col border-l border-line-strong bg-panel">
      <nav className="flex items-center gap-4 border-b border-line-strong px-4 pt-3 text-sm">
        <TabButton label="Comments" active={tab === "comments"} onClick={() => setTab("comments")} />
        <TabButton label="Inspector" active={tab === "inspector"} onClick={() => setTab("inspector")} />
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
        <InspectorTab file={file} media={media} comments={comments} />
      )}
    </aside>
  );
}

// InspectorTab shows clip metadata: file identity from the browse entry plus
// duration / resolution read off the loaded <video>.
function InspectorTab({
  file,
  media,
  comments,
}: {
  file: VideoPreviewFile;
  media: MediaInfo | null;
  comments: UseComments;
}) {
  const ext = file.name.includes(".")
    ? file.name.split(".").pop()!.toUpperCase()
    : "—";
  const kindWord =
    file.kind === "audio" ? "audio" : file.kind === "image" ? "image" : "video";
  const replies = comments.threads.reduce((n, t) => n + t.replies.length, 0);
  const openCount = comments.threads.filter((t) => !t.resolved).length;

  // "Location" is the folder the clip lives in (relative to the project
  // root) — not the path including the filename, which would just repeat
  // "Name" for clips at the root.
  const slash = file.path.lastIndexOf("/");
  const folder = slash >= 0 ? file.path.slice(0, slash) : "";

  const rows: { label: string; value: string }[] = [
    { label: "Name", value: file.name },
    { label: "Location", value: folder ? `${folder}/` : "Project root" },
    { label: "Kind", value: ext === "—" ? "File" : `${ext} ${kindWord}` },
    { label: "Size", value: humanBytes(file.size) },
    {
      label: "Resolution",
      value: media && media.width > 0 ? `${media.width} × ${media.height}` : "—",
    },
    {
      label: "Duration",
      value: media && media.duration > 0 ? formatClock(media.duration) : "—",
    },
    {
      label: "Modified",
      value: file.modified ? new Date(file.modified).toLocaleString() : "—",
    },
    {
      label: "Comments",
      value: `${comments.pins.length} (${openCount} open) · ${replies} repl${replies === 1 ? "y" : "ies"}`,
    },
  ];

  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
      <dl className="space-y-3">
        {rows.map((r) => (
          <div key={r.label} className="flex flex-col gap-0.5">
            <dt className="text-[11px] font-semibold uppercase tracking-wide text-fg-faint">
              {r.label}
            </dt>
            <dd
              className={cn(
                "break-words text-sm text-fg-strong",
                (r.label === "Location" || r.label === "Name") && "font-mono text-[12px]",
              )}
            >
              {r.value}
            </dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

function TabButton({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "-mb-px border-b-2 pb-2 font-medium transition-colors",
        active
          ? "border-accent-hover text-fg-strong"
          : "border-transparent text-fg-soft hover:text-fg-strong",
      )}
    >
      {label}
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

  // Pin to the in→out selection when one is set, otherwise the playhead.
  const start = selection ? selection.in : currentTime;
  const end = selection ? selection.out : undefined;

  const submit = () => {
    comments.addComment(start, draft, end);
    setDraft("");
    onClearSelection();
  };

  return (
    <>
      <header className="px-4 py-3 text-base font-semibold text-fg-strong">
        Comments
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-2">
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
        ) : (
          comments.threads.map((thread) => (
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

      {/* Composer pinned to the current playhead. */}
      <div className="border-t border-line-strong p-3">
        <div className="flex items-end gap-2">
          <span
            className={cn(
              "mb-1.5 shrink-0 rounded px-1.5 py-0.5 font-mono text-[11px]",
              selection
                ? "bg-accent/20 text-accent"
                : "bg-elevated text-fg-soft",
            )}
            title={selection ? "Comment range (in → out)" : "Comment at current frame"}
          >
            {formatRange(start, end)}
          </span>
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                submit();
              }
            }}
            rows={1}
            disabled={!comments.canComment}
            placeholder={
              comments.canComment ? "Add a comment…" : "Comments are read-only here"
            }
            className="min-h-[34px] flex-1 resize-none rounded-md border border-line bg-base px-2.5 py-1.5 text-sm text-fg-strong placeholder:text-fg-faint focus:border-accent-hover focus:outline-none disabled:opacity-60"
          />
          <button
            type="button"
            onClick={submit}
            disabled={!draft.trim() || !comments.canComment}
            aria-label="Send comment"
            className="mb-0.5 shrink-0 rounded-md bg-accent p-2 text-white hover:bg-accent-hover disabled:opacity-40"
          >
            <svg className="h-4 w-4" viewBox="0 0 20 20" fill="currentColor" aria-hidden>
              <path d="M2 10l15-7-7 15-2-6-6-2z" />
            </svg>
          </button>
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
        "rounded-lg px-2 py-3 transition-colors",
        isActive && "bg-elevated/60",
      )}
    >
      <CommentRow
        comment={thread}
        onSeek={onSeek}
        resolved={thread.resolved}
        onToggleResolved={() => onToggleResolved(thread.id)}
        onDelete={() => onDelete(thread.id)}
      />

      {thread.replies.length > 0 && (
        <button
          type="button"
          onClick={() => setShowReplies((s) => !s)}
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

      {replying ? (
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
      ) : (
        <button
          type="button"
          onClick={() => setReplying(true)}
          className="mt-2 pl-9 text-xs text-fg-soft hover:text-fg-strong"
        >
          Reply
        </button>
      )}
    </div>
  );
}

function CommentRow({
  comment,
  onSeek,
  isReply,
  resolved,
  onToggleResolved,
  onDelete,
}: {
  comment: Comment;
  onSeek: (t: number) => void;
  isReply?: boolean;
  resolved?: boolean;
  onToggleResolved?: () => void;
  onDelete?: () => void;
}) {
  return (
    <div className="group flex gap-2.5">
      <Avatar label={comment.author.name || comment.author.email} reply={isReply} />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-sm font-medium text-fg-strong">
            {comment.author.name || comment.author.email}
          </span>
          <span className="shrink-0 text-[11px] text-fg-faint">
            {formatRelative(comment.createdAt)}
          </span>
          {onToggleResolved && (
            <div className="ml-auto flex shrink-0 items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100">
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  onToggleResolved();
                }}
                title={resolved ? "Mark unresolved" : "Mark resolved"}
                className="rounded p-0.5 text-fg-soft hover:bg-base hover:text-emerald-400"
              >
                <svg className="h-4 w-4" viewBox="0 0 20 20" fill="currentColor" aria-hidden>
                  <path
                    fillRule="evenodd"
                    d="M16.7 5.3a1 1 0 010 1.4l-7 7a1 1 0 01-1.4 0l-3-3a1 1 0 011.4-1.4l2.3 2.29 6.3-6.29a1 1 0 011.4 0z"
                    clipRule="evenodd"
                  />
                </svg>
              </button>
              {onDelete && (
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    onDelete();
                  }}
                  title="Delete"
                  className="rounded p-0.5 text-fg-soft hover:bg-base hover:text-rose-400"
                >
                  <svg className="h-4 w-4" viewBox="0 0 20 20" fill="currentColor" aria-hidden>
                    <path d="M6 7h8l-.7 9H6.7L6 7zM8 4h4l1 2H7l1-2z" />
                  </svg>
                </button>
              )}
            </div>
          )}
        </div>
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onSeek(comment.t);
          }}
          className="mr-1.5 mt-0.5 inline-block rounded bg-elevated px-1.5 py-0.5 align-middle font-mono text-[11px] text-fg-soft hover:bg-base hover:text-accent"
        >
          {formatRange(comment.t, comment.tEnd)}
        </button>
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
