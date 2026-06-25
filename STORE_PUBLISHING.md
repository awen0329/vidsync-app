# Publishing Vidsync to the Microsoft Store & Mac App Store

Status of store-readiness and the exact steps/placeholders to finish. App version is **0.0.1**.

## Version management

One input drives every version surface. Pass `-Version vX.Y.Z` to the build script:

- `build-release.ps1 -Version v0.0.1` (Windows) / `VERSION=v0.0.1 ./build-release-darwin.sh` (macOS)
- It injects `lib/build.Version` (the daemon string — needs the leading `v`, must match `lib/build.allowedVersionExp`) **and** rewrites `cmd/vidsync/wails.json` `productVersion` to the plain semver (`0.0.1`), which feeds the `.exe` resource, the NSIS installer, the macOS `Info.plist`, and the MSIX package version. The two can't drift.
- Default is `v0.0.1`. Bump in one place; commit the resulting `wails.json` change.

---

## Microsoft Store — the realistic first target

Full-trust MSIX preserves the whole app (sync engine, sockets, file access, tray, ffmpeg/braw child processes) — **no sandbox rewrite**.

**Prepared in-repo:** `cmd/vidsync/build/windows/msix/AppxManifest.xml` (runFullTrust, `vidsync://` protocol, user-controllable autostart, WebView2 floor Win10 1809) and `package-msix.ps1` (stages the build + helpers, generates all 6 Store logo assets from `build/appicon.png`, packs the `.msix`).

**To ship:**
1. Create a **Partner Center** developer account (one-time **$19** individual / **$99** company).
2. Reserve the app name → Partner Center gives you a **Package/Identity Name** and **Publisher ID** (`CN=…`). Put both into `AppxManifest.xml` (replace `PARTNER_CENTER_RESERVED_NAME` and `CN=PARTNER_CENTER_PUBLISHER_ID`), and `PublisherDisplayName`.
3. Install the **Windows 10/11 SDK** (provides `makeappx.exe`; this machine doesn't have it yet).
4. `./build-release.ps1 -Version v0.0.1` then `cmd\vidsync\build\windows\msix\package-msix.ps1` → `dist\Vidsync-0.0.1.0.msix`.
5. (Optional) `package-msix.ps1 -SelfSign` to install locally and smoke-test. **Don't ship the self-signed package** — the Store re-signs.
6. Upload the `.msix` in Partner Center; fill listing (description, screenshots, age rating, privacy-policy URL → already live on the site).

**Notes / watch-outs:**
- **WebView2**: present by default on Win11; on Win10 the Evergreen runtime must be installed. The NSIS installer bootstraps it; for MSIX, document it or add the runtime as a dependency.
- **GPL ffmpeg**: tolerated by the MS Store, but comply with the GPL (ship the license / offer source). Cleaner long-term to switch to an LGPL build.
- Verify the app never writes *next to its exe* (MSIX install dir is read-only). Data already lives in the per-user dir (`datadir_windows.go`), so this should be fine — confirm in a sideload test.

---

## macOS

### Recommended: Developer ID + notarization (direct .dmg, NOT the App Store)

This is how Syncthing/Resilio-class apps ship on Mac, because they can't sandbox. A notarized, Gatekeeper-clean `.dmg` you host yourself.

**Prepared in-repo:** `build-release-darwin.sh` (build → stage helpers → inside-out codesign w/ Hardened Runtime → `.dmg` → notarize → staple), `cmd/vidsync/build/darwin/entitlements.devid.plist`, a real bundle ID (`com.thevidsync.desktop`), and tightened ATS (arbitrary loads off; loopback only — now that the backend is HTTPS).

**To ship (on a Mac with Xcode CLT):**
1. **Apple Developer Program** membership (**$99/yr**).
2. Create a **Developer ID Application** certificate; note your **Team ID**.
3. Store a notary profile once: `xcrun notarytool store-credentials vidsync --apple-id … --team-id … --password <app-specific-pw>`.
4. Stage mac helper binaries (see "Remaining" below).
5. `VERSION=v0.0.1 SIGN_IDENTITY="Developer ID Application: … (TEAMID)" NOTARY_PROFILE=vidsync ./build-release-darwin.sh` → `dist/Vidsync-v0.0.1.dmg`.

### Mac App Store — harder, later (if at all)

**Prepared:** `cmd/vidsync/build/darwin/entitlements.mas.plist` (sandbox capability set). But MAS additionally requires, and these are real blockers:
- **GPL ffmpeg is disallowed on MAS** (incompatible with App Store terms — the VLC precedent). Need an **LGPL ffmpeg** build or AVFoundation.
- **Sandbox** forbids the "watch arbitrary paths" model — folder access must move to user-selected folders + security-scoped bookmarks (code change).
- Sign `ffmpeg`/`braw-thumb` as bundled, sandbox-inheriting helpers; autostart via `SMAppService` (not launchd).
- Build on macOS, "Apple Distribution" cert + provisioning profile, upload via Transporter.

Recommendation: ship Developer ID direct first; revisit MAS only if the sandbox + LGPL work is worth it.

---

## Remaining TODOs (not doable on this Windows box)

- [ ] Stage **macOS** helper binaries: `third_party/ffmpeg/darwin/ffmpeg` and `third_party/braw/mac/` (only Windows builds exist today). The darwin script warns and degrades if absent.
- [ ] Install the **Windows SDK** (for `makeappx`/`signtool`) to actually pack the MSIX.
- [ ] Fill the two MSIX identity placeholders + the Apple Team ID / signing identity from your store accounts.
- [ ] For MAS only: LGPL ffmpeg + sandbox folder-access rework.
- [ ] Store listing assets (screenshots, descriptions, age ratings) for both stores. Privacy policy + terms are already live on the website.
