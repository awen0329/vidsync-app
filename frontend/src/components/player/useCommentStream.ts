import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useOptionalCloudClient } from "../../api/cloud/provider";
import { cacheRemove, cacheUpsert, type Comment } from "./comments";

// useCommentStream holds ONE SSE connection for a project's comments while
// the review player is open, and applies pushed changes straight into the
// React Query cache. This replaces polling: no per-interval requests, instant
// delivery, and the server only sends bytes when a comment actually changes.
//
// Keyed by folderID (not videoPath), so switching clips within the same
// project keeps the connection open. Reconnect uses capped exponential
// backoff. We deliberately do NOT refetch the comment lists on (re)connect:
// the initial list is fetched once by useComments, and every change after
// that arrives as an SSE event applied directly to the cache. A periodic
// server-side stream close would otherwise trigger a full comment-list GET
// every cycle — a constant, needless load on the central server.
const BACKOFF_BASE_MS = 1000;
const BACKOFF_MAX_MS = 30_000;
// A stream that stays open at least this long counts as "healthy": its close
// was a routine server-side cycle, so reconnect promptly. One that drops
// faster is treated as unhealthy and backed off, so a broken/instantly-closing
// endpoint can't become a tight reconnect loop hammering the server.
const HEALTHY_MS = 10_000;

export function useCommentStream(folderID: string): void {
  const client = useOptionalCloudClient();
  const qc = useQueryClient();

  useEffect(() => {
    if (!client || !folderID) return;
    const ctl = new AbortController();
    let stopped = false;
    let backoff = BACKOFF_BASE_MS;

    const apply = (ev: { type: string; comment?: Comment; id?: string }) => {
      if (ev.type === "upsert" && ev.comment) {
        const c = ev.comment;
        qc.setQueryData<Comment[]>(["comments", folderID, c.videoPath], (prev) =>
          cacheUpsert(prev ?? [], c),
        );
      } else if (ev.type === "delete" && ev.id) {
        // We don't get the videoPath on delete; drop the id (and its replies)
        // from every cached clip list for this folder.
        qc.setQueriesData<Comment[]>({ queryKey: ["comments", folderID] }, (prev) =>
          prev ? cacheRemove(prev, ev.id!) : prev,
        );
      }
    };

    const loop = async () => {
      while (!stopped) {
        const startedAt = Date.now();
        try {
          // Stream until it ends/errors; live events are applied as they
          // arrive. No invalidate/refetch here — see the note above.
          await client.streamComments(folderID, apply, ctl.signal);
        } catch {
          if (stopped || ctl.signal.aborted) return;
        }
        if (stopped) return;
        // Reset backoff only after a healthy (long-lived) connection so a
        // routine server close reconnects promptly, while an instantly-
        // dropping stream backs off instead of spinning.
        if (Date.now() - startedAt >= HEALTHY_MS) backoff = BACKOFF_BASE_MS;
        await new Promise((r) => setTimeout(r, backoff));
        backoff = Math.min(BACKOFF_MAX_MS, backoff * 2);
      }
    };
    void loop();

    return () => {
      stopped = true;
      ctl.abort();
    };
  }, [client, folderID, qc]);
}
