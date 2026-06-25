import { useEffect, useRef, useState } from "react";
import { streamingVideoURL } from "./fileURL";
import {
  captureVideoThumb,
  getCachedThumb,
  isThumbUnsupported,
  markThumbUnsupported,
  putCachedMeta,
  putCachedThumb,
  type ThumbKey,
} from "./thumbnails";

// useVideoThumb: returns a blob: URL for a thumbnail of the given
// video file, generating it on first call and caching the result in
// IndexedDB. Returns null while generating or if the file couldn't
// be decoded.
//
// Large-file safety: capture ALWAYS goes through a guaranteed-streaming
// URL (Range-aware media server), never the buffering Wails AssetServer
// path that OOM-crashes WebView2. Combined with preload="metadata" the
// decoder only fetches the clip's index + the GOP around the seek
// point, so a multi-GB master thumbnails as cheaply as a small clip —
// it's the same path full playback already uses. There's therefore no
// file-size cap; an ultra-high-resolution backstop lives in
// captureVideoThumb instead (per-frame decode, not file size, is the
// real memory risk).
//
// Concurrency: generation is gated by a small global semaphore so a
// folder with 200 videos doesn't open 200 <video> elements at once.
//
// We only generate when `enabled` is true (typically: file is fully
// synced and is actually a video by extension). The caller is
// responsible for that check.

const MAX_CONCURRENT = 2;
// Skip starting a fresh decode for this long after the hook mounts.
// If the user navigates back out of the page (or scrolls past this
// tile) within the window, we never create a <video> element at all.
const FRESH_CAPTURE_SETTLE_MS = 300;
let inFlight = 0;
const waiters: Array<() => void> = [];

function acquire(): Promise<void> {
  if (inFlight < MAX_CONCURRENT) {
    inFlight++;
    return Promise.resolve();
  }
  return new Promise((resolve) => waiters.push(resolve));
}

function release(): void {
  const next = waiters.shift();
  if (next) {
    next();
  } else {
    inFlight = Math.max(0, inFlight - 1);
  }
}

export function useVideoThumb(
  key: ThumbKey | null,
  enabled: boolean,
): string | null {
  const [url, setUrl] = useState<string | null>(null);
  // Track the blob we own so we revoke it on unmount/replace.
  const ownedRef = useRef<string | null>(null);

  useEffect(() => {
    if (!enabled || !key) return;

    let cancelled = false;
    // AbortController is the signal that actually unwinds in-flight
    // <video> decodes. Without it, rapid mount/unmount cycles (e.g.
    // the user toggling Files↔Team) accumulate decoder state and
    // crash the WebView2 renderer.
    const ctl = new AbortController();

    async function run() {
      const blob = await getCachedThumb(key!);
      if (cancelled) return;
      if (blob) {
        const u = URL.createObjectURL(blob);
        ownedRef.current = u;
        setUrl(u);
        return;
      }
      // Don't re-attempt a file we've already failed/skipped this
      // session — repeated decode attempts on a problem file are a
      // crash multiplier.
      if (isThumbUnsupported(key!)) return;

      await new Promise((r) => setTimeout(r, FRESH_CAPTURE_SETTLE_MS));
      if (cancelled) return;

      // Resolve a guaranteed-streaming source. If the media server
      // isn't available (desktop startup race), skip rather than fall
      // back to the buffering AssetServer path — that's the large-file
      // OOM crash. We'll get another shot on the next mount.
      const streamURL = await streamingVideoURL(key!.folderID, key!.path);
      if (cancelled || !streamURL) return;

      const ext = key!.path.split(".").pop()?.toLowerCase() ?? "";
      // A freshly-synced file (common on the recipient side of an
      // invitation) can briefly fail to decode before its bytes are
      // fully on disk, then succeed. Retry transient failures a few
      // times with backoff; only a "skip" (resolution backstop) is
      // permanent. We acquire the decode slot per attempt and release
      // it during the backoff so other tiles aren't starved.
      for (let attempt = 0; attempt < 3 && !cancelled; attempt++) {
        if (attempt > 0) {
          await new Promise((r) => setTimeout(r, 1500 * attempt));
          if (cancelled) return;
        }
        await acquire();
        let outcome;
        try {
          if (cancelled) return;
          outcome = await captureVideoThumb(streamURL, { ext, signal: ctl.signal });
        } catch {
          outcome = { status: "fail" as const };
        } finally {
          release();
        }
        if (cancelled) return;
        if (outcome.status === "ok") {
          await Promise.all([
            putCachedThumb(key!, outcome.blob),
            putCachedMeta(key!, outcome.meta),
          ]);
          if (cancelled) return;
          const u = URL.createObjectURL(outcome.blob);
          ownedRef.current = u;
          setUrl(u);
          return;
        }
        if (outcome.status === "skip") {
          // Permanent (over the resolution backstop) — don't retry.
          markThumbUnsupported(key!);
          return;
        }
        // status === "fail": transient — loop and retry.
      }
    }

    void run();
    return () => {
      cancelled = true;
      ctl.abort();
      if (ownedRef.current) {
        URL.revokeObjectURL(ownedRef.current);
        ownedRef.current = null;
      }
    };
    // We intentionally key the effect on the *string* key, not the
    // ThumbKey object identity, so callers can pass a fresh object
    // each render without re-running.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    enabled,
    key ? `${key.folderID}:${key.path}:${key.size}:${key.modified}` : null,
  ]);

  return url;
}
