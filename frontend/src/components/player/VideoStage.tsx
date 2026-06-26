import { useEffect, useRef, useState } from "react";
import { streamingPreviewURL, streamingVideoURL, thumbURL } from "../../lib/fileURL";
import type { VideoPreviewFile } from "../VideoPreviewModal";
import type { Comment } from "./comments";
import { formatClock, formatTimecodeMs, parseTimecodeMs } from "./format";
import { cn } from "../../lib/utils";

// VideoStage owns the <video> element and a custom control bar. We use
// custom controls (not the native ones) specifically so the scrubber can
// render a clickable marker per comment — native controls don't expose the
// timeline for overlays.
//
// The src-resolution logic (streaming vs transcoded preview) is carried over
// verbatim from the original VideoBody: native formats stream via the
// daemon's Range server (no multi-GB load into WebView memory), non-native
// formats play a short server-transcoded clip.

// While the daemon generates the full proxy it returns 202 Accepted; the
// player polls this often until the proxy is ready (200) or fails (204).
const PREVIEW_POLL_MS = 2000;
// Give up after this many consecutive *unexpected* poll responses (route or
// transport problems) so the player never spins forever.
const MAX_PREVIEW_POLL_ERRORS = 6;

export interface Selection {
  in: number;
  out: number;
}

export interface MediaInfo {
  duration: number;
  width: number;
  height: number;
}

