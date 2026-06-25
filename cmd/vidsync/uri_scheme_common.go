// uri_scheme_common.go holds the cross-platform pieces of the
// vidsync:// URI handling. Per-OS registration lives in uri_scheme.go
// (Windows registry) and uri_scheme_darwin.go (no-op for now; macOS
// scheme registration is driven by Info.plist on a bundled .app).

package main

import (
	"os"
	"strings"
)

const uriScheme = "vidsync"

// argURI returns the `vidsync://...` URL passed on the command line by
// the OS, if any. Returns "" when the binary was launched normally.
//
// Windows hands the URL as os.Args[1]; we tolerate it being anywhere
// in the argv tail so future installer wrappers can prepend their own
// flags without breaking the parse. On macOS the same argv form works
// when the app is launched via `open -a Vidsync vidsync://...`.
func argURI() string {
	for _, a := range os.Args[1:] {
		if strings.HasPrefix(a, uriScheme+"://") {
			return a
		}
	}
	return ""
}
