import type { Config } from "tailwindcss";

// Semantic color tokens. These are *the* way components describe
// surfaces, text, borders, and accent — concrete shades from Tailwind's
// built-in palette (slate-*, teal-*) should only be reached for when
// you need an off-token utility shade (status pills, gradients).
//
// Each token resolves to an rgb() function reading the CSS variables
// defined in index.css, which lets us swap dark / light without
// touching markup. The <alpha-value> placeholder is what enables
// `bg-base/80`, `text-fg-soft/60`, etc.
const semanticColor = (varName: string) =>
  `rgb(var(${varName}) / <alpha-value>)`;

export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      fontFamily: {
        // App font (also set on <body> in index.css); `font-mono` uses
        // IBM Plex Mono for timecodes / paths to match the condensed sans.
        sans: [
          "IBM Plex Sans Condensed",
          "Segoe UI Variable",
          "Segoe UI",
          "system-ui",
          "sans-serif",
        ],
        mono: ["IBM Plex Mono", "ui-monospace", "SFMono-Regular", "monospace"],
      },
      colors: {
        // Surfaces ordered from outermost to most elevated. `rail` sits
        // *below* base — the slim navigation rail reads as window chrome.
        rail: semanticColor("--rail"),
        base: semanticColor("--base"),
        panel: semanticColor("--panel"),
        elevated: semanticColor("--elevated"),
        hover: semanticColor("--hover"),

        // Foreground text scale. `fg` is the default body color;
        // `fg-strong` for headings, `fg-soft` and `fg-faint` for
        // de-emphasized labels and captions.
        fg: {
          DEFAULT: semanticColor("--fg-default"),
          strong: semanticColor("--fg-strong"),
          soft: semanticColor("--fg-soft"),
          faint: semanticColor("--fg-faint"),
        },

        // Borders. `line` for default dividers, `line-strong` for
        // emphasis (active tab underline, focused input ring backdrop).
        line: {
          DEFAULT: semanticColor("--line"),
          strong: semanticColor("--line-strong"),
        },

        // Single-hue accent (teal) wired through the variables so a
        // future theme picker can swap palettes without code changes.
        // `accent` is the active color, `accent-hover` for hovered
        // states, `accent-fg` is the text color used *on top of*
        // accent backgrounds.
        accent: {
          DEFAULT: semanticColor("--accent"),
          hover: semanticColor("--accent-hover"),
          soft: semanticColor("--accent-soft"),
          fg: semanticColor("--accent-fg"),
        },
      },
    },
  },
  plugins: [],
} satisfies Config;