export function VideoStage({
  file,
  markers,
  activeMarkerId,
  selection,
  onPlayback,
  onMeta,
  onMarkerClick,
  onSelectionChange,
  registerSeek,
}: {
  file: VideoPreviewFile;
  markers: Comment[];
  activeMarkerId: string | null;
  // Pending in→out range the user is composing a comment against.
  selection: Selection | null;
  onPlayback: (currentTime: number, duration: number) => void;
  // Fired once the video's metadata loads, with duration + pixel dimensions
  // (for the Inspector panel).
  onMeta?: (info: MediaInfo) => void;
  onMarkerClick: (c: Comment) => void;
  // Set/clear the comment range (null clears). Driven by the "range" button
  // and the draggable in/out handles on the timeline.
  onSelectionChange: (sel: Selection | null) => void;
  // Parent calls the supplied function to seek the video (e.g. from the
  // comments sidebar). VideoStage registers its seek impl on mount.
  registerSeek: (fn: (t: number) => void) => void;
}) {
  // Audio plays through the same media element as video (it has duration,
  // currentTime, play/pause, so the scrubber, markers and comment ranges all
  // work unchanged). The only differences: it shows the daemon's waveform as
  // a poster, and it doesn't autoplay muted — the user presses play to hear it.
  const isAudio = (file.kind ?? "video") === "audio";

  const videoRef = useRef<HTMLVideoElement>(null);
  const [src, setSrc] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [preparing, setPreparing] = useState(false);
  // An .mp4/.mov/.m4v we *assumed* WebView2 could decode but it couldn't
  // (HEVC, ProRes, 10-bit, exotic H.264 profile, …). When that happens we
  // flip this on and re-resolve the source through the daemon's ffmpeg H.264
  // transcode — the same path mkv/mxf already use — instead of dead-ending.
  const [transcodeFallback, setTranscodeFallback] = useState(false);

  const [playing, setPlaying] = useState(false);
  // Video starts muted so autoplay is always permitted (Chromium/WebView2
  // blocks autoplay-with-sound without a fresh user gesture, which left the
  // clip paused on the first frame). Audio doesn't autoplay, so it starts
  // unmuted — pressing play is the gesture, and the point of audio is sound.
  const [muted, setMuted] = useState(!isAudio);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [rate, setRate] = useState(1);
  const [flipped, setFlipped] = useState(false);
  // When a range is set, playback stays inside it and loops back to the in-
  // point at the out-point — so the user can review just the clip they're
  // commenting on. On by default; the loop button toggles it.
  const [loopRange, setLoopRange] = useState(true);

  const trackRef = useRef<HTMLDivElement>(null);
  // Which selection handle is being dragged, if any.
  const dragRef = useRef<"in" | "out" | null>(null);
  // Whether the video was playing when a handle drag began, so we can resume
  // after the user finishes scrubbing the in/out point.
  const resumeAfterDragRef = useRef(false);

  // Keep the element's playback rate in sync with the chosen speed.
  useEffect(() => {
    if (videoRef.current) videoRef.current.playbackRate = rate;
  }, [rate, src]);

  // Map a clientX (from a pointer event) to a time on the scrubber.
  const timeAtClientX = (clientX: number): number => {
    const el = trackRef.current;
    if (!el || duration <= 0) return 0;
    const rect = el.getBoundingClientRect();
    const frac = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
    return frac * duration;
  };

  const PLAYBACK_RATES = [0.5, 1, 1.5, 2];
  const cycleRate = () =>
    setRate((r) => PLAYBACK_RATES[(PLAYBACK_RATES.indexOf(r) + 1) % PLAYBACK_RATES.length] ?? 1);

  // Nudge the playhead one frame at a time (assume 30fps — we don't carry the
  // real frame rate). Pauses first so the stepped frame stays put, matching the
  // step buttons in the reference player.
  const FRAME = 1 / 30;
  const stepFrame = (dir: -1 | 1) => {
    const v = videoRef.current;
    if (v && !v.paused) v.pause();
    previewSeek(currentTime + dir * FRAME);
  };

  // Seek the displayed video to a time without changing the range — used so
  // dragging or typing an in/out point shows that exact frame ("the scene at
  // that time"), like the reference UI.
  const previewSeek = (t: number) => {
    const v = videoRef.current;
    if (!v || !Number.isFinite(v.duration)) return;
    const clamped = Math.min(v.duration, Math.max(0, t));
    v.currentTime = clamped;
    setCurrentTime(clamped);
  };

  // Update one edge of the range, keeping in ≤ out and within [0, duration].
  const setEdge = (which: "in" | "out", t: number) => {
    if (!selection) return;
    const clamped = Math.min(duration || t, Math.max(0, t));
    if (which === "in") {
      onSelectionChange({ in: Math.min(clamped, selection.out), out: selection.out });
    } else {
      onSelectionChange({ in: selection.in, out: Math.max(clamped, selection.in) });
    }
  };

  // Toggle a comment range: create one around the playhead, or clear it.
  const toggleRange = () => {
    if (selection) {
      onSelectionChange(null);
      return;
    }
    if (duration <= 0) return;
    const len = Math.min(duration, Math.max(2, duration * 0.05));
    onSelectionChange({
      in: currentTime,
      out: Math.min(duration, currentTime + len),
    });
  };

  // Drag an in/out handle to reshape the range (kept ordered, within bounds).
  // We pause while dragging and scrub the video to the handle time so the user
  // sees the frame they're landing on, then resume if it was playing.
  const onHandleDown = (which: "in" | "out") => (e: React.PointerEvent) => {
    e.stopPropagation();
    e.preventDefault();
    dragRef.current = which;
    const v = videoRef.current;
    resumeAfterDragRef.current = !!v && !v.paused;
    if (v && !v.paused) v.pause();
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const onHandleMove = (e: React.PointerEvent) => {
    if (!dragRef.current || !selection) return;
    const t = timeAtClientX(e.clientX);
    setEdge(dragRef.current, t);
    previewSeek(t);
  };
  const onHandleUp = (e: React.PointerEvent) => {
    const which = dragRef.current;
    dragRef.current = null;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
    if (resumeAfterDragRef.current) {
      resumeAfterDragRef.current = false;
      const v = videoRef.current;
      if (v) {
        // Range playback restarts from the in-point so the user immediately
        // hears/sees the clip they just reshaped.
        if (which && selection && loopRange) v.currentTime = selection.in;
        void v.play();
      }
    }
  };

  // Snap an edge to the current playhead — the classic "set in / set out"
  // shortcut, so the user can scrub then click instead of dragging precisely.
  const setInToPlayhead = () => setEdge("in", currentTime);
  const setOutToPlayhead = () => setEdge("out", currentTime);

  // A new file starts fresh: clear any prior decode-failure fallback so we
  // try native streaming first. (Belt-and-suspenders — the parent also keys
  // this component by file, so it normally remounts.)
  useEffect(() => {
    setTranscodeFallback(false);
  }, [file]);

  // Resolve the source. Either the file is a known non-native format
  // (file.transcode), or native playback failed and we're falling back to the
  // server transcode — both route to the ffmpeg H.264 preview clip.
  useEffect(() => {
    setErr(null);
    if (file.transcode || transcodeFallback) {
      // The daemon builds a full-length H.264/AAC proxy in the background and
      // returns 202 while it works. Poll until it's ready (200), then point
      // the player at the streaming proxy (Range-seekable). 204 = no proxy
      // could be produced.
      let stopped = false;
      let timer: number | undefined;
      setSrc(null);
      setPreparing(true);
      let fails = 0;
      const giveUp = (msg: string) => {
        setPreparing(false);
        setErr(msg);
      };
      const poll = async () => {
        if (stopped) return;
        const url = await streamingPreviewURL(
          file.folderID,
          file.path,
          file.size,
          file.modified ?? "",
        );
        if (stopped) return;
        if (!url) {
          // Media server not up yet — try again shortly.
          timer = window.setTimeout(poll, PREVIEW_POLL_MS);
          return;
        }
        try {
          const res = await fetch(url, { method: "HEAD" });
          if (stopped) return;
          if (res.status === 200) {
            setSrc(url); // onCanPlay clears `preparing`
            return;
          }
          if (res.status === 204) {
            giveUp(
              "Couldn't generate a playable preview — the file may be an unsupported codec, still syncing, or too large.",
            );
            return;
          }
          if (res.status === 202) {
            fails = 0; // still generating — expected, keep waiting
            timer = window.setTimeout(poll, PREVIEW_POLL_MS);
            return;
          }
          // Unexpected status — retry a bounded number of times, then stop.
          if (++fails >= MAX_PREVIEW_POLL_ERRORS) {
            giveUp("Couldn't load this preview.");
            return;
          }
          timer = window.setTimeout(poll, PREVIEW_POLL_MS);
        } catch {
          if (stopped) return;
          if (++fails >= MAX_PREVIEW_POLL_ERRORS) {
            giveUp("Couldn't load this preview.");
            return;
          }
          timer = window.setTimeout(poll, PREVIEW_POLL_MS);
        }
      };
      void poll();
      return () => {
        stopped = true;
        if (timer) window.clearTimeout(timer);
      };
    }
    let cancelled = false;
    setSrc(null);
    setPreparing(false);
    streamingVideoURL(file.folderID, file.path)
      .then((u) => {
        if (cancelled) return;
        if (u) setSrc(u);
        else setErr("Preview isn't ready yet — try again in a moment.");
      })
      .catch(() => {
        if (!cancelled) setErr("Couldn't open this file for playback.");
      });
    return () => {
      cancelled = true;
    };
  }, [file, transcodeFallback]);

  // Expose a seek function to the parent.
  useEffect(() => {
    registerSeek((t: number) => {
      const v = videoRef.current;
      if (!v) return;
      v.currentTime = t;
      // Surface the new position immediately, before the next timeupdate.
      setCurrentTime(t);
      onPlayback(t, v.duration || duration);
    });
  }, [registerSeek, onPlayback, duration]);

  const seekToFraction = (fraction: number) => {
    const v = videoRef.current;
    if (!v || !Number.isFinite(v.duration)) return;
    const t = Math.min(v.duration, Math.max(0, fraction * v.duration));
    v.currentTime = t;
    setCurrentTime(t);
  };

  const onTrackClick = (e: React.MouseEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    seekToFraction((e.clientX - rect.left) / rect.width);
  };

  const togglePlay = () => {
    const v = videoRef.current;
    if (!v) return;
    if (v.paused) {
      // Starting playback with a range set: if the playhead is outside it,
      // jump to the in-point so play stays within the selected clip.
      if (
        selection &&
        loopRange &&
        (v.currentTime < selection.in || v.currentTime >= selection.out - 0.03)
      ) {
        previewSeek(selection.in);
      }
      void v.play();
    } else {
      v.pause();
    }
  };

  const pct = duration > 0 ? (currentTime / duration) * 100 : 0;

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-black">
      <div className="relative flex min-h-0 flex-1 items-center justify-center">
        {src && (
          <video
            ref={videoRef}
            src={src}
            autoPlay={!isAudio}
            playsInline
            muted={muted}
            onClick={togglePlay}
            onPlay={() => {
              setPlaying(true);
              setPreparing(false);
            }}
            onPause={() => setPlaying(false)}
            onCanPlay={() => setPreparing(false)}
            onLoadedData={() => setPreparing(false)}
            onLoadStart={() => setErr(null)}
            onLoadedMetadata={(e) => {
              const v = e.currentTarget;
              const d = v.duration || 0;
              setDuration(d);
              onPlayback(v.currentTime, d);
              onMeta?.({ duration: d, width: v.videoWidth, height: v.videoHeight });
            }}
            onTimeUpdate={(e) => {
              const v = e.currentTarget;
              let t = v.currentTime;
              // Loop within the selected range while playing it.
              if (selection && loopRange && !v.paused && t >= selection.out) {
                v.currentTime = selection.in;
                t = selection.in;
              }
              setCurrentTime(t);
              onPlayback(t, v.duration || duration);
            }}
            onError={() => {
              // First failure on a file we assumed was browser-native almost
              // always means WebView2 can't decode the codec (HEVC/ProRes/
              // 10-bit/etc. inside an mp4/mov). Switch to the daemon's ffmpeg
              // H.264 transcode before surfacing an error.
              if (!file.transcode && !transcodeFallback) {
                setTranscodeFallback(true);
                return;
              }
              // The proxy was served (200) but still failed to play — surface
              // it rather than spinning.
              setPreparing(false);
              setErr(
                "Couldn't play this preview — the file may be unsupported or still processing.",
              );
            }}
            // Fit within BOTH dimensions so a portrait clip (e.g. 1080x1920)
            // stays height-bounded and doesn't overflow the area and push the
            // control bar out of view. object-contain preserves aspect ratio.
            className="max-h-full max-w-full object-contain"
            style={flipped ? { transform: "scaleX(-1)" } : undefined}
          />
        )}
        {/* Audio has no picture — draw the waveform ourselves and fill the
            played portion so the user sees progress and motion as it plays. */}
        {isAudio && src && (
          <WaveformProgress
            url={thumbURL(file.folderID, file.path, file.size, file.modified ?? "")}
            pct={pct}
            onToggle={togglePlay}
          />
        )}
        {!err && (preparing || !src) && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 text-fg-soft">
            <div className="relative h-11 w-11">
              <span className="absolute inset-0 animate-spin rounded-full border-2 border-white/10 border-t-accent" />
              <svg
                className="absolute inset-0 m-auto h-4 w-4 text-accent"
                viewBox="0 0 20 20"
                fill="currentColor"
                aria-hidden
              >
                <path d="M6 4l10 6-10 6z" />
              </svg>
            </div>
            <span className="text-sm">
              {file.transcode || transcodeFallback
                ? "Generating preview…"
                : "Loading…"}
            </span>
          </div>
        )}
        {err && (
          <p className="absolute inset-0 flex items-center justify-center px-6 text-center text-sm text-rose-400">
            {err}
          </p>
        )}
      </div>

      {/* Custom control bar: a full-width scrubber row above a controls row,
          matching the reference player. */}
      <div className="border-t border-line-strong bg-panel px-4 pb-3 pt-2.5">
        {/* Scrubber track. Markers sit on top, anchored to their comment time. */}
        <div
          ref={trackRef}
          className="relative mb-2.5 h-6 cursor-pointer"
          onClick={onTrackClick}
          role="presentation"
        >
          <div className="absolute inset-x-0 top-1/2 h-1.5 -translate-y-1/2 rounded-full bg-elevated" />
          <div
            className="absolute top-1/2 left-0 h-1.5 -translate-y-1/2 rounded-full bg-pink-500"
            style={{ width: `${pct}%` }}
          />
          {/* Pending in→out selection: an emerald range whose bracket handles
              sit just OUTSIDE each point — the "[" left of the in-point, the
              "]" right of the out-point — so start and end never overlap, even
              when the range is a single instant. */}
          {duration > 0 &&
            selection &&
            (() => {
              const inPct = Math.min(100, Math.max(0, (selection.in / duration) * 100));
              const outPct = Math.min(100, Math.max(0, (selection.out / duration) * 100));
              return (
                <>
                  <div
                    className="pointer-events-none absolute top-1/2 h-2 -translate-y-1/2 rounded-sm bg-emerald-400/30 ring-1 ring-emerald-300/50"
                    style={{ left: `${inPct}%`, width: `${Math.max(0, outPct - inPct)}%` }}
                  />
                  <div
                    role="slider"
                    aria-label="Range start"
                    aria-valuetext={formatTimecodeMs(selection.in)}
                    title={`Start ${formatTimecodeMs(selection.in)} — drag, or edit below`}
                    onPointerDown={onHandleDown("in")}
                    onPointerMove={onHandleMove}
                    onPointerUp={onHandleUp}
                    onClick={(e) => e.stopPropagation()}
                    className="absolute top-1/2 z-30 h-5 w-2.5 cursor-ew-resize rounded-l-sm border-y-2 border-l-2 border-emerald-400 bg-emerald-400/25 shadow hover:bg-emerald-400/50"
                    style={{ left: `${inPct}%`, transform: "translate(-100%, -50%)", touchAction: "none" }}
                  />
                  <div
                    role="slider"
                    aria-label="Range end"
                    aria-valuetext={formatTimecodeMs(selection.out)}
                    title={`End ${formatTimecodeMs(selection.out)} — drag, or edit below`}
                    onPointerDown={onHandleDown("out")}
                    onPointerMove={onHandleMove}
                    onPointerUp={onHandleUp}
                    onClick={(e) => e.stopPropagation()}
                    className="absolute top-1/2 z-30 h-5 w-2.5 cursor-ew-resize rounded-r-sm border-y-2 border-r-2 border-emerald-400 bg-emerald-400/25 shadow hover:bg-emerald-400/50"
                    style={{ left: `${outPct}%`, transform: "translateY(-50%)", touchAction: "none" }}
                  />
                </>
              );
            })()}
          {/* Range comments render as a bar; point comments as a tick. */}
          {duration > 0 &&
            markers.map((c) =>
              c.tEnd !== undefined && c.tEnd > c.t ? (
                <button
                  key={c.id}
                  type="button"
                  title={`${formatClock(c.t)}–${formatClock(c.tEnd)} — ${c.author.name}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    seekToFraction(c.t / duration);
                    onMarkerClick(c);
                  }}
                  className={cn(
                    "absolute top-1/2 h-2 -translate-y-1/2 rounded-full border border-base transition-all hover:brightness-125",
                    c.resolved ? "bg-emerald-400" : "bg-pink-500",
                    activeMarkerId === c.id && "ring-2 ring-white/70",
                  )}
                  style={{
                    left: `${Math.min(100, (c.t / duration) * 100)}%`,
                    width: `${Math.max(1.5, ((c.tEnd - c.t) / duration) * 100)}%`,
                  }}
                />
              ) : (
                <button
                  key={c.id}
                  type="button"
                  title={`${formatClock(c.t)} — ${c.author.name}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    seekToFraction(c.t / duration);
                    onMarkerClick(c);
                  }}
                  className={cn(
                    "absolute top-1/2 h-3.5 w-1 -translate-x-1/2 -translate-y-1/2 rounded-full transition-transform hover:scale-125",
                    c.resolved ? "bg-emerald-400" : "bg-pink-500",
                    activeMarkerId === c.id && "scale-125 ring-2 ring-white/70",
                  )}
                  style={{ left: `${Math.min(100, (c.t / duration) * 100)}%` }}
                />
              ),
            )}
          {/* Playhead: a thin white line with a square cap (drawn last so it
              sits above markers). */}
          <div
            className="pointer-events-none absolute inset-y-0 z-10 w-0.5 -translate-x-1/2 bg-white"
            style={{ left: `${pct}%` }}
          >
            <div className="absolute -top-0.5 left-1/2 h-2.5 w-2.5 -translate-x-1/2 rounded-sm bg-white shadow" />
          </div>
        </div>

        {/* Controls row. */}
        <div className="flex items-center gap-2.5">
          <button
            type="button"
            onClick={() => stepFrame(-1)}
            title="Previous frame"
            className="shrink-0 text-fg-soft hover:text-fg-strong"
          >
            <svg className="h-5 w-5" viewBox="0 0 20 20" fill="currentColor" aria-hidden>
              <path d="M5 4h2v12H5zM8 10l8-6v12z" />
            </svg>
          </button>
          <button
            type="button"
            onClick={togglePlay}
            aria-label={playing ? "Pause" : "Play"}
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-white text-base shadow hover:bg-white/90"
          >
            {playing ? (
              <svg className="h-5 w-5" viewBox="0 0 20 20" fill="currentColor" aria-hidden>
                <path d="M6 4h3v12H6zM11 4h3v12h-3z" />
              </svg>
            ) : (
              <svg className="h-5 w-5" viewBox="0 0 20 20" fill="currentColor" aria-hidden>
                <path d="M6 4l10 6-10 6z" />
              </svg>
            )}
          </button>
          <button
            type="button"
            onClick={() => stepFrame(1)}
            title="Next frame"
            className="shrink-0 text-fg-soft hover:text-fg-strong"
          >
            <svg className="h-5 w-5" viewBox="0 0 20 20" fill="currentColor" aria-hidden>
              <path d="M13 4h2v12h-2zM4 4l8 6-8 6z" />
            </svg>
          </button>

          <span className="ml-1 shrink-0 font-mono text-xs tabular-nums text-fg">
            {formatClock(currentTime)}
            <span className="text-fg-faint"> / {formatClock(duration)}</span>
          </span>

          {/* IN → OUT range chip (mirrors the reference; the editable
              timecodes live in the range editor strip below). */}
          {selection && (
            <div className="ml-2 flex items-center gap-1.5 rounded-lg bg-elevated px-2 py-1 ring-1 ring-line">
              <span className="font-mono text-[11px] text-emerald-300">IN {formatClock(selection.in)}</span>
              <span className="text-fg-faint">→</span>
              <span className="font-mono text-[11px] text-emerald-300">OUT {formatClock(selection.out)}</span>
            </div>
          )}

          <div className="ml-auto flex items-center gap-1 text-fg-soft">
            {/* Playback speed (cycles through 0.5/1/1.5/2). */}
            <button
              type="button"
              onClick={cycleRate}
              title="Playback speed"
              className="rounded-md px-2 py-1 font-mono text-[11px] tabular-nums hover:bg-hover hover:text-fg-strong"
            >
              {rate}×
            </button>

            {/* Comment range: create/clear; drag the timeline handles to adjust. */}
            <button
              type="button"
              onClick={toggleRange}
              title={selection ? "Clear comment range" : "Add a comment range"}
              aria-pressed={!!selection}
              className={cn(
                "rounded-md p-1.5 hover:bg-hover hover:text-fg-strong",
                selection ? "text-emerald-300" : "",
              )}
            >
              <svg className="h-4 w-4" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden>
                <path d="M6 5v10M14 5v10M6 10h8" />
              </svg>
            </button>

            {/* Horizontal flip (mirror) — video only. */}
            {!isAudio && (
              <button
                type="button"
                onClick={() => setFlipped((f) => !f)}
                title={flipped ? "Unflip" : "Flip horizontally"}
                aria-pressed={flipped}
                className={cn(
                  "rounded-md p-1.5 hover:bg-hover hover:text-fg-strong",
                  flipped ? "text-accent" : "",
                )}
              >
                <svg className="h-4 w-4" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                  <path d="M10 3v14" strokeDasharray="2 2" />
                  <path d="M8 6L4 10l4 4zM12 6l4 4-4 4" />
                </svg>
              </button>
            )}

            <button
              type="button"
              onClick={() => setMuted((m) => !m)}
              aria-label={muted ? "Unmute" : "Mute"}
              className="rounded-md p-1.5 hover:bg-hover hover:text-fg-strong"
            >
              {muted ? (
                <svg className="h-4 w-4" viewBox="0 0 20 20" fill="currentColor" aria-hidden>
                  <path d="M3 8v4h3l4 3V5L6 8H3z" />
                  <path d="M13 7l4 6M17 7l-4 6" stroke="currentColor" strokeWidth="1.4" fill="none" />
                </svg>
              ) : (
                <svg className="h-4 w-4" viewBox="0 0 20 20" fill="currentColor" aria-hidden>
                  <path d="M3 8v4h3l4 3V5L6 8H3z" />
                  <path d="M13 7a4 4 0 010 6" stroke="currentColor" strokeWidth="1.4" fill="none" />
                </svg>
              )}
            </button>
          </div>
        </div>
      </div>

      {/* Range editor — appears when a comment range is active. Drag the
          timeline brackets, type exact millisecond timecodes, or snap an edge
          to the playhead. Mirrors the reference UI's bottom range bar. */}
      {selection && duration > 0 && (
        <div className="flex flex-wrap items-center gap-2 border-t border-line-strong bg-panel px-3 py-1.5 text-[11px] text-fg-soft">
          <span className="font-mono text-fg-faint" aria-hidden>
            {"{ }"}
          </span>
          <button
            type="button"
            onClick={setInToPlayhead}
            title="Set start to the current frame"
            className="shrink-0 rounded p-1 text-fg-soft hover:bg-elevated hover:text-emerald-300"
          >
            <svg className="h-4 w-4" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M12 4H7v12h5" />
              <path d="M7 10h4l-1.5-1.5M11 10l-1.5 1.5" />
            </svg>
          </button>
          <TimecodeField
            label="Range start"
            value={selection.in}
            onCommit={(t) => {
              setEdge("in", t);
              previewSeek(Math.min(t, selection.out));
            }}
          />
          <span className="text-fg-faint">–</span>
          <TimecodeField
            label="Range end"
            value={selection.out}
            onCommit={(t) => {
              setEdge("out", t);
              previewSeek(Math.max(t, selection.in));
            }}
          />
          <button
            type="button"
            onClick={setOutToPlayhead}
            title="Set end to the current frame"
            className="shrink-0 rounded p-1 text-fg-soft hover:bg-elevated hover:text-emerald-300"
          >
            <svg className="h-4 w-4" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M8 4h5v12H8" />
              <path d="M13 10H9l1.5-1.5M9 10l1.5 1.5" />
            </svg>
          </button>
          <span
            className="ml-1 rounded bg-elevated px-1.5 py-0.5 font-mono tabular-nums text-fg-faint"
            title="Range length"
          >
            {formatTimecodeMs(Math.max(0, selection.out - selection.in))}
          </span>
          <div className="flex-1" />
          <button
            type="button"
            onClick={() => setLoopRange((v) => !v)}
            aria-pressed={loopRange}
            title={loopRange ? "Looping the range while playing" : "Play the range once"}
            className={cn(
              "shrink-0 rounded p-1 hover:bg-elevated hover:text-fg-strong",
              loopRange ? "text-emerald-300" : "text-fg-soft",
            )}
          >
            <svg className="h-4 w-4" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M4 10a6 6 0 0 1 6-6h4" />
              <path d="M12 2l2 2-2 2" />
              <path d="M16 10a6 6 0 0 1-6 6H6" />
              <path d="M8 18l-2-2 2-2" />
            </svg>
          </button>
          <button
            type="button"
            onClick={() => onSelectionChange(null)}
            title="Clear range"
            className="shrink-0 rounded p-1 text-fg-soft hover:bg-elevated hover:text-rose-300"
          >
            <svg className="h-4 w-4" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden>
              <path d="M5 5l10 10M15 5L5 15" />
            </svg>
          </button>
        </div>
      )}
    </div>
  );
}

