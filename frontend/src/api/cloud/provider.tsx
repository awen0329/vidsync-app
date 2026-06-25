import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  type ReactNode,
} from "react";
import { useBearerAuth } from "../bearerAuth";
import { CloudClient } from "./client";

// CloudProvider wires the Wails bearer token into the CloudClient.
// The desktop app no longer embeds the Clerk SDK; instead it stores a
// long-lived `vsk_…` token (issued by the website's /auth/desktop
// bridge) in Windows Credential storage, and uses it as
// Authorization: Bearer on every backend call.
//
// We read the token synchronously per-request from the BearerAuth
// context. There's no refresh dance because the backend treats the
// token as a long-lived session row; revoking via DELETE
// /v1/sessions/{id} (future UI) is the path to invalidating it.

const CloudContext = createContext<CloudClient | null>(null);

export function CloudProvider({
  baseURL,
  children,
}: {
  baseURL: string;
  children: ReactNode;
}) {
  const { token, forceSignOut } = useBearerAuth();

  // Guard so a burst of 401s (every in-flight poll fails at once when
  // the session is revoked) triggers exactly one forced sign-out. Reset
  // whenever the token changes, so a later re-sign-in re-arms it.
  const firedRef = useRef(false);
  useEffect(() => {
    firedRef.current = false;
  }, [token]);

  const client = useMemo(
    () =>
      new CloudClient({
        baseURL,
        // Async to match the original Clerk-driven signature; we just
        // return the in-memory bearer. Returning null disables auth
        // entirely (the CloudClient short-circuits with a 401 error).
        getToken: async () => (token ? token : null),
        onUnauthorized: () => {
          if (firedRef.current) return;
          firedRef.current = true;
          forceSignOut();
        },
      }),
    [baseURL, token, forceSignOut],
  );

  return (
    <CloudContext.Provider value={client}>{children}</CloudContext.Provider>
  );
}

export function useCloudClient(): CloudClient {
  const c = useContext(CloudContext);
  if (!c) {
    throw new Error(
      "useCloudClient called outside <CloudProvider>. Wrap your app in CloudProvider after BearerAuthProvider.",
    );
  }
  return c;
}

// useOptionalCloudClient returns the client when cloud is enabled (the app
// is wrapped in CloudProvider) or null in a local-only build. Lets features
// like review comments degrade to read-only/disabled instead of crashing.
export function useOptionalCloudClient(): CloudClient | null {
  return useContext(CloudContext);
}
