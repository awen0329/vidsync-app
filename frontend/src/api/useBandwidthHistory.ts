import { useEffect, useRef, useState } from "react";
import { useConnectionRates } from "./useConnectionRates";

// useBandwidthHistory: keeps a rolling-window ring buffer of total
// throughput samples for the transfers chart. We don't need ms-precise
// timestamps — useConnectionRates already polls /rest/system/connections
// at the default refetch interval (a few seconds), and each new value
// is pushed onto the buffer.
//
// The sample count is exposed via `cap`; the chart needs to know it to
// space x-axis ticks even when the buffer hasn't filled yet.

export interface BandwidthSample {
  inBps: number;
  outBps: number;
}

const CAP = 60;

export function useBandwidthHistory(): {
  samples: BandwidthSample[];
  cap: number;
} {
  const { total } = useConnectionRates();
  const [samples, setSamples] = useState<BandwidthSample[]>([]);
  // Track the last (in, out) we recorded so we don't duplicate the same
  // sample on every re-render of the consumer. useConnectionRates
  // returns a *derived* value that's stable across re-renders until the
  // underlying /connections poll fires.
  const lastRef = useRef<{ inBps: number; outBps: number } | null>(null);

  useEffect(() => {
    const last = lastRef.current;
    if (
      last &&
      last.inBps === total.inBytesPerSec &&
      last.outBps === total.outBytesPerSec
    ) {
      return;
    }
    lastRef.current = {
      inBps: total.inBytesPerSec,
      outBps: total.outBytesPerSec,
    };
    setSamples((prev) => {
      const next = prev.concat({
        inBps: total.inBytesPerSec,
        outBps: total.outBytesPerSec,
      });
      return next.length > CAP ? next.slice(next.length - CAP) : next;
    });
  }, [total.inBytesPerSec, total.outBytesPerSec]);

  return { samples, cap: CAP };
}
