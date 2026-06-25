// Shared Dropbox-account state so every surface (sidebar connect button,
// per-project backup toggles, the BackupCard) agrees on whether Dropbox is
// configured (the desktop build has a Dropbox app client id) and connected
// (the user has linked their account). A tiny module-level store fetched once
// and broadcast, rather than each consumer hitting the bridge independently.

import { useEffect, useState } from "react";
import {
  dropboxAvailable,
  dropboxStatus,
  type DropboxAccount,
} from "../lib/dropbox";

let cached: DropboxAccount | null = null;
const listeners = new Set<(a: DropboxAccount | null) => void>();

// Re-fetch the account and broadcast to all hooks. Call after connect/disconnect.
export async function refreshDropboxAccount(): Promise<DropboxAccount | null> {
  if (!dropboxAvailable()) return null;
  const a = await dropboxStatus();
  cached = a;
  for (const l of listeners) l(a);
  return a;
}

export function useDropboxAccount(): DropboxAccount | null {
  const [acct, setAcct] = useState<DropboxAccount | null>(cached);
  useEffect(() => {
    listeners.add(setAcct);
    // First mounter primes the cache; everyone else reuses it.
    if (cached === null && dropboxAvailable()) void refreshDropboxAccount();
    return () => {
      listeners.delete(setAcct);
    };
  }, []);
  return acct;
}