// WaveformProgress draws the daemon's waveform image for audio and overlays a
// "played" copy revealed left→right as playback advances — the unplayed part
// is dim/gray, the played part is the waveform's natural teal (the app's audio
// accent), with a moving teal playhead line. An audio <video> element has no
// picture to click, so this overlay is also the play/pause hit target. Both
// <img>s are the same element stacked, so the clip-path on the played copy
// lines up exactly with the base.
function WaveformProgress({
  url,
  pct,
  onToggle,
}: {
  url: string;
  pct: number;
  onToggle: () => void;
}) {
  const clamped = Math.min(100, Math.max(0, pct));
  return (
    <div
      onClick={onToggle}
      role="presentation"
      className="absolute inset-0 flex cursor-pointer items-center justify-center p-6 sm:p-10"
    >
      <div className="relative w-full max-w-3xl">
        {/* Unplayed: dim, desaturated waveform. */}
        <img
          src={url}
          alt=""
          aria-hidden
          draggable={false}
          className="block w-full select-none [filter:grayscale(1)_brightness(0.5)]"
        />
        {/* Played: the waveform's natural teal, brightened, revealed up to
            the playhead. */}
        <img
          src={url}
          alt=""
          aria-hidden
          draggable={false}
          className="absolute inset-0 block w-full select-none [filter:brightness(1.25)_saturate(1.3)]"
          style={{ clipPath: `inset(0 ${100 - clamped}% 0 0)` }}
        />
        {/* Playhead line (teal accent). */}
        <div
          className="absolute inset-y-0 w-0.5 -translate-x-1/2 bg-teal-300 shadow-[0_0_8px_rgba(45,212,191,0.85)]"
          style={{ left: `${clamped}%` }}
        />
      </div>
    </div>
  );
}

