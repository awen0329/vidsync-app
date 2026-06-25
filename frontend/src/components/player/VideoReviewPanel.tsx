import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { useCloudMe } from "../../api/cloud/hooks";
import { VideoStage, type MediaInfo, type Selection } from "./VideoStage";
import { ImageStage } from "./ImageStage";
import { CommentsSidebar } from "./CommentsSidebar";
import { useComments, type CommentAuthor } from "./comments";
import { useCommentStream } from "./useCommentStream";
import { displayName } from "./format";
import { cn } from "../../lib/utils";
import { clearActiveVideo, setActiveVideo } from "../../lib/activeVideo";
import { markSeen } from "../../lib/commentSeen";
import type { VideoPreviewFile } from "../VideoPreviewModal";

// VideoReviewPanel is the review player rendered INLINE inside its container
// (the file browser's grid area) rather than as a modal overlay.
//
// Two layers:
//   - The outer shell owns things that should SURVIVE a clip switch: the SSE
//     comment stream (one per project) and the maximize state.
//   - ReviewBody is keyed by the clip path, so switching to another video in
//     the tree fully remounts it — clearing the in/out selection, the typed
//     comment draft, playhead, and metadata for the old clip rather than
//     leaking them onto the new one.
//
// Maximize: the header's expand button positions the panel `fixed` over the
// measured #vidsync-main region (tracks the collapsible sidebar + resizes),
// so the <video> stays mounted and playback doesn't restart on toggle.

function useMainRect(active: boolean): DOMRect | null {
  const [rect, setRect] = useState<DOMRect | null>(null);
  useLayoutEffect(() => {
    if (!active) {
      setRect(null);
      return;
    }
    const el = document.getElementById("vidsync-main");
    if (!el) return;
    const update = () => setRect(el.getBoundingClientRect());
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    window.addEventListener("resize", update);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", update);
    };
  }, [active]);
  return rect;
}

