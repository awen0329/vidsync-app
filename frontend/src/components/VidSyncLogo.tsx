// VidSyncLogo: the brand mark, now sourced from
// src/assets/vidsync_icon.png (the same vidsync_icon used for the
// app icon, taskbar tray, and website favicon). Sizing is controlled
// by the parent via Tailwind h-*/w-* — the className passes straight
// through to the <img>. The PNG is square (256x256) so any equal-
// dimension class keeps the aspect ratio intact.

import vidsyncIcon from "../assets/vidsync_icon.png";

export function VidSyncLogo({ className }: { className?: string }) {
  return (
    <img
      src={vidsyncIcon}
      alt="Vidsync"
      className={className}
      draggable={false}
    />
  );
}
