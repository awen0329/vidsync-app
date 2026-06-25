// Video-thumbnail capture + IndexedDB cache.
//
// Browsers can extract a frame from a video URL via:
//   1. <video src=…> element, mute + load
//   2. Seek to a target time (we use the lesser of 1.5s and 10% in)
//   3. Wait for `seeked` event
//   4. Draw onto an OffscreenCanvas, encode as JPEG blob
//
// We cache the resulting blobs in IndexedDB keyed by
// `folderID + ":" + path + ":" + size + ":" + modTime` so any file
// edit invalidates the cache automatically. Each cached entry is a
// Blob (binary) — that's the compact representation a browser
// natively understands and renders via URL.createObjectURL.
//
// The cache is per-origin (browser context), so each VPS has its
// own. That's fine — thumbnails are cheap to regenerate.

const DB_NAME = "vidsync-thumbs";
const STORE = "thumbs";
const META_STORE = "meta";
// v2 added the `meta` store so we can cache per-clip duration /
// resolution alongside thumbnails. captureVideoThumb already loads the
// video element to grab a frame; reading metadata from the same load
// is essentially free.
const VERSION = 2;

// Soft upper bound on how many cached thumbs we keep. Old entries
// are evicted FIFO when this is exceeded.
const MAX_ENTRIES = 1500;

let dbPromise: Promise<IDBDatabase> | null = null;

