import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useOptionalCloudClient } from "../api/cloud/provider";
import { useCloudMe } from "../api/cloud/hooks";
import {
  fireSystemNotification,
  getNotificationsEnabled,
} from "../api/useDesktopNotifications";
import { isActiveVideo } from "../lib/activeVideo";
import { pushToast } from "../lib/toast";
import { cacheRemove, cacheUpsert, type Comment } from "./player/comments";

// CommentNotifier holds ONE multiplexed SSE connection (/v1/me/comments/stream)
// covering every project the user belongs to, so a new comment or reply on any
// clip surfaces a notification — even when that file isn't open. It also feeds
// the React Query cache so open players reflect cross-project changes.
//
// One connection (not one per project) keeps us under the browser's per-host
// limit on the HTTP/1.1 backend. Renders null; reconnects with backoff.

const BACKOFF_BASE_MS = 1000;
const BACKOFF_MAX_MS = 30_000;
const BODY_MAX = 120;

function basename(p: string): string {
  const i = p.lastIndexOf("/");
  return i >= 0 ? p.slice(i + 1) : p;
}

export function CommentNotifier() {
  const client = useOptionalCloudClient();
  const me = useCloudMe();
  const qc = useQueryClient();
  const myEmail = me.data?.email ?? "";

  useEffect(() => {
    if (!client) return;
    const ctl = new AbortController();
    let stopped = false;
    let backoff = BACKOFF_BASE_MS;

    const apply = (ev: {
      type: string;
      folderId?: string;
      comment?: Comment;
      id?: string;
    }) => {
      const folderID = ev.folderId;
      if (folderID) {
        // Refresh the unread badges for this project on any change.
        qc.invalidateQueries({ queryKey: ["comment-summary", folderID] });
      }
      if (ev.type === "upsert" && ev.comment && folderID) {
        const c = ev.comment;
        // Keep any open player live, for every project.
        qc.setQueryData<Comment[]>(["comments", folderID, c.videoPath], (prev) =>
          cacheUpsert(prev ?? [], c),
        );
        // Notify for others' comments — but not for the clip the user is
        // already watching (it shows live in the panel).
        const fromOther = !!c.author?.email && c.author.email !== myEmail;
        if (fromOther && !isActiveVideo(folderID, c.videoPath)) {
          const who = c.author.name || c.author.email;
          const file = basename(c.videoPath);
          const title =
            c.parentId != null ? `New reply on ${file}` : `New comment on ${file}`;
          const body =
            c.body.length > BODY_MAX ? `${c.body.slice(0, BODY_MAX)}…` : c.body;
          pushToast({ title, body: `${who}: ${body}` });
          if (getNotificationsEnabled()) {
            fireSystemNotification(title, `${who}: ${body}`, `comment:${c.id}`);
          }
        }
      } else if (ev.type === "delete" && ev.id && folderID) {
        qc.setQueriesData<Comment[]>({ queryKey: ["comments", folderID] }, (prev) =>
          prev ? cacheRemove(prev, ev.id!) : prev,
        );
      }
    };

    const loop = async () => {
      while (!stopped) {
        try {
          await client.streamMyComments(apply, ctl.signal);
          backoff = BACKOFF_BASE_MS; // clean end — reconnect promptly
        } catch {
          if (stopped || ctl.signal.aborted) return;
        }
        if (stopped) return;
        await new Promise((r) => setTimeout(r, backoff));
        backoff = Math.min(BACKOFF_MAX_MS, backoff * 2);
      }
    };
    void loop();

    return () => {
      stopped = true;
      ctl.abort();
    };
  }, [client, qc, myEmail]);

  return null;
}
