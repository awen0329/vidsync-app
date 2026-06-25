// Copyright (C) 2014 The Syncthing Authors.
//
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this file,
// You can obtain one at https://mozilla.org/MPL/2.0/.

package api

import (
	"os/exec"
	"syscall"
)

// createNoWindow is the CREATE_NO_WINDOW process creation flag. Without it, a
// GUI process that launches a console executable (ffmpeg, braw-thumb) causes
// Windows to allocate a console window for the child, which flashes on screen.
const createNoWindow = 0x08000000

// hideConsole prevents a child console process from popping a console window.
func hideConsole(cmd *exec.Cmd) {
	if cmd.SysProcAttr == nil {
		cmd.SysProcAttr = &syscall.SysProcAttr{}
	}
	cmd.SysProcAttr.HideWindow = true
	cmd.SysProcAttr.CreationFlags |= createNoWindow
}
