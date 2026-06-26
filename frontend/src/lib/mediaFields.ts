// Shared media-field catalog used by both the Sort popover (FileGrid) and
// the Fields/Inspector tab (CommentsSidebar), so the two stay in lockstep.
// These mirror Frame.io's asset fields. We only have values for a subset
// (the daemon doesn't extract full ffprobe metadata yet); the rest render
// empty in the Fields tab and are non-sortable.

export type FieldIcon = "select" | "text" | "number" | "time" | "status";

export interface MediaField {
  label: string;
  icon: FieldIcon;
}

// The primary fields shown at the top of the Sort menu / Fields list.
export const PRIMARY_FIELDS: MediaField[] = [
  { label: "Custom", icon: "select" },
  { label: "Name", icon: "text" },
  { label: "Status", icon: "status" },
  { label: "Duration", icon: "time" },
  { label: "File Size", icon: "number" },
];

// Extended metadata fields (alphabetical, matching the design).
export const META_FIELDS: MediaField[] = [
  { label: "Alpha Channel", icon: "select" },
  { label: "Audio Bit Depth", icon: "number" },
  { label: "Audio Bit Rate", icon: "number" },
  { label: "Audio Channels", icon: "number" },
  { label: "Audio Codec", icon: "text" },
  { label: "Audio Sample Rate", icon: "number" },
  { label: "Bit Rate", icon: "number" },
  { label: "Color Space", icon: "text" },
  { label: "Comment Count", icon: "number" },
  { label: "Dynamic Range", icon: "text" },
  { label: "End Time", icon: "time" },
  { label: "File Type", icon: "text" },
  { label: "Format", icon: "text" },
  { label: "Frame Rate", icon: "number" },
  { label: "Model", icon: "text" },
  { label: "Page Count", icon: "number" },
  { label: "Rating", icon: "number" },
  { label: "Resolution - Height", icon: "number" },
  { label: "Resolution - Width", icon: "number" },
  { label: "Start Time", icon: "time" },
  { label: "Filename", icon: "text" },
  { label: "Video Bit Rate", icon: "number" },
  { label: "Video Codec", icon: "text" },
  { label: "Visual Bit Depth", icon: "number" },
];

export const ALL_FIELDS: MediaField[] = [...PRIMARY_FIELDS, ...META_FIELDS];
