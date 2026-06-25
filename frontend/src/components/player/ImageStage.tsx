import { useEffect, useState } from "react";
import { streamingVideoURL, thumbURL } from "../../lib/fileURL";
import { BROWSER_VIEWABLE_IMAGE_EXT, extOfName } from "../../lib/videoFormats";
import type { VideoPreviewFile } from "../VideoPreviewModal";
import type { MediaInfo } from "./VideoStage";

// ImageStage shows a still image in the review surface — the audio/video
// player's <video> + scrubber don't apply, so this is a much simpler element:
// just the picture, centered and aspect-fit on black. Comments still work via
// the sidebar (they pin to t=0 since there's no timeline).
//
// Chromium renders png/jpg/gif/webp from the raw bytes (its own decoders, no
// OS codecs needed). For formats it can't decode (TIFF, HEIC) — and as a
// fallback on any decode error — we show the daemon's ffmpeg-rendered JPEG
// thumbnail instead, so the user always sees *something*.
export function ImageStage({
  file,
  onMeta,
}: {
  file: VideoPreviewFile;
  onMeta?: (info: MediaInfo) => void;
}) {
  const native = BROWSER_VIEWABLE_IMAGE_EXT.includes(extOfName(file.name));
  const thumb = thumbURL(file.folderID, file.path, file.size, file.modified ?? "");

  const [src, setSrc] = useState<string | null>(null);
  // True once we've fallen back to the JPEG thumbnail, so onError doesn't loop
  // and onLoad doesn't report the (downscaled) thumbnail's dimensions as the
  // real resolution.
  const [usingThumb, setUsingThumb] = useState(!native);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    setErr(null);
    if (!native) {
      // Browser can't decode it — go straight to the daemon's JPEG.
      setUsingThumb(true);
      setSrc(thumb);
      return;
    }
    let cancelled = false;
    setUsingThumb(false);
    setSrc(null);
    streamingVideoURL(file.folderID, file.path)
      .then((u) => {
        if (cancelled) return;
        // No streaming URL yet (media server still starting): fall back to the
        // already-cached thumbnail rather than showing nothing.
        if (u) setSrc(u);
        else {
          setUsingThumb(true);
          setSrc(thumb);
        }
      })
      .catch(() => {
        if (cancelled) return;
        setUsingThumb(true);
        setSrc(thumb);
      });
    return () => {
      cancelled = true;
    };
    // thumb is derived from the same identity fields, so file alone is enough.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [file]);

  return (
    <div className="flex min-h-0 min-w-0 flex-1 items-center justify-center bg-black p-4">
      {src && (
        <img
          src={src}
          alt={file.name}
          onLoad={(e) => {
            // Only the full-res image gives a true resolution; the thumbnail is
            // downscaled, so skip onMeta for it (Inspector shows "—").
            if (usingThumb) return;
            const img = e.currentTarget;
            onMeta?.({
              duration: 0,
              width: img.naturalWidth,
              height: img.naturalHeight,
            });
          }}
          onError={() => {
            // Raw bytes failed to decode — try the daemon's JPEG once.
            if (!usingThumb) {
              setUsingThumb(true);
              setSrc(thumb);
              return;
            }
            setErr("Couldn't display this image — it may still be syncing.");
          }}
          className="max-h-full max-w-full object-contain"
        />
      )}
      {!src && !err && <p className="text-sm text-fg-soft">Loading…</p>}
      {err && <p className="px-4 py-3 text-center text-sm text-rose-400">{err}</p>}
    </div>
  );
}
