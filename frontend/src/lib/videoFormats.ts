// Video format / playability helpers, shared by the file browser (FileGrid)
// and the file-tree navigator (FileTree) so both agree on which files open
// in the review player and which need a server-transcoded preview clip.

export function extOfName(name: string): string {
  return name.split(".").pop()?.toLowerCase() ?? "";
}

// Broad list: every video container we recognize (drives icons + which
// files get an ffmpeg thumbnail elsewhere).
export const VIDEO_EXT = [
  "mp4", "mov", "mkv", "webm", "avi", "m4v", "mpg", "mpeg", "mpe", "m2v",
  "mxf", "mts", "m2ts", "ts", "wmv", "flv", "3gp", "3g2", "ogv", "vob",
  "divx", "asf", "braw", "r3d",
];

// Narrow: containers/codecs Chromium (WebView2) can play inline.
export const BROWSER_PLAYABLE_EXT = ["mp4", "mov", "m4v", "webm", "ogv"];

// Camera-RAW we can't decode for playback (R3D needs the RED SDK; BRAW works
// via the braw-thumb helper, so it's NOT excluded here).
export const NON_PREVIEWABLE_EXT = ["r3d"];

export function isVideoExt(name: string): boolean {
  return VIDEO_EXT.includes(extOfName(name));
}

// Formats the WebView2 <video> element can play directly from the raw bytes.
export function isBrowserPlayable(name: string): boolean {
  return BROWSER_PLAYABLE_EXT.includes(extOfName(name));
}

// Video the browser can't play directly but the daemon can transcode into a
// short H.264 preview clip (MXF, MKV, AVI, WMV, BRAW, …).
export function needsTranscode(name: string): boolean {
  return (
    isVideoExt(name) &&
    !isBrowserPlayable(name) &&
    !NON_PREVIEWABLE_EXT.includes(extOfName(name))
  );
}

// Any video the user can play in-app — gates click-to-preview: browser-native
// (streamed directly) or transcoded to a preview clip.
export function isPlayable(name: string): boolean {
  return isBrowserPlayable(name) || needsTranscode(name);
}

// --- Audio --------------------------------------------------------------
// Broad list: every audio container we recognize (drives icons + which files
// get an ffmpeg waveform thumbnail and can open in the player).
export const AUDIO_EXT = [
  "wav", "mp3", "aac", "flac", "ogg", "oga", "m4a", "aiff", "aif", "aifc",
  "wma", "opus", "alac", "mka", "ac3", "m4r", "mmf",
];

// Narrow: audio codecs/containers Chromium (WebView2) can decode from the raw
// bytes. Everything else (AIFF, WMA, ALAC, AC3, …) needs the daemon to
// transcode it to AAC — the same preview pipeline videos use. Note .m4a can
// hold AAC (native) or ALAC (not): we try native first and fall back to the
// transcode on a decode error, like exotic-codec mp4s.
export const BROWSER_PLAYABLE_AUDIO_EXT = [
  "mp3", "m4a", "aac", "ogg", "oga", "opus", "wav", "flac", "weba", "m4r",
];

export function isAudioExt(name: string): boolean {
  return AUDIO_EXT.includes(extOfName(name));
}

// Audio the browser can't decode directly but the daemon can transcode into
// an AAC preview the WebView2 media element plays.
export function needsAudioTranscode(name: string): boolean {
  return isAudioExt(name) && !BROWSER_PLAYABLE_AUDIO_EXT.includes(extOfName(name));
}

// --- Images -------------------------------------------------------------
// Broad list: still-image formats we can preview. Raster formats ffmpeg can
// decode get a grid thumbnail (and the viewer shows that JPEG when the browser
// itself can't render the format, e.g. TIFF/TGA/EXR/WBMP/HEIC); SVG (vector)
// ffmpeg can't, so the grid/viewer fall back to the raw bytes in the browser.
// EPS is excluded: it needs a PostScript rasterizer (Ghostscript) neither
// ffmpeg nor the browser has, so it stays on the extension glyph.
export const IMAGE_EXT = [
  "png", "jpg", "jpeg", "gif", "webp", "tif", "tiff", "heic", "heif",
  "bmp", "tga", "svg", "ico", "avif", "exr", "wbmp",
];

// Chromium can render these inline from the raw bytes. For the rest (TIFF,
// HEIC, TGA) it can't, so the viewer falls back to the daemon's JPEG thumbnail.
export const BROWSER_VIEWABLE_IMAGE_EXT = [
  "png", "jpg", "jpeg", "gif", "webp", "bmp", "svg", "ico", "avif",
];

export function isImageExt(name: string): boolean {
  return IMAGE_EXT.includes(extOfName(name));
}

// Images Chromium renders directly from the raw bytes (no ffmpeg decode).
export function isBrowserViewableImage(name: string): boolean {
  return BROWSER_VIEWABLE_IMAGE_EXT.includes(extOfName(name));
}

// --- Shared media helpers ----------------------------------------------
export type MediaKind = "video" | "audio" | "image";

// Which preview surface a file opens in, or null when it isn't previewable.
// (r3d is a video container we can't decode, so it returns "video" but is
// gated out of isPreviewable below via isPlayable.)
export function mediaKind(name: string): MediaKind | null {
  if (isVideoExt(name)) return "video";
  if (isAudioExt(name)) return "audio";
  if (isImageExt(name)) return "image";
  return null;
}

// Any file the app can open in the preview surface: a playable video, any
// audio (native or transcoded), or an image. Gates click-to-open.
export function isPreviewable(name: string): boolean {
  return isPlayable(name) || isAudioExt(name) || isImageExt(name);
}

// Whether opening this file's preview must use the server-transcoded clip
// rather than the raw bytes (non-native video or non-native audio). Images
// are handled separately and never reach this.
export function previewNeedsTranscode(name: string): boolean {
  return needsTranscode(name) || needsAudioTranscode(name);
}
