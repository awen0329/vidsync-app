import { useEffect, useReducer } from "react";
import { useQuery } from "@tanstack/react-query";
import { useOptionalCloudClient } from "./provider";
import { getSeen, subscribeSeen } from "../../lib/commentSeen";

// useUnread fetches the project's per-clip comment summary (one request) and
// combines it with the local "seen" tracker to tell the file browser which
// clips — and which folders — have unread comments. Re-renders when the
// summary refetches or when something is marked seen.
//
// The CommentNotifier invalidates ["comment-summary", folderID] on new
// events, so badges update live.
export function useUnread(folderID: string) {
  const client = useOptionalCloudClient();
  const summary = useQuery({
    queryKey: ["comment-summary", folderID],
    queryFn: () => client!.commentSummary(folderID),
    enabled: !!client && !!folderID,
    staleTime: 10_000,
    refetchOnWindowFocus: true,
  });
  const videos = summary.data ?? [];

  // Re-render when the seen-map changes.
  const [, bump] = useReducer((x: number) => x + 1, 0);
  useEffect(() => subscribeSeen(bump), []);

  const isVideoUnread = (videoPath: string): boolean => {
    const v = videos.find((s) => s.videoPath === videoPath);
    if (!v || v.count === 0) return false;
    const seen = getSeen(folderID, videoPath);
    return !seen || v.lastAt > seen;
  };

  const commentCount = (videoPath: string): number =>
    videos.find((s) => s.videoPath === videoPath)?.count ?? 0;

  // A folder is unread if any clip beneath it is unread. "" = project root.
  const isFolderUnread = (folderPath: string): boolean => {
    const prefix = folderPath ? `${folderPath}/` : "";
    return videos.some(
      (v) => v.videoPath.startsWith(prefix) && isVideoUnread(v.videoPath),
    );
  };

  return { isVideoUnread, isFolderUnread, commentCount };
}
