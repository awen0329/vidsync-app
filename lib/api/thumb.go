// Copyright (C) 2014 The Syncthing Authors.
//
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this file,
// You can obtain one at https://mozilla.org/MPL/2.0/.

package api

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
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

// Thumbnail generation for the file browser. We shell out to ffmpeg in a
// short-lived subprocess rather than decoding in the WebView2 <video>
// element. Two reasons:
//
//   - Coverage: ffmpeg carries its own decoders, so it handles formats
//     the browser can't (MXF, ProRes, DNxHD, most audio, …) and doesn't
//     depend on OS media codecs — which matters on Windows Server, where
//     the consumer H.264 codecs that <video> needs aren't installed, so
//     even .mp4 thumbnails fail in the browser.
//   - Safety: decoding a malformed or enormous file can crash a decoder.
//     A separate process with a hard timeout means a crash takes down the
//     ffmpeg child, never the daemon or the app.
//
// Results are cached on disk keyed by folder+path+size+modtime, so a file
// is only decoded once. Concurrency is bounded so a folder full of clips
// can't spawn hundreds of ffmpeg processes at once.

const (
	thumbMaxWidth      = 480
	thumbTimeout       = 20 * time.Second
	thumbMaxConcurrent = 4
	// How long to suppress retries for a file ffmpeg couldn't decode, so
	// an undecodable/corrupt file isn't re-attempted on every render.
	// In-memory only — a daemon restart gets a fresh shot.
	thumbFailTTL = 30 * time.Second
)

// Audio extensions get a waveform image instead of a video poster frame, and
// an audio-only AAC transcode (rather than the H.264 path) when previewed.
var audioThumbExts = map[string]bool{
	".wav": true, ".mp3": true, ".aac": true, ".flac": true, ".ogg": true,
	".oga": true, ".m4a": true, ".aiff": true, ".aif": true, ".aifc": true,
	".wma": true, ".opus": true, ".alac": true, ".mka": true, ".ac3": true,
	".m4r": true, ".mmf": true,
}

// Camera-RAW extensions ffmpeg can't decode; they go through a vendor-SDK
// helper (braw-thumb) that emits a PPM we then hand to ffmpeg. Only .braw is
// supported today; .r3d would need the separate RED SDK.
var rawThumbExts = map[string]bool{
	".braw": true,
}

var (
	ffmpegOnce sync.Once
	ffmpegPath string

	brawOnce sync.Once
	brawPath string

	thumbSem = make(chan struct{}, thumbMaxConcurrent)

	thumbFailMu sync.Mutex
	thumbFailed = map[string]time.Time{} // cache key -> time of failure
)

// findFFmpeg locates the ffmpeg binary once: an explicit VIDSYNC_FFMPEG
// override, then alongside the running executable (where the app bundles
// it), then anything on PATH (handy in dev). Empty string => unavailable.
func findFFmpeg() string {
	ffmpegOnce.Do(func() {
		name := "ffmpeg"
		if runtime.GOOS == "windows" {
			name = "ffmpeg.exe"
		}
		if p := strings.TrimSpace(os.Getenv("VIDSYNC_FFMPEG")); p != "" {
			if fileExists(p) {
				ffmpegPath = p
				return
			}
		}
		if exe, err := os.Executable(); err == nil {
			cand := filepath.Join(filepath.Dir(exe), name)
			if fileExists(cand) {
				ffmpegPath = cand
				return
			}
		}
		if p, err := exec.LookPath(name); err == nil {
			ffmpegPath = p
		}
	})
	return ffmpegPath
}

