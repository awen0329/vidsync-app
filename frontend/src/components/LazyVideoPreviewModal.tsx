import { lazy, Suspense } from "react";
import type { VideoPreviewFile } from "./VideoPreviewModal";

// Code-split the video player. It pulls in <video> handling, keyboard
// shortcuts, and seek/buffer logic — none of which the app needs at
// first paint. We only hydrate the chunk when a user actually clicks
// a previewable file. The fallback is `null` because the parent
// already renders a backdrop click target; a spinner would just flash.
const Inner = lazy(() =>
  import("./VideoPreviewModal").then((m) => ({ default: m.VideoPreviewModal })),
);

export function LazyVideoPreviewModal({
  file,
  onClose,
}: {
  file: VideoPreviewFile | null;
  onClose: () => void;
}) {
  // Don't even kick off the chunk fetch until something is actually
  // being previewed — `file === null` is the resting state for both
  // FileGrid and Transfers.
  if (!file) return null;
  return (
    <Suspense fallback={null}>
      <Inner file={file} onClose={onClose} />
    </Suspense>
  );
}
