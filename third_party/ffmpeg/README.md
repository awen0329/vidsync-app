# Bundled ffmpeg

The desktop app shells out to `ffmpeg` to generate file thumbnails (video
poster frames and audio waveforms) — see `lib/api/thumb.go`. ffmpeg carries
its own decoders, so it handles formats the WebView2 `<video>` element
can't (MXF, ProRes, DNxHD, most audio) and doesn't depend on OS media
codecs — which is why `.mp4` thumbnails work even on Windows Server, where
the consumer H.264 codecs `<video>` needs aren't installed.

`lib/api/thumb.go:findFFmpeg` locates the binary at runtime, in order:

1. `VIDSYNC_FFMPEG` env var (explicit override)
2. next to the running executable (where release packaging puts it)
3. anything on `PATH` (handy in dev)

so for distribution we just drop `ffmpeg` next to `vidsync` and the app
finds it.

## Binaries are not committed

Each `ffmpeg` is ~97 MB, so the binaries are **git-ignored** (see
`.gitignore`) and staged here by hand. `build-release.ps1` copies the
matching one into the release artifact next to `vidsync.exe`.

### Windows — `windows/ffmpeg.exe`

Current: **ffmpeg 8.1.1**, "release-essentials" build from gyan.dev (the
Windows builds linked from ffmpeg.org). To refresh:

```powershell
$d = "$env:TEMP\ffmpeg-dl"
New-Item -ItemType Directory -Force $d | Out-Null
Invoke-WebRequest "https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip" -OutFile "$d\ff.zip" -UseBasicParsing
Expand-Archive "$d\ff.zip" -DestinationPath $d -Force
$src = Get-ChildItem $d -Recurse -Filter ffmpeg.exe | Select-Object -First 1
Copy-Item $src.FullName "third_party\ffmpeg\windows\ffmpeg.exe" -Force
Copy-Item (Join-Path $src.Directory.Parent.FullName "LICENSE") "third_party\ffmpeg\windows\LICENSE" -Force
```

### macOS — `darwin/ffmpeg`

Not yet staged. Download a static macOS build (e.g. from
https://evermeet.cx/ffmpeg/ or https://www.osxexperts.net/), place the
binary at `darwin/ffmpeg`, `chmod +x` it, and have the macOS packaging
step copy it into `Vidsync.app/Contents/MacOS/` next to the `vidsync`
binary (which is what `os.Executable()` resolves to inside the bundle).

## Licensing

These are **GPL** builds (the gyan "essentials" build enables GPL
components). When redistributing, include the `LICENSE` file shipped
alongside the binary and be prepared to provide corresponding source
(ffmpeg source is public at https://github.com/FFmpeg/FFmpeg). An LGPL
build can be substituted if a more permissive posture is preferred.
