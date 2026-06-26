import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import { useCloudMe } from "../../api/cloud/hooks";
import { VideoStage, type MediaInfo, type Selection } from "./VideoStage";
import { ImageStage } from "./ImageStage";
import { CommentsSidebar } from "./CommentsSidebar";
import { useComments, type CommentAuthor, type UseComments } from "./comments";
import { useCommentStream } from "./useCommentStream";
import { displayName } from "./format";
import { clearActiveVideo, setActiveVideo } from "../../lib/activeVideo";
import { markSeen } from "../../lib/commentSeen";
import type { VideoPreviewFile } from "../VideoPreviewModal";

// ReviewContext lifts the per-clip review state (comment stream + data,
// playhead, in/out selection, media metadata, seek wiring) above the player
// and comments docks so each can mount, hide, and animate independently —
// the player toggle no longer takes the comments with it.

interface ReviewContextValue {
  file: VideoPreviewFile;
  comments: UseComments;
  currentTime: number;
  selection: Selection | null;
  setSelection: (s: Selection | null) => void;
  media: MediaInfo | null;
  setMedia: (m: MediaInfo | null) => void;
  activeMarkerId: string | null;
  setActiveMarkerId: (id: string | null) => void;
  registerSeek: (fn: (t: number) => void) => void;
  onSeek: (t: number) => void;
  onPlayback: (t: number) => void;
  onClearSelection: () => void;
}

const ReviewContext = createContext<ReviewContextValue | null>(null);

function useReview(): ReviewContextValue {
  const v = useContext(ReviewContext);
  if (!v) throw new Error("useReview must be used inside ReviewProvider");
  return v;
}

export function ReviewProvider({
  file,
  children,
}: {
  file: VideoPreviewFile;
  children: React.ReactNode;
}) {
  const me = useCloudMe();
  const author: CommentAuthor = {
    email: me.data?.email ?? "",
    name: displayName(undefined, me.data?.email ?? "You"),
  };
  // One SSE stream per project — folderID is stable across clip switches, so
  // this outer layer is NOT keyed and the connection survives them.
  useCommentStream(file.folderID);
  return (
    <ReviewInner key={`${file.folderID}:${file.path}`} file={file} author={author}>
      {children}
    </ReviewInner>
  );
}

function ReviewInner({
  file,
  author,
  children,
}: {
  file: VideoPreviewFile;
  author: CommentAuthor;
  children: React.ReactNode;
}) {
  const comments = useComments(file.folderID, file.path, author);
  const [currentTime, setCurrentTime] = useState(0);
  const [activeMarkerId, setActiveMarkerId] = useState<string | null>(null);
  const [selection, setSelection] = useState<Selection | null>(null);
  const [media, setMedia] = useState<MediaInfo | null>(null);

  useEffect(() => {
    setActiveVideo(file.folderID, file.path);
    return () => clearActiveVideo();
  }, [file.folderID, file.path]);

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
  const onClearSelection = useCallback(() => setSelection(null), []);

  const value: ReviewContextValue = {
    file,
    comments,
    currentTime,
    selection,
    setSelection,
    media,
    setMedia,
    activeMarkerId,
    setActiveMarkerId,
    registerSeek,
    onSeek,
    onPlayback,
    onClearSelection,
  };
  return <ReviewContext.Provider value={value}>{children}</ReviewContext.Provider>;
}

// PlayerStage: the video (or still) viewer, reading everything off context.
export function PlayerStage() {
  const r = useReview();
  const isImage = (r.file.kind ?? "video") === "image";
  if (isImage) return <ImageStage file={r.file} onMeta={r.setMedia} />;
  return (
    <VideoStage
      file={r.file}
      markers={r.comments.pins}
      activeMarkerId={r.activeMarkerId}
      selection={r.selection}
      onPlayback={r.onPlayback}
      onMeta={r.setMedia}
      onMarkerClick={(c) => r.setActiveMarkerId(c.id)}
      onSelectionChange={r.setSelection}
      registerSeek={r.registerSeek}
    />
  );
}

// CommentsPane: the comments rail, reading everything off context.
export function CommentsPane() {
  const r = useReview();
  return (
    <CommentsSidebar
      file={r.file}
      media={r.media}
      comments={r.comments}
      currentTime={r.currentTime}
      selection={r.selection}
      onClearSelection={r.onClearSelection}
      onSeek={r.onSeek}
      activeMarkerId={r.activeMarkerId}
      setActiveMarkerId={r.setActiveMarkerId}
    />
  );
}
