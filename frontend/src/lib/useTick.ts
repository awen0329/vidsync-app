import { useEffect, useState } from "react";

// useTick returns an integer that increments on a fixed interval,
// causing components that call it to re-render. Used to refresh
// "X minutes ago" labels without forcing a polled fetch.

export function useTick(intervalMs: number): number {
  const [n, setN] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setN((x) => x + 1), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return n;
}
