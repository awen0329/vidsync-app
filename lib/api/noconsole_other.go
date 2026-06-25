// Copyright (C) 2014 The Syncthing Authors.
//
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this file,
// You can obtain one at https://mozilla.org/MPL/2.0/.

//go:build !windows

package api

import "os/exec"

// hideConsole is a no-op on non-Windows platforms.
func hideConsole(cmd *exec.Cmd) {}