// TimecodeField is an editable millisecond timecode (MM:SS.mmm). It shows the
// live value while idle and lets the user type a new one, committing on Enter
// or blur and reverting on Escape or an unparseable entry.
function TimecodeField({
  value,
  onCommit,
  label,
}: {
  value: number;
  onCommit: (seconds: number) => void;
  label: string;
}) {
  const [text, setText] = useState(() => formatTimecodeMs(value));
  const [editing, setEditing] = useState(false);

  // Track the external value while not actively editing.
  useEffect(() => {
    if (!editing) setText(formatTimecodeMs(value));
  }, [value, editing]);

  const commit = () => {
    setEditing(false);
    const parsed = parseTimecodeMs(text);
    if (parsed != null) onCommit(parsed);
    else setText(formatTimecodeMs(value));
  };

  return (
    <input
      aria-label={label}
      value={text}
      inputMode="numeric"
      spellCheck={false}
      onFocus={(e) => {
        setEditing(true);
        e.currentTarget.select();
      }}
      onChange={(e) => setText(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") e.currentTarget.blur();
        else if (e.key === "Escape") {
          setText(formatTimecodeMs(value));
          setEditing(false);
          e.currentTarget.blur();
        }
      }}
      className="w-24 rounded border border-line-strong bg-base px-1.5 py-0.5 text-center font-mono text-[11px] tabular-nums text-fg-strong outline-none focus:border-emerald-400"
    />
  );
}