// findBrawThumb locates the braw-thumb helper (which bundles the Blackmagic
// RAW SDK runtime alongside it). Order: VIDSYNC_BRAW_THUMB override, a braw/
// subdir next to the app (where it's bundled), next to the app directly, then
// PATH. Empty string => BRAW thumbnails unavailable (UI falls back to glyph).
func findBrawThumb() string {
	brawOnce.Do(func() {
		name := "braw-thumb"
		if runtime.GOOS == "windows" {
			name = "braw-thumb.exe"
		}
		if p := strings.TrimSpace(os.Getenv("VIDSYNC_BRAW_THUMB")); p != "" {
			if fileExists(p) {
				brawPath = p
				return
			}
		}
		if exe, err := os.Executable(); err == nil {
			dir := filepath.Dir(exe)
			for _, cand := range []string{
				filepath.Join(dir, "braw", name),
				filepath.Join(dir, name),
			} {
				if fileExists(cand) {
					brawPath = cand
					return
				}
			}
		}
		if p, err := exec.LookPath(name); err == nil {
			brawPath = p
		}
	})
	return brawPath
}

func fileExists(p string) bool {
	info, err := os.Stat(p)
	return err == nil && !info.IsDir()
}

func thumbCacheDir() string {
	base, err := os.UserCacheDir()
	if err != nil || base == "" {
		base = os.TempDir()
	}
	dir := filepath.Join(base, "vidsync-thumbs")
	_ = os.MkdirAll(dir, 0o755)
	return dir
}

func thumbKey(folderID, relPath string, size int64, mod time.Time) string {
	h := sha256.Sum256([]byte(folderID + "\x00" + relPath + "\x00" +
		strconv.FormatInt(size, 10) + "\x00" + strconv.FormatInt(mod.UnixNano(), 10)))
	return hex.EncodeToString(h[:])
}

func recentlyFailed(key string) bool {
	thumbFailMu.Lock()
	defer thumbFailMu.Unlock()
	t, ok := thumbFailed[key]
	if !ok {
		return false
	}
	if time.Since(t) > thumbFailTTL {
		delete(thumbFailed, key)
		return false
	}
	return true
}

func markFailed(key string) {
	thumbFailMu.Lock()
	sweepExpired(thumbFailed, thumbFailTTL)
	thumbFailed[key] = time.Now()
	thumbFailMu.Unlock()
}

// getFolderThumb returns a JPEG thumbnail for a file in a managed folder,
// generating it with ffmpeg (and caching it on disk) on first request.
// Responds 204 when no thumbnail could be produced so the UI falls back
// to its extension glyph.
func (s *service) getFolderThumb(w http.ResponseWriter, r *http.Request) {
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
	cacheFile := filepath.Join(thumbCacheDir(), key+".jpg")
	if fileExists(cacheFile) {
		serveJPEG(w, cacheFile)
		return
	}
	if recentlyFailed(key) {
		w.WriteHeader(http.StatusNoContent)
		return
	}

	ext := strings.ToLower(filepath.Ext(cleaned))
	var data []byte
	if rawThumbExts[ext] {
		braw := findBrawThumb()
		if braw == "" {
			// No vendor-RAW decoder bundled; let the UI show its glyph.
			markFailed(key)
			w.WriteHeader(http.StatusNoContent)
			return
		}
		data, err = generateRawThumb(r.Context(), ffmpeg, braw, cleaned)
	} else {
		data, err = generateThumb(r.Context(), ffmpeg, cleaned, audioThumbExts[ext])
	}
	if err != nil || len(data) == 0 {
		// Don't poison the cache when the client simply navigated away mid-
		// decode — very common while scrolling the grid (a thumbnail request
		// is canceled as it scrolls out of view). That's not the file's
		// fault, and caching it would blank a perfectly good thumbnail for
		// the whole suppression window.
		if r.Context().Err() == nil {
			markFailed(key)
		}
		w.WriteHeader(http.StatusNoContent)
		return
	}
	writeCacheAtomic(cacheFile, data)
	maybePrune(filepath.Dir(cacheFile), ".jpg", thumbCacheMaxBytes)

	w.Header().Set("Content-Type", "image/jpeg")
	w.Header().Set("Cache-Control", "private, max-age=86400")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(data)
}

