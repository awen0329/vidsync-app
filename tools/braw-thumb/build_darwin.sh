#!/usr/bin/env bash
# build_darwin.sh - build braw-thumb (the Blackmagic RAW thumbnail helper)
# for macOS, and stage it with BlackmagicRawAPI.framework under
# third_party/braw/darwin/.
#
# The desktop app shells out to braw-thumb to decode the first frame of a
# .braw clip (ffmpeg can't - it has no Blackmagic RAW decoder). See
# lib/api/thumb.go. The helper loads BlackmagicRawAPI.framework from next
# to itself via the SDK's dispatch.cpp (CFBundleCreate at runtime), so we
# ship the binary + framework together in a braw/ subdir beside the app's
# main executable.
#
# Prerequisites:
#   - Xcode Command Line Tools (clang++)
#   - Blackmagic RAW SDK for macOS already staged under
#     third_party/braw/darwin/ (Include/ + Libraries/BlackmagicRawAPI.framework)
#
# Usage:
#   ./tools/braw-thumb/build_darwin.sh
#
# Output:
#   third_party/braw/darwin/braw-thumb
# (plus third_party/braw/darwin/Libraries/BlackmagicRawAPI.framework is left
#  in place to be copied alongside it by the packaging step)

set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$(cd "$here/../.." && pwd)"

sdk_dir="$repo/third_party/braw/darwin"
inc_dir="$sdk_dir/Include"
fw_dir="$sdk_dir/Libraries/BlackmagicRawAPI.framework"
out="$sdk_dir/braw-thumb"

if [[ ! -f "$inc_dir/BlackmagicRawAPI.h" ]]; then
  echo "missing Blackmagic RAW SDK headers at $inc_dir" >&2
  echo "stage the SDK under $sdk_dir first (see third_party/braw/README.md)" >&2
  exit 1
fi
if [[ ! -d "$fw_dir" ]]; then
  echo "missing BlackmagicRawAPI.framework at $fw_dir" >&2
  exit 1
fi

# arm64 by default; export ARCH=x86_64 to build for Intel.
arch="${ARCH:-arm64}"

clang++ \
  -std=c++17 -O2 \
  -arch "$arch" \
  -mmacosx-version-min=11.0 \
  -I "$inc_dir" \
  "$here/braw-thumb.cpp" \
  "$inc_dir/BlackmagicRawAPIDispatch.cpp" \
  -framework CoreFoundation -framework CoreServices \
  -o "$out"

chmod +x "$out"
echo "built: $out"
file "$out"
