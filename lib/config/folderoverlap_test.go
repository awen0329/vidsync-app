// Copyright (C) 2014 The Syncthing Authors.
//
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this file,
// You can obtain one at https://mozilla.org/MPL/2.0/.

package config

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/CrownLedger/vidsync/lib/build"
)

func TestCheckFolderPathOverlap(t *testing.T) {
	base := t.TempDir()
	proj := filepath.Join(base, "ProjectA")

	cfg := &Configuration{
		Folders: []FolderConfiguration{
			{ID: "existing", Label: "Project A", Path: proj},
		},
	}

	cases := []struct {
		name      string
		candidate FolderConfiguration
		overlap   bool
	}{
		{"same id is allowed (edit in place)", FolderConfiguration{ID: "existing", Path: proj}, false},
		{"identical path, new id", FolderConfiguration{ID: "new", Path: proj}, true},
		{"trailing separator still overlaps", FolderConfiguration{ID: "new", Path: proj + string(filepath.Separator)}, true},
		{"subfolder of existing", FolderConfiguration{ID: "new", Path: filepath.Join(proj, "sub")}, true},
		{"parent of existing", FolderConfiguration{ID: "new", Path: base}, true},
		{"sibling is fine", FolderConfiguration{ID: "new", Path: filepath.Join(base, "ProjectB")}, false},
		{"prefix-but-not-nested is fine", FolderConfiguration{ID: "new", Path: proj + "X"}, false},
		{"empty path is skipped", FolderConfiguration{ID: "new", Path: ""}, false},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			err := cfg.CheckFolderPathOverlap(tc.candidate)
			if tc.overlap && err == nil {
				t.Fatalf("expected overlap error, got nil")
			}
			if !tc.overlap && err != nil {
				t.Fatalf("expected no overlap, got: %v", err)
			}
		})
	}

	// On case-insensitive platforms a path differing only in case must
	// still be detected as overlapping.
	if build.IsWindows || build.IsDarwin {
		err := cfg.CheckFolderPathOverlap(FolderConfiguration{ID: "new", Path: strings.ToUpper(proj)})
		if err == nil {
			t.Fatalf("expected case-insensitive overlap to be detected")
		}
	}

	// A symlinked alias of an existing folder's path must be detected as
	// overlapping (the same mechanism that catches the macOS boot-volume
	// firmlink, e.g. /Volumes/Macintosh_HD/Users/x == /Users/x).
	t.Run("symlinked alias overlaps", func(t *testing.T) {
		real := filepath.Join(base, "real")
		if err := os.MkdirAll(real, 0o755); err != nil {
			t.Fatal(err)
		}
		link := filepath.Join(base, "alias")
		if err := os.Symlink(real, link); err != nil {
			t.Skipf("symlinks unavailable in this environment: %v", err)
		}
		c := &Configuration{Folders: []FolderConfiguration{{ID: "real", Label: "Real", Path: real}}}
		if err := c.CheckFolderPathOverlap(FolderConfiguration{ID: "viaLink", Path: link}); err == nil {
			t.Fatalf("expected symlinked alias to overlap the real path")
		}
	})
}
