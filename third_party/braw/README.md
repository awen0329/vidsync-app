# Bundled Blackmagic RAW thumbnailer (braw-thumb)

ffmpeg has no decoder for Blackmagic RAW (`.braw`), so the app shells out to
a small helper, **`braw-thumb`**, built against the Blackmagic RAW SDK. It
decodes the first frame at 1/8 resolution and writes a PPM; the daemon then
scales/encodes it to a JPEG with ffmpeg (see `lib/api/thumb.go`). The helper
loads the SDK runtime libraries from next to itself (Windows: DLLs; macOS:
`BlackmagicRawAPI.framework`), so we ship it together with those runtimes
in a `braw/` subdir beside the app's main executable.

`lib/api/thumb.go:findBrawThumb` locates it at runtime: `VIDSYNC_BRAW_THUMB`
env override, a `braw/` subdir next to the app (where it's bundled), next to
the app directly, then `PATH`. If it's missing, `.braw` files fall back to
the extension glyph — nothing else is affected.

## Binaries are not committed

The helper executables and the SDK runtimes (~15 MB Windows, ~12 MB macOS)
are **git-ignored** (see `.gitignore`) and staged by hand under `win/` and
`darwin/`. Packaging copies them into the release artifact's `braw/` subdir.

## Building / refreshing `win/`

You need two things, both just unzipped (not installed):

1. **Blackmagic RAW SDK** — from the Blackmagic RAW Windows installer
   (`Install Blackmagic RAW x.x.msi`). You can extract it without installing:
   `msiexec /a "Install Blackmagic RAW 5.1.msi" /qn TARGETDIR=<dir>`, then the
   SDK is at `<dir>\Blackmagic Design\Blackmagic RAW\Blackmagic RAW SDK\Win`
   (has `Include\` + `Libraries\`). The MSVC runtime DLLs it needs are under
   `<dir>\System64`.
2. **w64devkit** — the prebuilt release zip from
   https://github.com/skeeto/w64devkit/releases (provides `g++` and `widl`).

Then run, from the repo root:

```powershell
.\tools\braw-thumb\build.ps1 `
  -BlackmagicRawSDK "<dir>\Blackmagic Design\Blackmagic RAW\Blackmagic RAW SDK\Win" `
  -W64Devkit        "C:\path\to\w64devkit" `
  -SystemDlls       "<dir>\System64"
```

That generates the Windows header from the SDK's `.idl` via `widl`, compiles
`tools/braw-thumb/braw-thumb.cpp` with `g++`, and stages the exe + DLLs into
`third_party/braw/win/`.

Current: Blackmagic RAW SDK **5.1** (Windows), built with w64devkit g++ 16.

## Building / refreshing `darwin/` (macOS)

The Mac SDK ships ready-made headers (no widl needed) and the same
`tools/braw-thumb/braw-thumb.cpp` builds for darwin via `#ifdef`s (CFString
in place of BSTR, no COM init, etc.).

You need the **Blackmagic RAW SDK for macOS**. The installer is
`Install Blackmagic RAW x.x.pkg` inside the `Blackmagic_RAW_Macintosh_*.zip`
download from blackmagicdesign.com. You can extract the SDK files without
installing system-wide:

```bash
unzip Blackmagic_RAW_Macintosh_5.1.zip -d /tmp/braw
hdiutil attach /tmp/braw/Blackmagic_RAW_5.1.dmg -nobrowse -readonly
pkgutil --expand-full "/Volumes/Blackmagic RAW/Install Blackmagic RAW 5.1.pkg" /tmp/braw-pkg
hdiutil detach "/Volumes/Blackmagic RAW"
```

The SDK ends up at:

```
/tmp/braw-pkg/BlackmagicRawSDK.pkg/Payload/Applications/Blackmagic RAW/Blackmagic RAW SDK/Mac
```

Copy its `Include/*` and `Libraries/BlackmagicRawAPI.framework` into the
repo:

```bash
SDK_MAC="/tmp/braw-pkg/.../Mac"   # path above
mkdir -p third_party/braw/darwin/Include third_party/braw/darwin/Libraries
cp "$SDK_MAC/Include/BlackmagicRawAPI.h" \
   "$SDK_MAC/Include/BlackmagicRawAPIDispatch.cpp" \
   third_party/braw/darwin/Include/
cp -a "$SDK_MAC/Libraries/BlackmagicRawAPI.framework" \
   third_party/braw/darwin/Libraries/
```

Then build (Xcode Command Line Tools required):

```bash
./tools/braw-thumb/build_darwin.sh           # arm64 by default
ARCH=x86_64 ./tools/braw-thumb/build_darwin.sh
```

Drop the helper + framework into the `.app`:

```bash
APP=cmd/vidsync/build/bin/vidsync.app
mkdir -p "$APP/Contents/MacOS/braw"
cp third_party/braw/darwin/braw-thumb "$APP/Contents/MacOS/braw/"
cp -a third_party/braw/darwin/Libraries/BlackmagicRawAPI.framework \
      "$APP/Contents/MacOS/braw/"
codesign --force --deep --sign - "$APP"
```

Current: Blackmagic RAW SDK **5.1** (macOS), built with the system clang++,
arm64, deployment target macOS 11.0.

## Licensing

The Blackmagic RAW SDK is redistributable under Blackmagic's SDK license
(the sample/headers carry a permissive MIT-style grant). The runtime libs
(Windows: `BlackmagicRawAPI.dll` + decoders; macOS:
`BlackmagicRawAPI.framework`) are shipped as-is alongside the app.
