import { useCallback, useEffect, useRef, useState } from "react";
import { useCloudMe } from "../../api/cloud/hooks";
import { VideoStage, type MediaInfo, type Selection } from "./VideoStage";
import { ImageStage } from "./ImageStage";
import { CommentsSidebar } from "./CommentsSidebar";
import { useComments, type CommentAuthor } from "./comments";
import { useCommentStream } from "./useCommentStream";
import { displayName } from "./format";
import { clearActiveVideo, setActiveVideo } from "../../lib/activeVideo";
import { markSeen } from "../../lib/commentSeen";
import type { VideoPreviewFile } from "../VideoPreviewModal";

// VideoReviewPanel is the review player dock — the stage (video + scrubber)
// plus the comments rail. It's rendered as one of the side-by-side docks in
// ProjectDetail; the project top bar owns the panel toggles now, so this
// component carries no header of its own. `showComments` (driven by the top
// bar's 3rd toggle) collapses the comments rail to give the video full width.
//
// The outer shell owns the per-project SSE comment stream so it survives a
// clip switch; ReviewBody is keyed by clip path so per-clip state (in/out
// selection, draft, playhead, metadata) resets when the user picks another.

export function VideoReviewPanel({
  file,
  showComments = true,
}: {
  file: VideoPreviewFile;
  showComments?: boolean;
}) {
  const me = useCloudMe();
  const author: CommentAuthor = {
    email: me.data?.email ?? "",
    name: displayName(undefined, me.data?.email ?? "You"),
  };

  // One SSE connection per project (folder), live while the player is open —
  // survives clip switches within the same project.
  useCommentStream(file.folderID);

  return (
    <ReviewBody
      key={`${file.folderID}:${file.path}`}
      file={file}
      author={author}
      showComments={showComments}
    />
  );
}

function ReviewBody({
  file,
  author,
  showComments,
}: {
  file: VideoPreviewFile;
  author: CommentAuthor;
  showComments: boolean;
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
      {showComments && (
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
