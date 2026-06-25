// uri_scheme_darwin.go: macOS stub for vidsync:// scheme registration.
//
// On macOS the URI scheme is declared in the .app bundle's Info.plist
// (CFBundleURLTypes / CFBundleURLSchemes); LaunchServices reads it
// when the bundle is registered. There is no per-launch equivalent
// of the Windows HKCU write, so this is a no-op. The argv-based
// pickup in uri_scheme_common.go (argURI) still works when a user
// opens the app with `open -a Vidsync vidsync://...`.

//go:build darwin

package main

func registerURIScheme() {}
