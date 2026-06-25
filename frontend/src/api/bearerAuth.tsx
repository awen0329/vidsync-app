import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { clearLastKnownEmail } from "./lastKnownEmail";

// Bearer-token auth that talks to the Wails backend instead of Clerk.
//
// The desktop app no longer embeds Clerk. Sign-in is delegated to
// thevidsync.com via the system browser — the Wails binary exposes
// these methods on `window.go.main.App` (see cmd/vidsync/auth_bridge.go):
//
//   SignIn()              → opens https://thevidsync.com/auth/desktop?...
//   GetAuthToken()        → returns the stored `vsk_…` bearer, or ""
//   ClearAuthToken()      → full sign-out: wipes the token AND clears
//                           the thevidsync.com Clerk session in browser
//   ClearAuthTokenLocal() → wipes the token only (no browser); used for
//                           the involuntary displacement logout
//
// The bridge URL redirects back to vidsync://auth-callback#token=...
// which the OS hands to the Wails app, which DPAPI-encrypts the token
// to %LOCALAPPDATA%\Vidsync\auth.bin and emits the Wails event
// `auth:token-changed`. Our `BearerAuthProvider` listens for that
// event and re-reads the token, causing `isSignedIn` to flip.
//
// The token itself is used as `Authorization: Bearer <token>` on every
// backend call — both the CloudClient and any future REST helpers.

interface BearerAuthValue {
  // True once GetAuthToken() has resolved at least once. Components
  // can render a "Loading…" frame until isLoading goes false to avoid
  // a sign-in flash on apps that already have a token cached.
  isLoading: boolean;
  // Whether a non-empty token is currently in memory.
  isSignedIn: boolean;
  // The raw token, or "". Exposed so the CloudClient can read it
  // synchronously per-request without re-entering the provider.
  token: string;
  // Opens the system browser to thevidsync.com/auth/desktop. The
  // user signs in there; the browser then deep-links back via the
  // vidsync:// URI scheme and the bridge updates state.
  signIn: () => void;
  // User-initiated full sign-out: wipes the local token AND opens the
  // browser to clear the thevidsync.com Clerk session, so the next
  // sign-in actually re-authenticates. Call sites also revoke the
  // backend session first (useRevokeCurrentSession).
  signOut: () => void;
  // Involuntary sign-out: the backend revoked this device's session
  // (the account was moved to another machine via the email-code
  // transfer), so a backend call came back 401. Local-only — unlike
  // signOut it does NOT touch the website Clerk session (the user is
  // signed in on the other machine). Also records signedOutReason so
  // the sign-in screen can explain why the user landed back here.
  forceSignOut: () => void;
  // Non-null after a forceSignOut until the next successful sign-in.
  // The sign-in screen reads it to show a "you were signed out on
  // another device" banner instead of leaving the logout unexplained.
  signedOutReason: "displaced" | null;
}

interface VidsyncBindings {
  SignIn?: () => Promise<void>;
  GetAuthToken?: () => Promise<string>;
  ClearAuthToken?: () => Promise<void>;
  ClearAuthTokenLocal?: () => Promise<void>;
}

interface VidsyncRuntime {
  EventsOn?: (name: string, cb: (...args: unknown[]) => void) => () => void;
}

interface WailsGlobals {
  go?: { main?: { App?: VidsyncBindings } };
  runtime?: VidsyncRuntime;
}

function wailsApp(): VidsyncBindings | null {
  const w = window as unknown as WailsGlobals;
  return w.go?.main?.App ?? null;
}

function wailsRuntime(): VidsyncRuntime | null {
  const w = window as unknown as WailsGlobals;
  return w.runtime ?? null;
}

const AuthContext = createContext<BearerAuthValue | null>(null);

export function BearerAuthProvider({ children }: { children: ReactNode }) {
  const [token, setToken] = useState<string>("");
  const [isLoading, setIsLoading] = useState(true);
  const [signedOutReason, setSignedOutReason] =
    useState<"displaced" | null>(null);

  const refresh = useCallback(async () => {
    const app = wailsApp();
    if (!app?.GetAuthToken) {
      // Wails not bound yet (running in pure-browser dev). Stay
      // signed out — there's no real sign-in surface in that mode.
      setIsLoading(false);
      return;
    }
    try {
      const t = (await app.GetAuthToken()) ?? "";
      setToken(t);
      // A real token means we're (re)signed-in — clear any stale
      // "displaced" banner from a prior forced logout.
      if (t) setSignedOutReason(null);
    } catch {
      setToken("");
    } finally {
      setIsLoading(false);
    }
  }, []);

  // Initial load + subscribe to the Wails event so a successful
  // browser-bridge sign-in flips the React tree without any reload.
  useEffect(() => {
    void refresh();

    const rt = wailsRuntime();
    if (!rt?.EventsOn) return;
    const unsub = rt.EventsOn("auth:token-changed", () => {
      void refresh();
    });
    return () => {
      try {
        unsub?.();
      } catch {
        // EventsOn returns a cleanup; calling it on an already-
        // unmounted runtime can throw on hot reload. Safe to ignore.
      }
    };
  }, [refresh]);

  const signIn = useCallback(() => {
    const app = wailsApp();
    if (!app?.SignIn) {
      // Browser-only dev fallback — open the bridge in a new tab.
      window.open(
        "https://thevidsync.com/auth/desktop?return=vidsync://auth-callback",
        "_blank",
      );
      return;
    }
    void app.SignIn();
  }, []);

  const signOut = useCallback(() => {
    // Drop the sticky email so the next account on this machine never
    // briefly shows the previous user's address.
    clearLastKnownEmail();
    const app = wailsApp();
    if (app?.ClearAuthToken) {
      void app.ClearAuthToken();
    } else {
      // Best-effort fallback: drop the in-memory copy. The Wails
      // event handler will reconcile when the binding becomes
      // available.
      setToken("");
    }
  }, []);

  const forceSignOut = useCallback(() => {
    // Record why before wiping so the sign-in screen can explain the
    // logout the moment AuthGate flips to it.
    setSignedOutReason("displaced");
    clearLastKnownEmail();
    const app = wailsApp();
    if (app?.ClearAuthTokenLocal) {
      // Local-only: no Clerk browser sign-out (see the Go binding).
      void app.ClearAuthTokenLocal();
    } else {
      setToken("");
    }
  }, []);

  const value = useMemo<BearerAuthValue>(
    () => ({
      isLoading,
      isSignedIn: token.length > 0,
      token,
      signIn,
      signOut,
      forceSignOut,
      signedOutReason,
    }),
    [isLoading, token, signIn, signOut, forceSignOut, signedOutReason],
  );

  return (
    <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
  );
}

export function useBearerAuth(): BearerAuthValue {
  const v = useContext(AuthContext);
  if (!v) {
    throw new Error("useBearerAuth called outside <BearerAuthProvider>");
  }
  return v;
}