export function VideoReviewPanel({
  file,
  onClose,
  filesPanelVisible,
  onToggleFilesPanel,
}: {
  file: VideoPreviewFile;
  onClose: () => void;
  // The in-project file tree's visibility + toggle, surfaced here as the
  // first of the three Frame.io-style layout buttons. Optional: when the
  // player is hosted somewhere without a files panel, that button hides.
  filesPanelVisible?: boolean;
  onToggleFilesPanel?: () => void;
}) {
  const me = useCloudMe();
  const author: CommentAuthor = {
    email: me.data?.email ?? "",
    name: displayName(undefined, me.data?.email ?? "You"),
  };

  // One SSE connection per project (folder), live while the player is open —
  // survives clip switches within the same project.
  useCommentStream(file.folderID);

  const [maximized, setMaximized] = useState(false);
  // Comments/Inspector rail visibility — collapse it to give the video the
  // full width. Persists across clip switches (lives in the outer shell).
  const [showSidebar, setShowSidebar] = useState(true);
  const mainRect = useMainRect(maximized);

  // Esc exits maximize (but leaves the player open).
  useEffect(() => {
    if (!maximized) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === "TEXTAREA" || tag === "INPUT") return;
      setMaximized(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [maximized]);

  const maxStyle =
    maximized && mainRect
      ? {
          position: "fixed" as const,
          top: mainRect.top,
          left: mainRect.left,
          width: mainRect.width,
          height: mainRect.height,
          zIndex: 40,
        }
      : undefined;

  return (
    <div
      style={maxStyle}
      className={cn(
        "flex min-h-0 flex-col overflow-hidden border border-line-strong bg-panel",
        maximized ? "rounded-none" : "h-full rounded-lg",
      )}
    >
      <header className="flex items-center gap-3 border-b border-line-strong px-3 py-2.5">
        <button
          type="button"
          onClick={onClose}
          className="inline-flex shrink-0 items-center gap-1.5 rounded-md px-2 py-1 text-sm text-fg-soft transition-colors hover:bg-hover hover:text-fg-strong"
        >
          <svg viewBox="0 0 20 20" fill="currentColor" className="h-4 w-4" aria-hidden>
            <path
              fillRule="evenodd"
              d="M12.707 5.293a1 1 0 010 1.414L9.414 10l3.293 3.293a1 1 0 01-1.414 1.414l-4-4a1 1 0 010-1.414l4-4a1 1 0 011.414 0z"
              clipRule="evenodd"
            />
          </svg>
          Back
        </button>
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium text-fg-strong">{file.name}</div>
          <div className="truncate font-mono text-[11px] text-fg-soft">{file.path}</div>
        </div>
        {/* Three Frame.io-style layout toggles: files panel · player ·
            comments. The player segment is always-on (you're in it); the
            two side segments show/hide their panels. The files toggle only
            appears when a host panel was wired through. */}
        <div className="inline-flex shrink-0 items-center rounded-lg bg-base p-0.5 ring-1 ring-line-strong">
          {onToggleFilesPanel && (
            <LayoutToggle
              active={!!filesPanelVisible}
              onClick={onToggleFilesPanel}
              title={filesPanelVisible ? "Hide files panel" : "Show files panel"}
              side="left"
            />
          )}
          <LayoutToggle active onClick={() => {}} title="Player" side="center" />
          <LayoutToggle
            active={showSidebar}
            onClick={() => setShowSidebar((s) => !s)}
            title={showSidebar ? "Hide comments" : "Show comments"}
            side="right"
          />
        </div>
        <button
          type="button"
          onClick={() => setMaximized((m) => !m)}
          title={maximized ? "Exit full screen (Esc)" : "Full screen"}
          aria-label={maximized ? "Exit full screen" : "Full screen"}
          className="shrink-0 rounded-md p-1.5 text-fg-soft transition-colors hover:bg-hover hover:text-fg-strong"
        >
          {maximized ? (
            <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4" aria-hidden>
              <path d="M8 3v5H3M12 3v5h5M8 17v-5H3M12 17v-5h5" />
            </svg>
          ) : (
            <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4" aria-hidden>
              <path d="M3 7V3h4M17 7V3h-4M3 13v4h4M17 13v4h-4" />
            </svg>
          )}
        </button>
      </header>

      {/* Keyed by clip so per-video state (selection, draft, playhead, meta)
          resets when the user picks another video in the tree. */}
      <ReviewBody
        key={`${file.folderID}:${file.path}`}
        file={file}
        author={author}
        showSidebar={showSidebar}
      />
    </div>
  );
}

function ReviewBody({
  file,
  author,
  showSidebar,
}: {
  file: VideoPreviewFile;
  author: CommentAuthor;
  showSidebar: boolean;
}) {
  const comments = useComments(file.folderID, file.path, author);

  const [currentTime, setCurrentTime] = useState(0);
  const [activeMarkerId, setActiveMarkerId] = useState<string | null>(null);
  const [selection, setSelection] = useState<Selection | null>(null);
  const [media, setMedia] = useState<MediaInfo | null>(null);

  // Mark this clip as the active one so the background notifier doesn't toast
  // for comments on the video the user is already watching.
  useEffect(() => {
    setActiveVideo(file.folderID, file.path);
    return () => clearActiveVideo();
  }, [file.folderID, file.path]);

  // While the clip is open, keep its "seen" marker at the newest comment, so
  // it never shows as unread in the browser (and new comments arriving while
  // viewing are acknowledged live). After close, anything newer is unread.
  useEffect(() => {
    let latest = "";
    for (const t of comments.threads) {
      if (t.createdAt > latest) latest = t.createdAt;
      for (const r of t.replies) if (r.createdAt > latest) latest = r.createdAt;
    }
    if (latest) markSeen(file.folderID, file.path, latest);
  }, [comments.threads, file.folderID, file.path]);

  const seekFn = useRef<(t: number) => void>(() => {});
  const registerSeek = useCallback((fn: (t: number) => void) => {
    seekFn.current = fn;
  }, []);
  const onSeek = useCallback((t: number) => seekFn.current(t), []);
  const onPlayback = useCallback((t: number) => setCurrentTime(t), []);

  const onClearSelection = () => setSelection(null);

  // Images use a plain still viewer (no timeline/scrubber); video and audio
  // share the media-element player in VideoStage.
  const isImage = (file.kind ?? "video") === "image";

  return (
    <div className="flex min-h-0 flex-1">
      {isImage ? (
        <ImageStage file={file} onMeta={setMedia} />
      ) : (
        <VideoStage
          file={file}
          markers={comments.pins}
          activeMarkerId={activeMarkerId}
          selection={selection}
          onPlayback={onPlayback}
          onMeta={setMedia}
          onMarkerClick={(c) => setActiveMarkerId(c.id)}
          onSelectionChange={setSelection}
          registerSeek={registerSeek}
        />
      )}
      {showSidebar && (
        <CommentsSidebar
          file={file}
          media={media}
          comments={comments}
          currentTime={currentTime}
          selection={selection}
          onClearSelection={onClearSelection}
          onSeek={onSeek}
          activeMarkerId={activeMarkerId}
          setActiveMarkerId={setActiveMarkerId}
        />
      )}
    </div>
  );
}

// LayoutToggle: one segment of the three-up layout control in the player
// header. Each draws a window glyph with the relevant region filled —
// left panel, center stage, or right panel — and lights up cobalt when
// its panel is showing.
function LayoutToggle({
  active,
  onClick,
  title,
  side,
}: {
  active: boolean;
  onClick: () => void;
  title: string;
  side: "left" | "center" | "right";
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      aria-label={title}
      aria-pressed={active}
      className={cn(
        "flex h-7 w-8 items-center justify-center rounded-md transition-colors",
        active
          ? "bg-accent/20 text-accent"
          : "text-fg-soft hover:bg-hover hover:text-fg-strong",
      )}
    >
      <svg viewBox="0 0 22 18" fill="none" className="h-4 w-[18px]" aria-hidden>
        <rect x="1.5" y="2" width="19" height="14" rx="2.5" stroke="currentColor" strokeWidth="1.6" />
        {side === "left" && (
          <rect x="1.5" y="2" width="6.5" height="14" rx="2.5" fill="currentColor" fillOpacity="0.55" />
        )}
        {side === "center" && <path d="M9 6.5 13.5 9 9 11.5z" fill="currentColor" />}
        {side === "right" && (
          <rect x="14" y="2" width="6.5" height="14" rx="2.5" fill="currentColor" fillOpacity="0.55" />
        )}
      </svg>
    </button>
  );
}
