import { useEffect, useRef, useState } from "react";
import { useConnections } from "./hooks";
import type { PeerRate } from "./types";

// useConnectionRates derives per-device transfer rates by diffing the
// monotonically-increasing inBytesTotal/outBytesTotal counters between
// consecutive /rest/system/connections snapshots. Total rate (across
// all peers) is exposed under the empty string key.

interface Sample {
  t: number;
  inB: number;
  outB: number;
}

const TOTAL_KEY = "";

export function useConnectionRates(): {
  rates: Record<string, PeerRate>;
  total: PeerRate;
} {
  const conns = useConnections();
  const lastRef = useRef<Record<string, Sample>>({});
  const [rates, setRates] = useState<Record<string, PeerRate>>({});

  useEffect(() => {
    if (!conns.data) return;
    const now = Date.now();
    const next: Record<string, PeerRate> = {};

    const entries: [string, { inBytesTotal: number; outBytesTotal: number }][] =
      [
        ...Object.entries(conns.data.connections),
        [TOTAL_KEY, conns.data.total],
      ];

    const seen = new Set<string>();
    for (const [id, info] of entries) {
      seen.add(id);
      const prev = lastRef.current[id];
      const sample: Sample = {
        t: now,
        inB: info.inBytesTotal,
        outB: info.outBytesTotal,
      };
      if (prev) {
        const dt = (now - prev.t) / 1000;
        if (dt > 0) {
          // Counters reset across daemon restarts; clamp negative deltas.
          const dIn = Math.max(0, sample.inB - prev.inB);
          const dOut = Math.max(0, sample.outB - prev.outB);
          next[id] = { inBytesPerSec: dIn / dt, outBytesPerSec: dOut / dt };
        }
      }
      lastRef.current[id] = sample;
    }
    // Drop disconnected peers from the cache so they restart fresh.
    for (const k of Object.keys(lastRef.current)) {
      if (!seen.has(k)) delete lastRef.current[k];
    }
    setRates(next);
  }, [conns.data]);

  return {
    rates,
    total: rates[TOTAL_KEY] ?? { inBytesPerSec: 0, outBytesPerSec: 0 },
  };
}
