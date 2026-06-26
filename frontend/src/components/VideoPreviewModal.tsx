import { useEffect } from "react";
import { VideoReviewPanel } from "./player/VideoReviewPanel";
import type { MediaKind } from "../lib/videoFormats";

// VideoPreviewModal: modal wrapper around the shared VideoReviewPanel, used
// where the player opens as an overlay (e.g. the Transfers list). The file
// browser instead mounts VideoReviewPanel inline — see FileGrid.
//
// The src streaming logic lives in VideoStage; the comment data layer in
// player/comments.ts. The daemon serves Range responses, so seeking and
// partial buffering work without extra client logic.

export interface VideoPreviewFile {
  folderID: string;
  // POSIX-style relative path inside the folder. The daemon converts
  // to native separators server-side.
  path: string;
  name: string;
  size: number;
  // ISO mtime, used to bust the preview cache; optional for callers that
  // don't have it (they fall back to size-based versioning).
  modified?: string;
  // When true the browser can't decode this format, so play a short
  // server-transcoded preview (H.264 for video, AAC for audio) instead of
  // the raw bytes.
  transcode?: boolean;
  // Which surface the file opens in. Defaults to "video" for older callers
  // (e.g. the Transfers list, which only previews video).
  kind?: MediaKind;
}

export function VideoPreviewModal({
  file,
  onClose,
}: {
  file: VideoPreviewFile | null;
  onClose: () => void;
}) {
  // Close on Escape, regardless of focus — but not while typing a comment.
  useEffect(() => {
    if (!file) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      const el = e.target as HTMLElement | null;
      const tag = el?.tagName;
      if (tag === "TEXTAREA" || tag === "INPUT") return;
      onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [file, onClose]);

  if (!file) return null;
  return (
    <div
      className="fixed inset-0 z-50 flex flex-col items-center justify-center bg-base/95 px-4 py-4"
      onClick={onClose}
    >
      <div
        className="relative flex h-[88vh] w-full max-w-7xl gap-1.5"
        onClick={(e) => e.stopPropagation()}
      >
        <button
          type="button"
          onClick={onClose}
          aria-label="Close preview"
          className="absolute right-2 top-2 z-10 flex h-8 w-8 items-center justify-center rounded-lg bg-base/70 text-fg-soft backdrop-blur-sm transition-colors hover:bg-hover hover:text-fg-strong"
        >
          <svg viewBox="0 0 20 20" fill="currentColor" className="h-4 w-4" aria-hidden>
            <path d="M10 8.6 5.7 4.3 4.3 5.7 8.6 10l-4.3 4.3 1.4 1.4L10 11.4l4.3 4.3 1.4-1.4L11.4 10l4.3-4.3-1.4-1.4z" />
          </svg>
        </button>
        <VideoReviewPanel file={file} />
      </div>
    </div>
  );
}

// Re-export so existing callers (`import { buildFileURL } from
// "./VideoPreviewModal"`) keep working. The implementation moved to
// lib/fileURL.ts so lazy-loading this modal doesn't pull the URL
// helper out of the main chunk.
export { buildFileURL } from "../lib/fileURL";