// generateThumb runs ffmpeg to extract a single JPEG frame (a poster for
// video, a rendered waveform for audio) to stdout. Bounded by a global
// concurrency semaphore and a hard timeout so a stuck/huge decode can't
// pile up or hang.
func generateThumb(ctx context.Context, ffmpeg, absPath string, isAudio bool) ([]byte, error) {
	select {
	case thumbSem <- struct{}{}:
		defer func() { <-thumbSem }()
	case <-ctx.Done():
		return nil, ctx.Err()
	}

	if isAudio {
		return runTool(ctx, ffmpeg,
			"-nostdin", "-loglevel", "error", "-i", absPath,
			"-filter_complex", "showwavespic=s=480x270:colors=#3fc3b1",
			"-frames:v", "1", "-f", "image2", "-c:v", "mjpeg", "-")
	}

	// Seek ~1s in for a representative frame; -ss before -i is fast
	// input seeking. Very short clips have nothing at 1s, so fall back
	// to the first frame.
	scale := "scale='min(" + strconv.Itoa(thumbMaxWidth) + ",iw)':-2"
	out, err := runTool(ctx, ffmpeg,
		"-nostdin", "-loglevel", "error", "-ss", "1", "-i", absPath,
		"-frames:v", "1", "-vf", scale, "-q:v", "4", "-f", "image2", "-c:v", "mjpeg", "-")
	if err == nil && len(out) > 0 {
		return out, nil
	}
	return runTool(ctx, ffmpeg,
		"-nostdin", "-loglevel", "error", "-i", absPath,
		"-frames:v", "1", "-vf", scale, "-q:v", "4", "-f", "image2", "-c:v", "mjpeg", "-")
}

// generateRawThumb decodes the first frame of a camera-RAW clip (.braw) with
// the vendor-SDK helper, which writes a PPM, then scales+encodes it to JPEG
// with ffmpeg. The helper runs at reduced resolution and as its own process,
// so a huge/corrupt clip can't blow up memory or take down the daemon.
func generateRawThumb(ctx context.Context, ffmpeg, brawTool, absPath string) ([]byte, error) {
	select {
	case thumbSem <- struct{}{}:
		defer func() { <-thumbSem }()
	case <-ctx.Done():
		return nil, ctx.Err()
	}

	tmp, err := os.CreateTemp("", "braw-*.ppm")
	if err != nil {
		return nil, err
	}
	ppm := tmp.Name()
	tmp.Close()
	defer os.Remove(ppm)

	if _, err := runTool(ctx, brawTool, absPath, ppm); err != nil {
		return nil, err
	}
	if !fileExists(ppm) {
		return nil, errors.New("braw-thumb produced no output")
	}

	scale := "scale='min(" + strconv.Itoa(thumbMaxWidth) + ",iw)':-2"
	return runTool(ctx, ffmpeg,
		"-nostdin", "-loglevel", "error", "-i", ppm,
		"-frames:v", "1", "-vf", scale, "-q:v", "4", "-f", "image2", "-c:v", "mjpeg", "-")
}

func runTool(ctx context.Context, tool string, args ...string) ([]byte, error) {
	cctx, cancel := context.WithTimeout(ctx, thumbTimeout)
	defer cancel()
	cmd := exec.CommandContext(cctx, tool, args...)
	hideConsole(cmd) // suppress the console window on Windows
	// stdout carries the image bytes; stderr is suppressed/ignored.
	return cmd.Output()
}

// writeCacheAtomic writes the JPEG to a temp file then renames it into
// place so a concurrent reader never sees a half-written file.
func writeCacheAtomic(dst string, data []byte) {
	tmp, err := os.CreateTemp(filepath.Dir(dst), ".thumb-*")
	if err != nil {
		return
	}
	tmpName := tmp.Name()
	if _, err := tmp.Write(data); err != nil {
		tmp.Close()
		_ = os.Remove(tmpName)
		return
	}
	if err := tmp.Close(); err != nil {
		_ = os.Remove(tmpName)
		return
	}
	if err := os.Rename(tmpName, dst); err != nil {
		_ = os.Remove(tmpName)
	}
}

func serveJPEG(w http.ResponseWriter, path string) {
	data, err := os.ReadFile(path)
	if err != nil {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	w.Header().Set("Content-Type", "image/jpeg")
	w.Header().Set("Cache-Control", "private, max-age=86400")
	_, _ = w.Write(data)
}
