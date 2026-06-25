import { useBearerAuth } from "../api/bearerAuth";
import { VidSyncLogo } from "./VidSyncLogo";

// SignInScreen is the pre-auth landing for the Vidsync desktop app.
// Production Clerk keys can't load inside the Wails WebView (origin
// restriction — see the long convo in CLAUDE.md), so the desktop app
// no longer embeds the Clerk sign-in widget. Instead, clicking the
// button opens https://thevidsync.com/auth/desktop in the user's
// system browser; thevidsync.com handles the full Clerk flow and
// deep-links back via vidsync://auth-callback#token=... which the
// Wails auth bridge persists and notifies the React app about.

export function SignInScreen() {
  const { signIn, signedOutReason } = useBearerAuth();

  return (
    <div className="flex h-full flex-col bg-base text-fg-strong">
      <div className="flex flex-1 flex-col items-center justify-center px-6 py-12">
        <div className="mb-8 flex items-center gap-3">
          <VidSyncLogo className="h-10 w-10 rounded-lg" />
          <h1 className="text-2xl font-semibold text-fg-strong">Vidsync</h1>
        </div>
        {signedOutReason === "displaced" && (
          <div className="mb-8 max-w-md rounded-lg border border-amber-500/30 bg-amber-500/5 px-4 py-3 text-center text-sm text-amber-200">
            You were signed out because your account was activated on
            another device. Vidsync allows one active device at a time —
            sign in here to move it back.
          </div>
        )}
        <p className="mb-8 max-w-md text-center text-sm text-fg-soft">
          P2P sync built for video creators. Sign in to manage your
          devices and projects.
        </p>

        <button
          type="button"
          onClick={signIn}
          className="rounded-lg bg-indigo-600 px-6 py-3 text-sm font-semibold text-white shadow-md transition-all hover:bg-indigo-500 hover:shadow-lg focus:outline-none focus:ring-2 focus:ring-indigo-400 focus:ring-offset-2 focus:ring-offset-base"
        >
          Sign in with thevidsync.com
        </button>

        <p className="mt-6 max-w-md text-center text-xs text-fg-faint">
          Your browser will open to thevidsync.com. After signing in,
          this app will pick up where you left off automatically.
        </p>
      </div>
    </div>
  );
}
