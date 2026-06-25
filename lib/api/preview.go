// Copyright (C) 2014 The Syncthing Authors.
//
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this file,
// You can obtain one at https://mozilla.org/MPL/2.0/.

package api

import (
	"context"
	"fmt"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"time"
)

// Short transcoded preview clips for formats the WebView2 <video> element
// can't decode directly (MXF, MKV, AVI, WMV, BRAW, …). The browser plays the
// raw bytes for mp4/mov/webm, but everything else needs a server-side H.264
// transcode. We produce a capped-length, 720p MP4 once and cache it on disk;
// the client then plays/seeks it like any other video.
//
// As with thumbnails, the heavy work runs in bounded, timed subprocesses so a
// huge or malformed clip can't exhaust memory or wedge the daemon.

const (
	previewMaxDuration   = 30  // seconds of the source to include
	previewHeight        = 720 // cap output height; never upscales
	previewMaxConcurrent = 2    // transcodes are far heavier than thumbs
	previewTimeout       = 240 * time.Second
	// Upper bound for a full-length proxy transcode (runs in the background).
	// Generous so long masters finish; just a backstop against a wedged job.
	fullTranscodeTimeout = 2 * time.Hour

	// BRAW is decoded frame-by-frame through the vendor SDK, which is far
	// costlier than an ffmpeg decode, so its preview is shorter and lower
	// frame-rate to keep generation bounded.
	brawPreviewDuration = 8
	brawPreviewFps      = 15
)

var (
	previewSem = make(chan struct{}, previewMaxConcurrent)

	previewFailMu sync.Mutex
	previewFailed = map[string]time.Time{} // cache key -> time of failure

	// Keys with a proxy transcode currently running in the background, so
	// concurrent requests for the same file share one job instead of starting
	// a duplicate.
	previewGenMu  sync.Mutex
	previewGenSet = map[string]time.Time{}

	// Cap each transcode's encoder threads so the previewMaxConcurrent
	// jobs share the CPU instead of each grabbing every core and thrashing.
	previewThreads = func() int {
		if n := runtime.NumCPU() / previewMaxConcurrent; n >= 1 {
			return n
		}
		return 1
	}()
)

func previewCacheDir() string {
	base, err := os.UserCacheDir()
	if err != nil || base == "" {
		base = os.TempDir()
	}
	dir := filepath.Join(base, "vidsync-previews")
	_ = os.MkdirAll(dir, 0o755)
	return dir
}

func previewRecentlyFailed(key string) bool {
	previewFailMu.Lock()
	defer previewFailMu.Unlock()
	t, ok := previewFailed[key]
	if !ok {
		return false
	}
	if time.Since(t) > thumbFailTTL {
		delete(previewFailed, key)
		return false
	}
	return true
}

func markPreviewFailed(key string) {
	previewFailMu.Lock()
	sweepExpired(previewFailed, thumbFailTTL)
	previewFailed[key] = time.Now()
	previewFailMu.Unlock()
}

// startPreviewGen marks a preview key as generating; returns false if a job is
// already running for it (so the caller doesn't start a duplicate).
func startPreviewGen(key string) bool {
	previewGenMu.Lock()
	defer previewGenMu.Unlock()
	// Drop entries old enough that their goroutine must have died, so a wedged
	// key can't block previews forever.
	sweepExpired(previewGenSet, fullTranscodeTimeout+time.Minute)
	if _, ok := previewGenSet[key]; ok {
		return false
	}
	previewGenSet[key] = time.Now()
	return true
}

func endPreviewGen(key string) {
	previewGenMu.Lock()
	delete(previewGenSet, key)
	previewGenMu.Unlock()
}

