import { useEffect } from "react";
import { useFolderBrowse } from "../api/hooks";
import { streamingVideoURL } from "./fileURL";
import {
  captureVideoMetaOnly,
  captureVideoThumb,
  getCachedMeta,
  getCachedThumb,
  isThumbUnsupported,
  markThumbUnsupported,
  putCachedMeta,
  putCachedThumb,
} from "./thumbnails";

// useThumbnailIndexer: when a project is opened, walk its file tree in
// the background and capture thumbnails for any videos that don't yet
// have one. This is what populates the folder collages so they show
// real previews on first visit rather than only after the user has
// scrolled past each file in the Files tab.
//
// Design choices:
//   - Cap concurrency to one capture at a time. The browser can
//     genuinely struggle if we spin up multiple <video> elements
//     concurrently, especially with large 4K masters.
//   - Cap per-project budget to MAX_PER_RUN files so a project with
//     thousands of videos doesn't pin the CPU/network forever on
//     every navigation. The cache is sticky, so subsequent visits
//     pick up where we left off (already-cached files are skipped
//     with a single IndexedDB read).
//   - Hard-stop on tab unfocus to be a good citizen.

const MAX_PER_RUN = 200;
// Wait this long before kicking off the first capture, to give the
// user time to navigate back out without us starting a decode at all.
// Rapid Projects→ProjectDetail→Back cycling used to spin up <video>
// elements that piled up faster than WebView2 could release them,
// eventually crashing the browser process.
const SETTLE_MS = 1500;
// Extensions we ask the browser to decode. Kept in sync with
// FileGrid.isVideoExt — the cache is shared.
const VIDEO_EXT = [
  "mp4",
  "mov",
  "mkv",
  "webm",
  "m4v",
  "avi",
  "mpg",
  "mpeg",
];

interface BrowseEntry {
  name: string;
  modTime: string;
  size: number;
  type: "FILE_INFO_TYPE_FILE" | "FILE_INFO_TYPE_DIRECTORY";
  children?: BrowseEntry[];
}

interface VideoFile {
  path: string;
  size: number;
  modified: string;
}

function collectVideos(
  node: BrowseEntry[] | undefined,
  prefix: string,
  out: VideoFile[],
  budget: { left: number },
) {
  if (!node || budget.left <= 0) return;
  for (const item of node) {
    if (budget.left <= 0) return;
    const path = prefix ? `${prefix}/${item.name}` : item.name;
    if (item.type === "FILE_INFO_TYPE_DIRECTORY") {
      collectVideos(item.children, path, out, budget);
    } else {
      const ext = item.name.split(".").pop()?.toLowerCase() ?? "";
      if (VIDEO_EXT.includes(ext)) {
        out.push({ path, size: item.size, modified: item.modTime });
        budget.left--;
      }
    }
  }
}

export function useThumbnailIndexer(folderID: string) {
  const browse = useFolderBrowse(folderID);

  useEffect(() => {
    if (!Array.isArray(browse.data)) return;

    let cancelled = false;
    // AbortController so the active <video> decode unwinds the moment
    // the user leaves ProjectDetail. Without this, a 4K master that
    // takes seconds to load keeps the WebView2 decoder pinned long
    // after navigation, which contributes to renderer crashes on
    // rapid back-and-forth.
    const ctl = new AbortController();
    const budget = { left: MAX_PER_RUN };
    const videos: VideoFile[] = [];
    collectVideos(browse.data as BrowseEntry[], "", videos, budget);
    if (videos.length === 0) return;

    // Process serially. We add a small idle gap between captures so
    // the rest of the UI stays snappy.
    void (async () => {
      await new Promise((r) => setTimeout(r, SETTLE_MS));
      if (cancelled || document.hidden) return;
      for (const v of videos) {
        if (cancelled || document.hidden) return;
        const key = {
          folderID,
          path: v.path,
          size: v.size,
          modified: v.modified,
        };
        // Already failed/skipped this session — don't re-attempt.
        if (isThumbUnsupported(key)) continue;
        const existing = await getCachedThumb(key);
        if (cancelled) return;
        const ext = v.path.split(".").pop()?.toLowerCase() ?? "";
        // Guaranteed-streaming source only — never the buffering
        // AssetServer path, which OOM-crashes WebView2 on large files.
        // Skip (don't fall back) if the media server isn't ready yet.
        const streamURL = await streamingVideoURL(folderID, v.path);
        if (cancelled) return;
        if (!streamURL) continue;
        try {
          if (existing) {
            // Thumb exists from a previous version — backfill meta
            // if missing, but skip the expensive thumb re-capture.
            const haveMeta = await getCachedMeta(key);
            if (!haveMeta && !cancelled) {
              const meta = await captureVideoMetaOnly(streamURL, ext, ctl.signal);
              if (cancelled) return;
              if (meta) await putCachedMeta(key, meta);
            }
          } else {
            const captured = await captureVideoThumb(streamURL, {
              ext,
              signal: ctl.signal,
            });
            if (cancelled) return;
            if (captured.status === "ok") {
              await Promise.all([
                putCachedThumb(key, captured.blob),
                putCachedMeta(key, captured.meta),
              ]);
            } else if (captured.status === "skip") {
              // Permanent (over the resolution backstop) — tombstone so
              // we don't re-attempt the crash-prone high-res decode.
              markThumbUnsupported(key);
            }
            // status === "fail" is transient (e.g. a just-synced file
            // not fully on disk yet); leave it for a later indexer pass
            // or the tile's own retry rather than tombstoning.
          }
        } catch {
          // Unexpected throw — skip this file for now, no tombstone.
        }
        // Tiny breather so React can flush layouts between captures.
        await new Promise((r) => setTimeout(r, 50));
      }
    })();

    return () => {
      cancelled = true;
      ctl.abort();
    };
    // Re-run when the tree shape genuinely changes (new file synced,
    // file deleted). Identity of browse.data is stable per query, so
    // this is cheap.
  }, [browse.data, folderID]);
}
