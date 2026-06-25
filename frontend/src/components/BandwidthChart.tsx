import { useBandwidthHistory } from "../api/useBandwidthHistory";
import { humanRate } from "../lib/format";

// BandwidthChart: small inline SVG showing the last ~60s of total
// throughput. Two stacked area plots — purple for upload, emerald for
// download — match the global up=purple / down=green convention used
// in transfer rows and the Transfers KPI cards.
//
// We intentionally render the chart even when both series are flat at
// zero so users see a calm baseline rather than a "no data" empty
// state; sync is mostly idle most of the time and a chart that
// vanishes whenever nothing is happening would be more confusing than
// reassuring.

const HEIGHT = 96;
// Comfortable inner viewBox — keeps stroke widths consistent regardless
// of the parent container size since the SVG scales via preserveAspectRatio.
const VBW = 300;
const VBH = 96;

export function BandwidthChart() {
  const { samples, cap } = useBandwidthHistory();
  // Headroom on the max so the peak doesn't kiss the top edge.
  let maxBps = 1;
  for (const s of samples) {
    if (s.inBps > maxBps) maxBps = s.inBps;
    if (s.outBps > maxBps) maxBps = s.outBps;
  }
  maxBps = maxBps * 1.15;

  const upPath = areaPath(samples.map((s) => s.outBps), maxBps, cap);
  const downPath = areaPath(samples.map((s) => s.inBps), maxBps, cap);
  const upLine = linePath(samples.map((s) => s.outBps), maxBps, cap);
  const downLine = linePath(samples.map((s) => s.inBps), maxBps, cap);

  return (
    <div className="rounded-xl border border-line bg-panel p-4">
      <div className="mb-2 flex items-center justify-between text-[11px] font-medium uppercase tracking-wide text-fg-soft">
        <span>Bandwidth · last 60s</span>
        <div className="flex items-center gap-4 normal-case tracking-normal">
          <LegendDot color="bg-violet-400" label="Upload" />
          <LegendDot color="bg-emerald-400" label="Download" />
        </div>
      </div>
      <svg
        viewBox={`0 0 ${VBW} ${VBH}`}
        preserveAspectRatio="none"
        className="block w-full"
        style={{ height: HEIGHT }}
        aria-label="Recent bandwidth, last 60 seconds"
      >
        {/* Subtle horizontal grid — keeps the chart legible at rest. */}
        {[0.25, 0.5, 0.75].map((t) => (
          <line
            key={t}
            x1={0}
            x2={VBW}
            y1={VBH * t}
            y2={VBH * t}
            stroke="currentColor"
            strokeOpacity={0.08}
            strokeDasharray="3 4"
          />
        ))}
        {upPath && (
          <path
            d={upPath}
            fill="rgb(167 139 250 / 0.18)"
            stroke="none"
          />
        )}
        {downPath && (
          <path
            d={downPath}
            fill="rgb(52 211 153 / 0.18)"
            stroke="none"
          />
        )}
        {upLine && (
          <path
            d={upLine}
            fill="none"
            stroke="rgb(167 139 250)"
            strokeWidth={1.6}
            strokeLinejoin="round"
            strokeLinecap="round"
          />
        )}
        {downLine && (
          <path
            d={downLine}
            fill="none"
            stroke="rgb(52 211 153)"
            strokeWidth={1.6}
            strokeLinejoin="round"
            strokeLinecap="round"
          />
        )}
      </svg>
      <div className="mt-1 flex items-center justify-between text-[10px] text-fg-faint">
        <span>now</span>
        <span>{humanRate(maxBps / 1.15)} peak</span>
        <span>60s ago</span>
      </div>
    </div>
  );
}

function LegendDot({ color, label }: { color: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-fg-soft">
      <span className={`h-1.5 w-1.5 rounded-full ${color}`} aria-hidden />
      {label}
    </span>
  );
}

// linePath / areaPath project samples into viewBox coords. The buffer
// is rendered right-aligned (newest sample at x=VBW) so the curve
// always shows the most-recent data point at the right edge even
// before the buffer fills.
function linePath(values: number[], max: number, cap: number): string | null {
  if (values.length === 0 || max <= 0) return null;
  const stepX = VBW / Math.max(1, cap - 1);
  const startIdx = cap - values.length;
  let d = "";
  for (let i = 0; i < values.length; i++) {
    const x = (startIdx + i) * stepX;
    const y = VBH - (values[i] / max) * VBH;
    d += i === 0 ? `M${x.toFixed(1)},${y.toFixed(1)}` : ` L${x.toFixed(1)},${y.toFixed(1)}`;
  }
  return d;
}

function areaPath(values: number[], max: number, cap: number): string | null {
  if (values.length === 0 || max <= 0) return null;
  const stepX = VBW / Math.max(1, cap - 1);
  const startIdx = cap - values.length;
  const firstX = startIdx * stepX;
  const lastX = (startIdx + values.length - 1) * stepX;
  let d = `M${firstX.toFixed(1)},${VBH}`;
  for (let i = 0; i < values.length; i++) {
    const x = (startIdx + i) * stepX;
    const y = VBH - (values[i] / max) * VBH;
    d += ` L${x.toFixed(1)},${y.toFixed(1)}`;
  }
  d += ` L${lastX.toFixed(1)},${VBH} Z`;
  return d;
}