// getFolderPreview serves a cached, full-length H.264/AAC proxy for a file the
// browser can't play natively, generating it in the background on first
// request. The proxy is served with http.ServeContent so the player gets Range
// support (seek anywhere). While it's still being produced we return 202
// Accepted so the client can poll; 204 means no proxy could be produced
// (genuinely undecodable) and the UI falls back to its error state.
func (s *service) getFolderPreview(w http.ResponseWriter, r *http.Request) {
	ffmpeg := findFFmpeg()
	if ffmpeg == "" {
		http.Error(w, "ffmpeg not available", http.StatusServiceUnavailable)
		return
	}
	qs := r.URL.Query()
	folderID := qs.Get("folder")
	relPath := qs.Get("path")
	cleaned, info, status, err := s.resolveFolderFile(folderID, relPath)
	if err != nil {
		http.Error(w, err.Error(), status)
		return
	}

	key := thumbKey(folderID, relPath, info.Size(), info.ModTime())
	cacheFile := filepath.Join(previewCacheDir(), key+".mp4")
	if fileExists(cacheFile) {
		servePreview(w, r, cacheFile)
		return
	}
	if previewRecentlyFailed(key) {
		w.WriteHeader(http.StatusNoContent)
		return
	}

	// A full-length transcode can take minutes, so we never block the request
	// (or hold the connection) on it — generate in the background and let the
	// client poll. startPreviewGen dedupes concurrent requests for the file.
	if startPreviewGen(key) {
		go s.generatePreview(ffmpeg, cleaned, info, key, cacheFile)
	}
	w.Header().Set("Retry-After", "2")
	w.WriteHeader(http.StatusAccepted)
}

// generatePreview produces the proxy in the background and moves it into the
// cache atomically. Failures are recorded so we don't re-attempt a genuinely
// undecodable file on every poll.
func (s *service) generatePreview(ffmpeg, cleaned string, info os.FileInfo, key, cacheFile string) {
	defer endPreviewGen(key)

	ctx, cancel := context.WithTimeout(context.Background(), fullTranscodeTimeout)
	defer cancel()

	ext := strings.ToLower(filepath.Ext(cleaned))
	tmp := cacheFile + ".tmp-" + strconv.FormatInt(info.ModTime().UnixNano(), 10)

	var err error
	switch {
	case rawThumbExts[ext]:
		braw := findBrawThumb()
		if braw == "" {
			markPreviewFailed(key)
			return
		}
		err = generateBrawPreview(ctx, ffmpeg, braw, cleaned, tmp)
	case audioThumbExts[ext]:
		// Audio has no video stream, so the H.264 path's video filters would
		// fail — transcode just the audio to AAC instead.
		err = generateAudioPreview(ctx, ffmpeg, cleaned, tmp)
	default:
		err = generateFFmpegPreview(ctx, ffmpeg, cleaned, tmp)
	}
	if err != nil || !fileExists(tmp) {
		_ = os.Remove(tmp)
		markPreviewFailed(key)
		return
	}
	// Move the finished proxy into place atomically so a concurrent reader
	// never sees a partial file.
	if err := os.Rename(tmp, cacheFile); err != nil {
		_ = os.Remove(tmp)
		markPreviewFailed(key)
		return
	}
	maybePrune(filepath.Dir(cacheFile), ".mp4", previewCacheMaxBytes)
}

// previewScale keeps the source aspect ratio, caps height at previewHeight,
// never upscales, and forces even dimensions (required by yuv420p / H.264):
// width -2 stays even, the height expression caps at previewHeight and rounds
// down to an even value. Quoted so the inner comma isn't read as a filter
// separator.
var previewScale = "scale=-2:'2*trunc(min(" +
	strconv.Itoa(previewHeight) + ",ih)/2)'"

// generateFFmpegPreview transcodes the first previewMaxDuration seconds of an
// ffmpeg-decodable clip to a browser-playable H.264/AAC MP4.
func generateFFmpegPreview(ctx context.Context, ffmpeg, absPath, outPath string) error {
	select {
	case previewSem <- struct{}{}:
		defer func() { <-previewSem }()
	case <-ctx.Done():
		return ctx.Err()
	}

	// Full-length transcode — the caller bounds the runtime via ctx. yuv420p +
	// faststart keep it playable and seekable in WebView2 once cached.
	return runFile(ctx, ffmpeg,
		"-nostdin", "-loglevel", "error", "-y",
		"-i", absPath,
		"-vf", previewScale,
		"-threads", strconv.Itoa(previewThreads),
		"-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p",
		"-profile:v", "high", "-crf", "26",
		"-c:a", "aac", "-b:a", "128k", "-ac", "2",
		"-movflags", "+faststart",
		// The output path is a .tmp-<n> file, so name the muxer explicitly
		// rather than letting ffmpeg infer it from the extension.
		"-f", "mp4",
		outPath)
}

