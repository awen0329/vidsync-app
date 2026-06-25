import { useEffect, useMemo, useState } from "react";
import { getCachedThumbsForFolder } from "./thumbnails";
import { useFolderBrowse } from "../api/hooks";
import { thumbURL } from "./fileURL";
import { isImageExt, isVideoExt } from "./videoFormats";

// useFolderThumbs: returns up to `limit` blob: URLs for thumbnails
// already cached for the given folder. Polls while the result is
// incomplete (less than `limit` thumbs available) so the collage fills
// in as the background indexer captures new ones; once we have a full
// result the poll stops — thumbs only change when a file is added or
// modified, which is rare on a settled project. Cancels and revokes
// URLs cleanly on unmount / folder change.

// Wait this long after mount before the first scan. A card that
// scrolls out of view in under a beat (or a Projects→ProjectDetail
// navigation) never runs the cursor scan at all, keeping IndexedDB
// pressure proportional to what the user actually looks at.
const MOUNT_DELAY_MS = 150;
const POLL_MS = 8000;

// subPath restricts the lookup to thumbnails whose source file lives
// inside that POSIX-style subdirectory of the folder. Pass undefined
// or empty for the project root.
export function useFolderThumbs(
  folderID: string,
  limit: number,
  subPath?: string,
): string[] {
  const [urls, setUrls] = useState<string[]>([]);

  useEffect(() => {
    let cancelled = false;
    let owned: string[] = [];
    let timer: ReturnType<typeof setTimeout> | null = null;

    const swap = (next: string[]) => {
      // Revoke the previous batch *after* updating state so the
      // rendered <img> doesn't briefly point at a freed URL.
      const prev = owned;
      owned = next;
      setUrls(next);
      for (const u of prev) URL.revokeObjectURL(u);
    };

    const refresh = async () => {
      if (cancelled) return;
      const blobs = await getCachedThumbsForFolder(
        folderID,
        limit,
        subPath || undefined,
      );
      if (cancelled) return;
      const next = blobs.map((b) => URL.createObjectURL(b));
      swap(next);
      // Schedule another scan only while the collage is incomplete.
      // A full result rarely changes; the indexer will replace the
      // component when a file changes by invalidating browse data.
      if (next.length < limit) {
        timer = setTimeout(() => void refresh(), POLL_MS);
      }
    };

    timer = setTimeout(() => void refresh(), MOUNT_DELAY_MS);
    return () => {
      cancelled = true;
      if (timer !== null) clearTimeout(timer);
      for (const u of owned) URL.revokeObjectURL(u);
    };
  }, [folderID, limit, subPath]);

  return urls;
}

// --- Folder collage from the daemon, reflecting current contents ---------

interface BrowseEntry {
  name: string;
  modTime: string;
  size: number;
  type: "FILE_INFO_TYPE_FILE" | "FILE_INFO_TYPE_DIRECTORY";
  children?: BrowseEntry[];
}

// Walk to the children of `subPath` (POSIX, no trailing slash). Empty/undefined
// returns the project root.
function childrenAt(tree: BrowseEntry[], subPath: string): BrowseEntry[] {
  if (!subPath) return tree;
  let cur = tree;
  for (const seg of subPath.split("/")) {
    const next = cur.find(
      (n) => n.name === seg && n.type === "FILE_INFO_TYPE_DIRECTORY",
    );
    if (!next?.children) return [];
    cur = next.children;
  }
  return cur;
}

// Depth-first collect the first `limit` video/image files (audio is excluded
// so audio-only folders fall back to a plain folder icon).
function collectThumbFiles(
  nodes: BrowseEntry[],
  prefix: string,
  limit: number,
  out: { path: string; size: number; modified: string }[],
) {
  for (const n of nodes) {
    if (out.length >= limit) return;
    const path = prefix ? `${prefix}/${n.name}` : n.name;
    if (n.type === "FILE_INFO_TYPE_DIRECTORY") {
      collectThumbFiles(n.children ?? [], path, limit, out);
    } else if (isVideoExt(n.name) || isImageExt(n.name)) {
      out.push({ path, size: n.size, modified: n.modTime });
    }
  }
}

// useFolderCollageThumbs returns daemon thumbnail URLs for the first `limit`
// video/image files inside a folder, derived from the live browse tree. Unlike
// useFolderThumbs (which reads a client-side, video-only IndexedDB cache that
// can go stale), this always reflects the folder's CURRENT contents and covers
// images too — so image folders show their pictures and audio-only folders
// show a plain icon. URLs that 404/204 are dropped by the <img> onError in the
// collage.
export function useFolderCollageThumbs(
  folderID: string,
  limit: number,
  subPath?: string,
): string[] {
  const browse = useFolderBrowse(folderID);
  const data = browse.data;
  return useMemo(() => {
    if (!Array.isArray(data)) return [];
    const start = childrenAt(data as BrowseEntry[], subPath ?? "");
    const files: { path: string; size: number; modified: string }[] = [];
    collectThumbFiles(start, subPath ?? "", limit, files);
    return files.map((f) => thumbURL(folderID, f.path, f.size, f.modified));
  }, [data, folderID, limit, subPath]);
}
