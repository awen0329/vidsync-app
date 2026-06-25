import { lazy, Suspense } from "react";
import type { VideoPreviewFile } from "./VideoPreviewModal";

// Code-split the inline review player, mirroring LazyVideoPreviewModal.
// The chunk (video handling, comments, scrubber) only loads when a user
// actually opens a video in the file browser.
const Inner = lazy(() =>
  import("./player/VideoReviewPanel").then((m) => ({
    default: m.VideoReviewPanel,
  })),
);

export function LazyVideoReviewPanel({
  file,
  onClose,
  filesPanelVisible,
  onToggleFilesPanel,
}: {
  file: VideoPreviewFile | null;
  onClose: () => void;
  filesPanelVisible?: boolean;
  onToggleFilesPanel?: () => void;
}) {
  if (!file) return null;
  return (
    <Suspense fallback={null}>
      <Inner
        file={file}
        onClose={onClose}
        filesPanelVisible={filesPanelVisible}
        onToggleFilesPanel={onToggleFilesPanel}
      />
    </Suspense>
  );
}
