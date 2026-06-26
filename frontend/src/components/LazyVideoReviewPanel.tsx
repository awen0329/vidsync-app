import { lazy, Suspense } from "react";
import type { VideoPreviewFile } from "./VideoPreviewModal";

// Code-split the review player dock (video handling, comments, scrubber);
// the chunk only loads when a user actually opens a clip.
const Inner = lazy(() =>
  import("./player/VideoReviewPanel").then((m) => ({
    default: m.VideoReviewPanel,
  })),
);

export function LazyVideoReviewPanel({
  file,
  showComments,
}: {
  file: VideoPreviewFile | null;
  showComments?: boolean;
}) {
  if (!file) return null;
  return (
    <Suspense fallback={null}>
      <Inner file={file} showComments={showComments} />
    </Suspense>
  );
}
