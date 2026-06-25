import { useEffect, useState } from "react";

// Theme manager. Reads the user's preference from localStorage, falls
// back to dark (Iconik-style), applies it via the `data-theme`
// attribute on the html element, and exposes a hook for setting it
// from anywhere (e.g. an Appearance tab in Settings).
//
// We keep the value list closed so adding new options is a deliberate
// change — saves us from random strings ending up in localStorage if
// an older client wrote them.

export type ThemeMode = "dark" | "light";

const STORAGE_KEY = "vidsync.theme";
const DEFAULT_MODE: ThemeMode = "dark";

export function getStoredTheme(): ThemeMode {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw === "dark" || raw === "light") return raw;
  } catch {
    /* private mode / quota — fall through */
  }
  return DEFAULT_MODE;
}

export function applyTheme(mode: ThemeMode): void {
  if (typeof document === "undefined") return;
  document.documentElement.setAttribute("data-theme", mode);
}

export function setStoredTheme(mode: ThemeMode): void {
  try {
    localStorage.setItem(STORAGE_KEY, mode);
  } catch {
    /* best effort */
  }
  applyTheme(mode);
}

// Sync hook for components that want to read or update the theme.
// Listens to the `storage` event so other tabs / windows pick up
// changes without a full reload — desktop wrappers often run multiple
// webviews so this matters.
export function useTheme(): [ThemeMode, (next: ThemeMode) => void] {
  const [mode, setMode] = useState<ThemeMode>(() => getStoredTheme());

  useEffect(() => {
    applyTheme(mode);
  }, [mode]);

  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key !== STORAGE_KEY) return;
      if (e.newValue === "dark" || e.newValue === "light") {
        setMode(e.newValue);
      }
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  const update = (next: ThemeMode) => {
    setMode(next);
    setStoredTheme(next);
  };

  return [mode, update];
}
