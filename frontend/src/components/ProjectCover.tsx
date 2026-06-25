import { useFolderThumbs } from "../lib/useFolderThumbs";

// ProjectCover: visual hero for a project. Renders a 2×2 thumbnail
// collage of cached video stills; falls back to a deterministic
// gradient when nothing's cached yet (new projects, projects with no
// videos, or first load before any thumbs were captured).
//
// Used by both the Projects index card and the ProjectDetail hero —
// keeps the visual identity of a given project consistent across
// surfaces, which is the "emotional attachment" payoff mentioned in
// the design brief.

// Richer dual-tone gradients so two cards side-by-side are instantly
// distinguishable — earlier palette was nearly all dark-slate-tinted
// and read as one project repeated. Each entry goes saturated-mid →
// deep → near-black so the bottom of the cover stays dark enough for
// the status text we overlay.
const GRADIENTS = [
  "bg-gradient-to-br from-orange-600 via-orange-900 to-slate-950",
  "bg-gradient-to-br from-cyan-600 via-cyan-900 to-slate-950",
  "bg-gradient-to-br from-violet-600 via-violet-900 to-slate-950",
  "bg-gradient-to-br from-rose-600 via-rose-900 to-slate-950",
  "bg-gradient-to-br from-emerald-600 via-emerald-900 to-slate-950",
  "bg-gradient-to-br from-amber-500 via-amber-800 to-slate-950",
  "bg-gradient-to-br from-fuchsia-600 via-fuchsia-900 to-slate-950",
  "bg-gradient-to-br from-sky-600 via-indigo-900 to-slate-950",
];

export function coverGradient(id: string): string {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) | 0;
  return GRADIENTS[Math.abs(h) % GRADIENTS.length];
}

export function ProjectCover({
  folderID,
  className,
  children,
}: {
  folderID: string;
  className?: string;
  // Anything passed in children renders on top of the cover (status
  // pills, project name in the hero, "Invited" tag on cards, etc.).
  children?: React.ReactNode;
}) {
  const thumbs = useFolderThumbs(folderID, 4);
  const fallback = coverGradient(folderID);

  return (
    <div className={`relative overflow-hidden ${className ?? ""}`}>
      {thumbs.length === 0 ? (
        <div className={`absolute inset-0 ${fallback}`} aria-hidden />
      ) : (
        <CollageGrid thumbs={thumbs} />
      )}
      {/* Subtle bottom-shadow so overlaid text reads against any image. */}
      <div
        className="pointer-events-none absolute inset-0 bg-gradient-to-t from-black/60 via-transparent to-transparent"
        aria-hidden
      />
      {children}
    </div>
  );
}

function CollageGrid({ thumbs }: { thumbs: string[] }) {
  // 1 → fill, 2 → side-by-side, 3 → 1 big + 2 stacked, 4 → 2×2 grid.
  // We deliberately don't crop to keep cinematography intact; cover
  // tiles use object-cover so faces don't get cut at the seam.
  if (thumbs.length === 1) {
    return (
      <img
        src={thumbs[0]}
        className="h-full w-full object-cover"
        alt=""
        aria-hidden
      />
    );
  }
  if (thumbs.length === 2) {
    return (
      <div className="grid h-full w-full grid-cols-2 gap-px">
        {thumbs.map((u, i) => (
          <img
            key={i}
            src={u}
            className="h-full w-full object-cover"
            alt=""
            aria-hidden
          />
        ))}
      </div>
    );
  }
  if (thumbs.length === 3) {
    return (
      <div className="grid h-full w-full grid-cols-2 gap-px">
        <img
          src={thumbs[0]}
          className="row-span-2 h-full w-full object-cover"
          alt=""
          aria-hidden
        />
        <img
          src={thumbs[1]}
          className="h-full w-full object-cover"
          alt=""
          aria-hidden
        />
        <img
          src={thumbs[2]}
          className="h-full w-full object-cover"
          alt=""
          aria-hidden
        />
      </div>
    );
  }
  return (
    <div className="grid h-full w-full grid-cols-2 grid-rows-2 gap-px">
      {thumbs.slice(0, 4).map((u, i) => (
        <img
          key={i}
          src={u}
          className="h-full w-full object-cover"
          alt=""
          aria-hidden
        />
      ))}
    </div>
  );
}
