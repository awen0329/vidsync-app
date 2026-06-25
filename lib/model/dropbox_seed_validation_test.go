// Copyright (C) 2026 The Syncthing Authors.
//
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this file,
// You can obtain one at https://mozilla.org/MPL/2.0/.
//
// Validation harness for the Dropbox-backup feature (risk #3): proves that a
// file independently seeded into a local folder with content byte-identical to
// a peer's copy reconciles WITHOUT re-downloading and WITHOUT creating a
// .sync-conflict file, even though it was created with an independent version
// vector. This is the load-bearing assumption behind seeding teammates from the
// owner's Dropbox while the owner is offline.

package model

import (
	"context"
	"io"
	"testing"

	"github.com/CrownLedger/vidsync/lib/config"
	"github.com/CrownLedger/vidsync/lib/fs"
	"github.com/CrownLedger/vidsync/internal/itererr"
	"github.com/CrownLedger/vidsync/lib/protocol"
)

func mustReadFile(t *testing.T, ffs fs.Filesystem, name string) []byte {
	t.Helper()
	fd, err := ffs.Open(name)
	must(t, err)
	defer fd.Close()
	data, err := io.ReadAll(fd)
	must(t, err)
	return data
}

// setupSRFolderRunning mirrors setupROFolder but for a send-receive folder,
// which is the folder type a teammate uses.
func setupSRFolderRunning(t *testing.T) (*testModel, *sendReceiveFolder, context.CancelFunc) {
	t.Helper()

	w, cancel := newConfigWrapper(defaultCfg)
	cfg := w.RawCopy()
	fcfg := newFolderConfig()
	fcfg.ID = "sr"
	fcfg.Label = "sr"
	fcfg.Type = config.FolderTypeSendReceive
	cfg.Folders = []config.FolderConfiguration{fcfg}
	replace(t, w, cfg)

	m := newModel(t, w, myID, nil)
	m.ServeBackground()
	<-m.started
	must(t, m.ScanFolder("sr"))

	m.mut.RLock()
	defer m.mut.RUnlock()
	r, _ := m.folderRunners.Get("sr")
	f := r.(*sendReceiveFolder)

	return m, f, cancel
}

func TestSRDropboxSeededIdenticalContentNoConflict(t *testing.T) {
	m, f, cancel := setupSRFolderRunning(t)
	defer cancel()
	ffs := f.Filesystem()
	defer cleanupModel(m)

	// The owner peer (device1) shares this folder.
	conn := addFakeConn(m, device1, f.ID)

	must(t, ffs.MkdirAll(".stfolder", 0o755))

	// The teammate independently writes a "material" into the folder, exactly as
	// if it had just been downloaded from the owner's Dropbox. Then it is scanned
	// and indexed locally under the teammate's (myID) version vector.
	const name = "clip.mov"
	seeded := []byte("pretend these are identical video bytes seeded from dropbox\n")
	writeFilePerm(t, ffs, name, seeded, 0o644)
	must(t, m.ScanFolder("sr"))

	// Grab the locally-scanned FileInfo (real Blocks + BlocksHash) and build the
	// owner's copy from it: byte-identical content, but an INDEPENDENT version
	// vector (as if the owner created/edited it on their own device). This is the
	// concurrent, different-origin case that naively looks like a conflict.
	var remote []protocol.FileInfo
	for fi, err := range itererr.Zip(f.db.AllLocalFiles("sr", protocol.LocalDeviceID)) {
		must(t, err)
		if fi.Name != name {
			continue
		}
		fi.Version = protocol.Vector{}.Update(device1.Short())
		fi.ModifiedBy = device1.Short()
		remote = append(remote, fi)
	}
	if len(remote) != 1 {
		t.Fatalf("expected to capture 1 local file, got %d", len(remote))
	}
	must(t, m.IndexUpdate(conn, &protocol.IndexUpdate{Folder: "sr", Files: remote}))

	// Snapshot on-disk bytes before the pull, to prove no re-download/rewrite.
	before := mustReadFile(t, ffs, name)

	// Drive a real pull cycle.
	must(t, f.doInSync(func(ctx context.Context) error {
		_, err := f.pull(ctx)
		return err
	}))

	// 1. No conflict copy was created.
	if confls := existingConflicts(name, ffs); len(confls) != 0 {
		t.Fatalf("expected NO conflict files, got %v", confls)
	}

	// 2. The file content is byte-for-byte unchanged (it was reconciled by
	//    metadata only — never pulled across the wire).
	after := mustReadFile(t, ffs, name)
	if string(before) != string(after) {
		t.Fatalf("file content changed during reconciliation: %q -> %q", before, after)
	}

	// 3. The folder converged: nothing is left "needed".
	if size := mustV(m.NeedSize("sr", protocol.LocalDeviceID)); size.Files != 0 {
		t.Fatalf("expected nothing needed after reconcile, got %+v", size)
	}

	// 4. The local DB now records a version that includes the owner's edit, i.e.
	//    the version vectors merged rather than forking into a conflict.
	cur, ok, err := m.sdb.GetDeviceFile("sr", protocol.LocalDeviceID, name)
	must(t, err)
	if !ok {
		t.Fatal("local file vanished after reconcile")
	}
	if !cur.Version.GreaterEqual(protocol.Vector{}.Update(device1.Short())) {
		t.Fatalf("local version did not absorb owner's version: %+v", cur.Version)
	}
}
