import { useEffect, useState } from "react";
import { getCachedMetasForFolder, type VideoMeta } from "./thumbnails";

// useFolderMediaSummary: rolls up the cached video metadata for one
// folder into a single, scannable line: total runtime, dominant
// resolution bucket, sample size. The thumbnail indexer fills the
// metadata cache opportunistically; this hook just reads what's
// there, so the value gets better as the user visits more projects.
//
// Polls the IndexedDB store at a slow interval — covers the case
// where the indexer is still working in the background after the
// Projects page mounts. We don't subscribe to IndexedDB writes
// directly because there's no standard event for that and the
// polling cost is tiny (one cursor walk per folder per few seconds).

// Wait this long after mount before doing anything. Lets a card that
// scrolls past or a Projects page that's about to be torn down again
// skip the cursor scan entirely.
const MOUNT_DELAY_MS = 250;
const POLL_MS = 8000;

// Minimum samples before we trust the aggregate. Below this it's just
// noise; we'd rather show nothing than a wrong-looking "0.2 hrs".
const MIN_SAMPLES = 3;
// Share of clips needed in one bucket before we call it "dominant".
// Below this we report "Mixed" so we're never misrepresenting a
// project's actual format mix.
const DOMINANT_SHARE = 0.6;

export type ResolutionBucket =
  | "8K"
  | "4K"
  | "2K"
  | "1080p"
  | "720p"
  | "SD"
  | "Mixed";

export interface FolderMediaSummary {
  // Number of clips with cached metadata. Lower bound on actual count.
  indexedCount: number;
  // Sum of durations across indexed clips, in seconds.
  totalDurationSec: number;
  // Either the dominant resolution bucket, "Mixed" when no single
  // bucket clears DOMINANT_SHARE, or null when we don't have enough
  // samples to be useful.
  resolution: ResolutionBucket | null;
}

const EMPTY: FolderMediaSummary = {
  indexedCount: 0,
  totalDurationSec: 0,
  resolution: null,
};

export function useFolderMediaSummary(folderID: string): FolderMediaSummary {
  const [summary, setSummary] = useState<FolderMediaSummary>(EMPTY);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let lastCount = -1;

    const refresh = async () => {
      if (cancelled) return;
      const metas = await getCachedMetasForFolder(folderID);
      if (cancelled) return;
      const next = rollUp(metas);
      setSummary(next);
      // Keep polling only while the count is still climbing — the
      // background thumbnail indexer adds entries opportunistically.
      // Once it plateaus we stop scanning IndexedDB: the cache is
      // sticky and re-scanning the entire META store every 8 s per
      // card adds up to a lot of cursor work on the Projects page.
      if (next.indexedCount > lastCount) {
        lastCount = next.indexedCount;
        timer = setTimeout(() => void refresh(), POLL_MS);
      }
    };

    timer = setTimeout(() => void refresh(), MOUNT_DELAY_MS);
    return () => {
      cancelled = true;
      if (timer !== null) clearTimeout(timer);
    };
  }, [folderID]);

  return summary;
}

function rollUp(metas: VideoMeta[]): FolderMediaSummary {
  if (metas.length === 0) return EMPTY;
  let totalDurationSec = 0;
  const buckets: Record<string, number> = {};
  for (const m of metas) {
    if (m.durationSec > 0) totalDurationSec += m.durationSec;
    const b = resolutionBucket(m.width, m.height);
    buckets[b] = (buckets[b] ?? 0) + 1;
  }
  if (metas.length < MIN_SAMPLES) {
    return {
      indexedCount: metas.length,
      totalDurationSec,
      resolution: null,
    };
  }
  let topBucket: ResolutionBucket = "SD";
  let topCount = -1;
  for (const [b, c] of Object.entries(buckets)) {
    if (c > topCount) {
      topCount = c;
      topBucket = b as ResolutionBucket;
    }
  }
  const resolution: ResolutionBucket =
    topCount / metas.length >= DOMINANT_SHARE ? topBucket : "Mixed";
  return { indexedCount: metas.length, totalDurationSec, resolution };
}

export function resolutionBucket(
  width: number,
  height: number,
): ResolutionBucket {
  // Bucket on the long edge so portrait/landscape get the same label.
  const long = Math.max(width, height);
  if (long >= 7000) return "8K";
  if (long >= 3500) return "4K";
  if (long >= 2500) return "2K";
  if (long >= 1900) return "1080p";
  if (long >= 1200) return "720p";
  return "SD";
}

// humanHours: condensed runtime for a clip-roll-up. Picks the unit
// that gives the most informative reading without overwhelming the
// stat line:
//   <60s   → "<1m"
//   <1hr   → "47m"
//   <10hr  → "4.2 hrs"
//   else   → "47 hrs"
export function humanHours(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return "0";
  if (seconds < 60) return "<1m";
  const m = seconds / 60;
  if (m < 60) return `${Math.round(m)}m`;
  const h = m / 60;
  if (h < 10) return `${h.toFixed(1)} hrs`;
  return `${Math.round(h)} hrs`;
}