// generateAudioPreview transcodes an audio file to a browser-playable AAC
// track in an MP4 container (no video stream). Used for formats WebView2
// can't decode directly (AIFF, WMA, ALAC, AC3, MKA, …). Unlike the video
// preview it isn't length-capped: audio is cheap to encode and the point is
// to play the whole take, not a teaser clip. The previewTimeout still bounds
// runaway jobs, and the cache prune bounds disk use.
func generateAudioPreview(ctx context.Context, ffmpeg, absPath, outPath string) error {
	select {
	case previewSem <- struct{}{}:
		defer func() { <-previewSem }()
	case <-ctx.Done():
		return ctx.Err()
	}

	// -vn drops any cover-art/video stream so we never hit a video encoder.
	// faststart lets WebView2 start playback before the whole file downloads.
	// Full-length; the caller bounds the runtime via ctx.
	return runFile(ctx, ffmpeg,
		"-nostdin", "-loglevel", "error", "-y",
		"-i", absPath,
		"-vn",
		"-c:a", "aac", "-b:a", "192k", "-ac", "2",
		"-movflags", "+faststart",
		"-f", "mp4",
		outPath)
}

// generateBrawPreview decodes a short, low-frame-rate sequence from a BRAW
// clip via the SDK helper (which writes f_00001.ppm, f_00002.ppm, …) and
// assembles those frames into an H.264 MP4 with ffmpeg.
func generateBrawPreview(ctx context.Context, ffmpeg, brawTool, absPath, outPath string) error {
	select {
	case previewSem <- struct{}{}:
		defer func() { <-previewSem }()
	case <-ctx.Done():
		return ctx.Err()
	}

	cctx, cancel := context.WithTimeout(ctx, previewTimeout)
	defer cancel()

	framesDir, err := os.MkdirTemp("", "brawclip-")
	if err != nil {
		return err
	}
	defer os.RemoveAll(framesDir)

	// braw-thumb --clip <input> <framesDir> <fps> <seconds>
	if err := runFile(cctx, brawTool, "--clip", absPath, framesDir,
		strconv.Itoa(brawPreviewFps), strconv.Itoa(brawPreviewDuration)); err != nil {
		return err
	}

	return runFile(cctx, ffmpeg,
		"-nostdin", "-loglevel", "error", "-y",
		"-framerate", strconv.Itoa(brawPreviewFps),
		"-i", filepath.Join(framesDir, "f_%05d.ppm"),
		"-vf", previewScale,
		"-threads", strconv.Itoa(previewThreads),
		"-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p",
		"-profile:v", "high", "-crf", "26",
		"-movflags", "+faststart",
		"-f", "mp4",
		outPath)
}

// runFile runs a command that writes its result to a file (rather than to
// stdout), discarding stdout/stderr. The caller supplies a context that
// already carries the timeout.
func runFile(ctx context.Context, name string, args ...string) error {
	cmd := exec.CommandContext(ctx, name, args...)
	hideConsole(cmd) // suppress the console window on Windows
	out, err := cmd.CombinedOutput()
	if err != nil {
		return fmt.Errorf("%s: %w: %s", filepath.Base(name), err, strings.TrimSpace(string(out)))
	}
	return nil
}

func servePreview(w http.ResponseWriter, r *http.Request, path string) {
	f, err := os.Open(path)
	if err != nil {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	w.Header().Set("Content-Type", "video/mp4")
	w.Header().Set("Cache-Control", "private, max-age=86400")
	http.ServeContent(w, r, "preview.mp4", info.ModTime(), f)
}
