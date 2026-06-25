// Build a URL for fetching a file's bytes from the daemon. Two
// destinations exist:
//
//   1. The Wails-bound media server (App.GetMediaURL) — a streaming
//      reverse proxy on http://127.0.0.1:NNNN that bypasses Wails'
//      AssetServer. We prefer this for large files: WebView2 fetches
//      a Range-aware response and never has the whole body buffered
//      in memory. The Wails AssetServer's responsewriter accumulates
//      the entire body in a bytes.Buffer before handing it to
//      WebView2 via PutByteContent, which OOMs the renderer (and the
//      whole vidsync.exe) on multi-gigabyte videos.
//
//   2. The same-origin /rest/folder/file path through Wails — used
//      in dev (Vite proxy) and as a fallback if the media server
//      hasn't started yet (the binding returns "" before OnStartup
//      finishes daemon setup).
//
// We URL-encode each path segment separately rather than the whole
// path so the `/` separators survive — encodeURIComponent would
// escape them.

// Read once and cache. The media URL is fixed for the process
// lifetime, so we don't keep paying for the JS↔Go bridge call.
let cachedMediaBase: string | null = null;

interface WailsBindings {
  GetMediaURL?: () => Promise<string>;
}
function bindings(): WailsBindings | null {
  const w = window as unknown as {
    go?: { main?: { App?: WailsBindings } };
  };
  return w.go?.main?.App ?? null;
}

// True when running inside the Wails desktop host (the App binding is
// present). In that mode the same-origin /rest/folder/file path is
// served by the Wails AssetServer, which BUFFERS the whole body before
// handing it to WebView2 — fatal for large videos. So in desktop mode
// we must route video bytes exclusively through the streaming media
// server. In dev/browser there's no binding and the relative path goes
// through the Vite proxy → daemon (Range-capable, streamed), which is
// safe.
function isDesktopHost(): boolean {
  return !!bindings()?.GetMediaURL;
}

// Memoized fetch of the streaming media-server base. Resolves to the
// "http://127.0.0.1:NNNN" base in desktop mode, or null when the bridge
// call failed. Callers that need a guaranteed-streaming URL await this.
//
// Critical: we must NOT memoize a null caused by the Wails binding not
// being injected yet at module-load time — otherwise the very first
// (early) call permanently caches "no media server" and every
// subsequent thumbnail/preview decode is starved of a URL. So we only
// memoize the in-flight promise once the binding actually exists, and
// clear it on failure so a later call can retry.
let mediaBasePromise: Promise<string | null> | null = null;
function loadMediaBase(): Promise<string | null> {
  if (cachedMediaBase) return Promise.resolve(cachedMediaBase);
  if (mediaBasePromise) return mediaBasePromise;
  const b = bindings();
  if (!b?.GetMediaURL) {
    // Binding not ready yet (or dev/browser). Don't memoize — let a
    // later call try again once Wails has injected the bridge.
    return Promise.resolve(null);
  }
  mediaBasePromise = b
    .GetMediaURL()
    .then((url) => {
      cachedMediaBase = url || null;
      return cachedMediaBase;
    })
    .catch(() => {
      mediaBasePromise = null; // allow retry
      return null;
    });
  return mediaBasePromise;
}

// Kick off the media URL fetch as soon as this module loads in
// desktop mode, so it's ready by the time the user browses files.
void loadMediaBase();

function encodePath(posixPath: string): string {
  return posixPath
    .split("/")
    .map((seg) => encodeURIComponent(seg))
    .join("/");
}

function fileQuery(folderID: string, posixPath: string): string {
  return `folder=${encodeURIComponent(folderID)}&path=${encodePath(posixPath)}`;
}

// thumbURL points an <img> at the daemon's ffmpeg-backed thumbnail
// endpoint. It's same-origin (/rest/* is proxied to the daemon, with the
// API key injected), so no streaming media server or CORS is involved —
// the response is a small cached JPEG. The `v` param (size + modified)
// busts the browser cache when the file's content changes.
export function thumbURL(
  folderID: string,
  posixPath: string,
  size: number,
  modified: string,
): string {
  const v = encodeURIComponent(`${size}-${modified}`);
  return `/rest/folder/thumb?${fileQuery(folderID, posixPath)}&v=${v}`;
}

// previewURL points a <video> at the daemon's transcoded preview endpoint —
// a short H.264 clip for formats WebView2 can't decode natively (MXF, MKV,
// BRAW, …). Same-origin (/rest/* is proxied with the API key injected); the
// clip is small enough that the buffering AssetServer path is fine, unlike a
// multi-GB master. The `v` param (size + modified) busts the browser cache
// when the file's content changes.
export function previewURL(
  folderID: string,
  posixPath: string,
  size: number,
  modified: string,
): string {
  const v = encodeURIComponent(`${size}-${modified}`);
  return `/rest/folder/preview?${fileQuery(folderID, posixPath)}&v=${v}`;
}

// streamingPreviewURL points the player at the daemon's transcoded H.264/AAC
// proxy, routed through the streaming media server so a full-length proxy
// (hundreds of MB) never passes through the buffering AssetServer. Range-aware,
// so the player can seek. Returns null in desktop mode when the media server
// isn't up yet — the caller keeps showing the loading state and retries.
export async function streamingPreviewURL(
  folderID: string,
  posixPath: string,
  size: number,
  modified: string,
): Promise<string | null> {
  const v = encodeURIComponent(`${size}-${modified}`);
  const q = `${fileQuery(folderID, posixPath)}&v=${v}`;
  if (!isDesktopHost()) {
    return `/rest/folder/preview?${q}`;
  }
  const base = await loadMediaBase();
  if (!base) return null;
  return `${base}/preview?${q}`;
}

export function buildFileURL(folderID: string, posixPath: string): string {
  const q = fileQuery(folderID, posixPath);
  if (cachedMediaBase) {
    return `${cachedMediaBase}/file?${q}`;
  }
  return `/rest/folder/file?${q}`;
}

// streamingVideoURL returns a URL whose bytes are GUARANTEED to stream
// with Range support and never pass through the buffering Wails
// AssetServer. Use this for anything that feeds an HTMLVideoElement
// (thumbnail capture, the background indexer, the preview player):
// decoding even metadata off a multi-GB file via the buffering path
// OOM-crashes WebView2 and takes the whole desktop app down.
//
//   - Desktop host: awaits the streaming media server; returns its
//     URL, or null if it isn't available (caller must skip the decode
//     rather than fall back to buffering).
//   - Dev / browser: returns the relative /rest path, which the Vite
//     proxy streams from the daemon (Range-capable) — safe.
export async function streamingVideoURL(
  folderID: string,
  posixPath: string,
): Promise<string | null> {
  const q = fileQuery(folderID, posixPath);
  if (!isDesktopHost()) {
    return `/rest/folder/file?${q}`;
  }
  const base = await loadMediaBase();
  if (!base) return null;
  return `${base}/file?${q}`;
}
