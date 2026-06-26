import { cn } from "../../lib/utils";
import { ReviewProvider, PlayerStage, CommentsPane } from "./ReviewContext";
import type { VideoPreviewFile } from "../VideoPreviewModal";

// VideoReviewPanel: the bundled player + comments used by the overlay modal
// (Transfers list). The project workspace instead places PlayerStage and
// CommentsPane in separate, independently-toggled docks — see ProjectDetail.

const DOCK = "rounded-xl border border-line bg-panel";

export function VideoReviewPanel({
  file,
  showComments = true,
}: {
  file: VideoPreviewFile;
  showComments?: boolean;
}) {
  return (
    <ReviewProvider file={file}>
      <div className={cn(DOCK, "flex min-w-0 flex-1 flex-col overflow-hidden")}>
        <PlayerStage />
      </div>
      {showComments && (
        <aside className={cn(DOCK, "flex w-[340px] shrink-0 flex-col overflow-hidden")}>
          <CommentsPane />
        </aside>
      )}
    </ReviewProvider>
  );
}
