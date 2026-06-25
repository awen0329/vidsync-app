// Copyright (C) 2014 The Syncthing Authors.
//
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this file,
// You can obtain one at https://mozilla.org/MPL/2.0/.

package api

import (
	"os"
	"path/filepath"
	"sort"
	"sync"
	"time"
)

// On-disk caches for generated thumbnails and preview clips grow as the user
// browses more media. Without a bound they'd accumulate forever, so we cap
// each directory's total size and evict the oldest files (by modtime) when it
// is exceeded. Cache files are cheap to regenerate on demand, so eviction is
// safe and runs in the background off the request path.

const (
	thumbCacheMaxBytes   = 256 << 20 // 256 MiB of JPEG thumbnails
	previewCacheMaxBytes = 8 << 30   // 8 GiB of full-length H.264 proxies
	cachePruneInterval   = 10 * time.Minute
	cachePruneLowWater   = 90 // prune down to this % of the cap to avoid churn
)

var (
	cachePruneMu   sync.Mutex
	cachePruneLast = map[string]time.Time{}
)

// maybePrune kicks off a throttled, background prune of a cache directory. It
// returns immediately and runs at most one prune per directory per
// cachePruneInterval, so calling it after every cache write is cheap.
func maybePrune(dir, ext string, maxBytes int64) {
	cachePruneMu.Lock()
	if last, ok := cachePruneLast[dir]; ok && time.Since(last) < cachePruneInterval {
		cachePruneMu.Unlock()
		return
	}
	cachePruneLast[dir] = time.Now()
	cachePruneMu.Unlock()

	go pruneCacheDir(dir, ext, maxBytes)
}

// pruneCacheDir deletes the oldest files with the given extension until the
// directory's total size for that extension is under maxBytes*lowWater%. Only
// finished files (matching ext) are considered, so in-flight temp files being
// written by a concurrent generation are never touched.
func pruneCacheDir(dir, ext string, maxBytes int64) {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return
	}
	type item struct {
		path string
		size int64
		mod  time.Time
	}
	var items []item
	var total int64
	for _, e := range entries {
		if e.IsDir() || filepath.Ext(e.Name()) != ext {
			continue
		}
		info, err := e.Info()
		if err != nil {
			continue
		}
		items = append(items, item{filepath.Join(dir, e.Name()), info.Size(), info.ModTime()})
		total += info.Size()
	}
	if total <= maxBytes {
		return
	}

	target := maxBytes * cachePruneLowWater / 100
	sort.Slice(items, func(i, j int) bool { return items[i].mod.Before(items[j].mod) })
	for _, it := range items {
		if total <= target {
			break
		}
		if err := os.Remove(it.path); err == nil {
			total -= it.size
		}
	}
}

// sweepExpired drops timed-out entries from an in-memory fail map once it grows
// past a bound, so a flood of undecodable files can't make it grow without
// limit. Callers hold the map's mutex.
func sweepExpired(m map[string]time.Time, ttl time.Duration) {
	if len(m) < failMapMax {
		return
	}
	for k, t := range m {
		if time.Since(t) > ttl {
			delete(m, k)
		}
	}
}

const failMapMax = 4096