function openDB(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const s = db.createObjectStore(STORE, { keyPath: "key" });
        s.createIndex("createdAt", "createdAt");
      }
      if (!db.objectStoreNames.contains(META_STORE)) {
        const s = db.createObjectStore(META_STORE, { keyPath: "key" });
        s.createIndex("createdAt", "createdAt");
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

interface ThumbRow {
  key: string;
  blob: Blob;
  createdAt: number;
}

export interface ThumbKey {
  folderID: string;
  path: string;
  size: number;
  modified: string;
}

// VideoMeta: shallow per-clip metadata we can pull from an
// HTMLVideoElement after it loads. Codec is *not* included — the
// browser doesn't expose it on the element. We infer a format label
// from the file extension at the aggregation layer.
export interface VideoMeta {
  durationSec: number;
  width: number;
  height: number;
  ext: string; // lowercase, no leading dot
}

interface MetaRow extends VideoMeta {
  key: string;
  createdAt: number;
}

function keyOf(k: ThumbKey): string {
  return `${k.folderID}:${k.path}:${k.size}:${k.modified}`;
}

// Session tombstone for files we couldn't (or shouldn't) thumbnail —
// unsupported codec, decode error, or over the resolution backstop.
// Without it, every remount re-attempts the decode; for a file that
// crashes/then-reloads, that's an infinite retry loop hammering the
// WebView2 decoder. In-memory (per session) is enough to stop the
// storm; we intentionally don't persist so a browser/codec upgrade
// gets a fresh shot on next launch.
const unsupported = new Set<string>();
export function isThumbUnsupported(k: ThumbKey): boolean {
  return unsupported.has(keyOf(k));
}
export function markThumbUnsupported(k: ThumbKey): void {
  unsupported.add(keyOf(k));
}

// Resolution backstop. We can safely thumbnail a large *file* (the
// decoder only fetches metadata + the GOP around the seek point over
// Range, then renders one frame), but a single ultra-high-resolution
// frame — 8K and up — can still spike WebView2's decode buffers enough
// to OOM on a weak GPU. Files above this pixel count fall back to the
// extension glyph. 4K (3840×2160 ≈ 8.3 MP) stays well under.
const MAX_THUMB_PIXELS = 4096 * 2304; // ~9.4 MP (just over DCI 4K)

export async function getCachedThumb(k: ThumbKey): Promise<Blob | null> {
  try {
    const db = await openDB();
    return await new Promise<Blob | null>((resolve, reject) => {
      const tx = db.transaction(STORE, "readonly");
      const store = tx.objectStore(STORE);
      const req = store.get(keyOf(k));
      req.onsuccess = () => {
        const row = req.result as ThumbRow | undefined;
        resolve(row ? row.blob : null);
      };
      req.onerror = () => reject(req.error);
    });
  } catch {
    return null;
  }
}

export async function putCachedThumb(k: ThumbKey, blob: Blob): Promise<void> {
  try {
    const db = await openDB();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      const store = tx.objectStore(STORE);
      store.put({ key: keyOf(k), blob, createdAt: Date.now() } satisfies ThumbRow);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    // Best-effort eviction. Runs in background; failure is fine.
    void evictOld(db);
  } catch {
    /* private mode / quota — silent */
  }
}

// getCachedThumbsForFolder: walks the cache and returns up to `limit`
// blobs whose key matches the given folder (and optional sub-path).
// Used by the project-cover collage on Projects index, ProjectDetail
// hero, and the per-subfolder collages in FileGrid. We deliberately
// don't trigger new thumbnail captures here — the cover only shows
// what's already cached, and the cache grows organically as the user
// browses the Files tab.
//
// subPath is a POSIX path (no leading or trailing slash) when set;
// only entries whose source file is inside that subtree are returned.
export async function getCachedThumbsForFolder(
  folderID: string,
  limit: number,
  subPath?: string,
): Promise<Blob[]> {
  try {
    const db = await openDB();
    return await new Promise<Blob[]>((resolve, reject) => {
      const tx = db.transaction(STORE, "readonly");
      const store = tx.objectStore(STORE);
      const req = store.openCursor();
      const out: Blob[] = [];
      // Cache key layout: `folderID:path:size:modtime`. We match the
      // `folderID:` prefix, then (if subPath given) also require the
      // path portion to start with `subPath/`.
      const folderPrefix = folderID + ":";
      const pathPrefix = subPath ? subPath + "/" : "";
      req.onsuccess = () => {
        const cursor = req.result;
        if (!cursor || out.length >= limit) {
          resolve(out);
          return;
        }
        const row = cursor.value as ThumbRow;
        if (typeof row?.key === "string" && row.key.startsWith(folderPrefix)) {
          if (!pathPrefix) {
            out.push(row.blob);
          } else {
            // Slice past `folderID:` to get the remainder
            // (`path:size:modtime`). Match the start of the path
            // portion against `subPath/`.
            const rest = row.key.slice(folderPrefix.length);
            if (rest.startsWith(pathPrefix)) out.push(row.blob);
          }
        }
        cursor.continue();
      };
      req.onerror = () => reject(req.error);
    });
  } catch {
    return [];
  }
}

export async function getCachedMeta(k: ThumbKey): Promise<VideoMeta | null> {
  try {
    const db = await openDB();
    return await new Promise<VideoMeta | null>((resolve, reject) => {
      const tx = db.transaction(META_STORE, "readonly");
      const store = tx.objectStore(META_STORE);
      const req = store.get(keyOf(k));
      req.onsuccess = () => {
        const row = req.result as MetaRow | undefined;
        if (!row) return resolve(null);
        const { durationSec, width, height, ext } = row;
        resolve({ durationSec, width, height, ext });
      };
      req.onerror = () => reject(req.error);
    });
  } catch {
    return null;
  }
}

export async function putCachedMeta(
  k: ThumbKey,
  meta: VideoMeta,
): Promise<void> {
  try {
    const db = await openDB();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(META_STORE, "readwrite");
      const store = tx.objectStore(META_STORE);
      store.put({ key: keyOf(k), createdAt: Date.now(), ...meta } satisfies MetaRow);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch {
    /* silent */
  }
}

// getCachedMetasForFolder: returns every cached VideoMeta whose key
// starts with `folderID:`. Used by useFolderMediaSummary to roll up
// per-project totals (runtime, dominant resolution, clip count). We
// purposely walk the whole store with a cursor — there are at most
// a few thousand entries and this runs at most once every few seconds
// per visible card.
export async function getCachedMetasForFolder(
  folderID: string,
): Promise<VideoMeta[]> {
  try {
    const db = await openDB();
    return await new Promise<VideoMeta[]>((resolve, reject) => {
      const tx = db.transaction(META_STORE, "readonly");
      const store = tx.objectStore(META_STORE);
      const req = store.openCursor();
      const out: VideoMeta[] = [];
      const prefix = folderID + ":";
      req.onsuccess = () => {
        const cur = req.result;
        if (!cur) return resolve(out);
        const row = cur.value as MetaRow;
        if (typeof row?.key === "string" && row.key.startsWith(prefix)) {
          out.push({
            durationSec: row.durationSec,
            width: row.width,
            height: row.height,
            ext: row.ext,
          });
        }
        cur.continue();
      };
      req.onerror = () => reject(req.error);
    });
  } catch {
    return [];
  }
}

async function evictOld(db: IDBDatabase): Promise<void> {
  try {
    const tx = db.transaction(STORE, "readwrite");
    const store = tx.objectStore(STORE);
    const countReq = store.count();
    await new Promise<void>((resolve) => {
      countReq.onsuccess = () => resolve();
      countReq.onerror = () => resolve();
    });
    const total = countReq.result ?? 0;
    if (total <= MAX_ENTRIES) return;
    const toDrop = total - MAX_ENTRIES;
    const idx = store.index("createdAt");
    const cur = idx.openCursor();
    let dropped = 0;
    await new Promise<void>((resolve) => {
      cur.onsuccess = () => {
        const c = cur.result;
        if (!c || dropped >= toDrop) {
          resolve();
          return;
        }
        c.delete();
        dropped++;
        c.continue();
      };
      cur.onerror = () => resolve();
    });
  } catch {
    /* swallow */
  }
}

// Outcome of a capture attempt:
//   - ok:   a thumbnail + metadata.
//   - skip: a PERMANENT reason not to thumbnail this file (resolution
//           backstop). Callers may tombstone it so they never retry.
//   - fail: a TRANSIENT failure (metadata/seek timeout, network, the
//           file isn't readable yet, decode hiccup). Callers must NOT
//           tombstone — on the recipient side a file that just finished
//           syncing can briefly fail and then succeed on retry. This is
//           the bug behind "invited project shows no video frames": an
//           early transient failure was being cached as permanent.
export type CaptureOutcome =
  | { status: "ok"; blob: Blob; meta: VideoMeta }
  | { status: "skip" }
  | { status: "fail" };

export async function captureVideoThumb(
  url: string,
  options: {
    maxWidth?: number;
    jpegQuality?: number;
    seekSeconds?: number;
    ext?: string;
    // signal aborts the load/decode early when the caller unmounts.
    // Critical: without it, rapid mount/unmount cycles (e.g. clicking
    // Files↔Team) leave many <video> elements decoding in parallel
    // for up to 14s each (8s load + 6s seek). That stacks GPU/CPU
    // pressure inside WebView2 fast enough to crash the renderer.
    signal?: AbortSignal;
  } = {},
): Promise<CaptureOutcome> {
  const maxWidth = options.maxWidth ?? 320;
  const quality = options.jpegQuality ?? 0.7;
  const seekTarget = options.seekSeconds ?? 1.5;
  const ext = (options.ext ?? "").toLowerCase().replace(/^\./, "");
  const signal = options.signal;

  const video = document.createElement("video");
  video.crossOrigin = "anonymous";
  video.muted = true;
  video.playsInline = true;
  // `preload="metadata"` is enough to get duration/dimensions and to
  // satisfy the subsequent seek — the browser uses Range requests to
  // fetch around the seek target only. `preload="auto"` was telling
  // WebView2 to buffer the whole source, which for a multi-GB master
  // can drive the renderer (and on Windows the host) out of memory.
  video.preload = "metadata";
  video.src = url;

  // dispose forces the decoder to drop its hold on the source so the
  // GPU/CPU resources are released *now*, not on the next GC. Without
  // .load() the element clings to decoder state even with src="".
  const dispose = () => {
    try {
      video.removeAttribute("src");
      video.load();
    } catch {
      /* ignore */
    }
  };

  try {
    await waitFor(video, "loadedmetadata", 8000, signal);
  } catch {
    dispose();
    return { status: "fail" };
  }

  // Don't seek past the end. Cap at min(seekTarget, 10% of duration).
  let target = seekTarget;
  if (!isNaN(video.duration) && isFinite(video.duration) && video.duration > 0) {
    target = Math.min(seekTarget, Math.max(0, video.duration * 0.1));
  }
  video.currentTime = target;
  try {
    await waitFor(video, "seeked", 6000, signal);
  } catch {
    dispose();
    return { status: "fail" };
  }

  const w = video.videoWidth;
  const h = video.videoHeight;
  if (w === 0 || h === 0) {
    dispose();
    return { status: "fail" };
  }
  // Resolution backstop: rendering a single 8K+ frame can OOM the
  // decoder even when the file streams fine. This is a permanent
  // property of the file, so callers may tombstone it.
  if (w * h > MAX_THUMB_PIXELS) {
    dispose();
    return { status: "skip" };
  }
  const durationSec =
    isFinite(video.duration) && video.duration > 0 ? video.duration : 0;
  const meta: VideoMeta = { durationSec, width: w, height: h, ext };

  const scale = Math.min(1, maxWidth / w);
  const cw = Math.max(1, Math.round(w * scale));
  const ch = Math.max(1, Math.round(h * scale));

  const canvas = document.createElement("canvas");
  canvas.width = cw;
  canvas.height = ch;
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    dispose();
    return { status: "fail" };
  }
  // Wrap draw + encode: a tainted canvas (cross-origin without valid
  // CORS) throws here rather than returning null, so guard both.
  try {
    ctx.drawImage(video, 0, 0, cw, ch);
    dispose();
    if (signal?.aborted) return { status: "fail" };
    const blob = await new Promise<Blob | null>((resolve) => {
      canvas.toBlob((b) => resolve(b), "image/jpeg", quality);
    });
    if (!blob) return { status: "fail" };
    return { status: "ok", blob, meta };
  } catch {
    dispose();
    return { status: "fail" };
  }
}

// Meta-only probe: cheaper than captureVideoThumb because it never
// seeks or draws to a canvas. Used by the indexer to backfill the
// metadata cache for files whose thumbnail was captured before v2.
export async function captureVideoMetaOnly(
  url: string,
  ext = "",
  signal?: AbortSignal,
): Promise<VideoMeta | null> {
  const video = document.createElement("video");
  video.crossOrigin = "anonymous";
  video.muted = true;
  video.playsInline = true;
  video.preload = "metadata";
  video.src = url;
  const dispose = () => {
    try {
      video.removeAttribute("src");
      video.load();
    } catch {
      /* ignore */
    }
  };
  try {
    await waitFor(video, "loadedmetadata", 8000, signal);
  } catch {
    dispose();
    return null;
  }
  const w = video.videoWidth;
  const h = video.videoHeight;
  const durationSec =
    isFinite(video.duration) && video.duration > 0 ? video.duration : 0;
  dispose();
  if (w === 0 || h === 0) return null;
  return {
    durationSec,
    width: w,
    height: h,
    ext: ext.toLowerCase().replace(/^\./, ""),
  };
}

function waitFor(
  el: HTMLElement,
  ev: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("aborted"));
      return;
    }
    let tid: ReturnType<typeof setTimeout> | null = null;
    const cleanup = () => {
      if (tid !== null) clearTimeout(tid);
      el.removeEventListener(ev, onEv);
      el.removeEventListener("error", onErr);
      signal?.removeEventListener("abort", onAbort);
    };
    const onEv = () => {
      cleanup();
      resolve();
    };
    const onErr = () => {
      cleanup();
      reject(new Error("video error"));
    };
    const onAbort = () => {
      cleanup();
      reject(new Error("aborted"));
    };
    tid = setTimeout(() => {
      cleanup();
      reject(new Error("timeout"));
    }, timeoutMs);
    el.addEventListener(ev, onEv, { once: true });
    el.addEventListener("error", onErr, { once: true });
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
