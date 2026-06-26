// Typed client for the Vidsync cloud control plane (auth, billing,
// device→user mapping). Separate from `api/client.ts`, which talks
// to the *local* sync daemon. The two backends know nothing
// about each other:
//
//   - Daemon: localhost via Vite proxy; X-API-Key injected by proxy.
//   - Cloud:  remote HTTPS; Clerk session JWT in Authorization header.
//
// The token is fetched per-request via getToken() — Clerk handles
// refresh under the hood, so we don't cache.

// Review comments are relayed through the control plane so they sync both
// ways between collaborators (see player/comments.ts). The wire shape is the
// player's Comment type; imported type-only (no runtime cycle).
import type { Comment } from "../../components/player/comments";

// CreateCommentInput is the body for POST .../comments. Author is stamped
// server-side from the session, never trusted from the client.
export interface CreateCommentInput {
  videoPath: string;
  // Content fingerprint (daemon BlocksHash) so the comment survives renames.
  contentKey?: string;
  t: number;
  tEnd?: number;
  parentId?: string | null;
  body: string;
}

// VideoCommentSummary is a per-clip rollup (count + latest comment time)
// for marking unread state in the file browser.
export interface VideoCommentSummary {
  videoPath: string;
  count: number;
  lastAt: string; // ISO 8601
}

// CommentStreamEvent is one frame from the SSE comment stream: "upsert"
// carries the full comment (create/resolve); "delete" carries just its id;
// "reaction" carries an emoji-count delta on a comment.
export interface CommentStreamEvent {
  type: "upsert" | "delete" | "reaction";
  // Present on the multiplexed per-user stream so the client can route the
  // event to the right project; implied (and harmless) on a per-folder stream.
  folderId?: string;
  comment?: Comment;
  id?: string;
  reaction?: {
    commentId: string;
    emoji: string;
    delta: number; // +1 added, -1 removed
    userEmail: string; // actor — lets a client skip its own echo
  };
}

export interface CloudClientConfig {
  baseURL: string;
  getToken: () => Promise<string | null>;
  // Called when the server rejects our bearer token with a 401 — i.e.
  // this device's desktop session was revoked (the account moved to
  // another machine via the email-code transfer). The provider wires
  // this to a local-only sign-out so the app drops to the sign-in
  // screen. Not fired for the synthetic "no token" 401 below, which
  // already means we're signed out.
  onUnauthorized?: () => void;
}

export class CloudAPIError extends Error {
  constructor(
    public readonly method: string,
    public readonly path: string,
    public readonly status: number,
    public readonly code: string,
    // Human-readable message from the backend body ({ message }). Kept
    // as its own field so UIs can show a clean string instead of the
    // verbose "POST /path: 400 code — …" form in Error.message.
    public readonly detail: string,
  ) {
    super(`${method} ${path}: ${status} ${code} — ${detail}`);
    this.name = "CloudAPIError";
  }
}

export interface Tier {
  name: "free" | "pro" | "studio";
  displayName: string;
  maxDevices: number; // -1 = unlimited
  maxProjects: number; // -1 = unlimited
  // Lifetime of the tier from account creation. Free = 1, paid = -1.
  maxDays: number;
  monthlyCents: number;
  yearlyCents: number;
}

export interface Me {
  id: string;
  email: string;
  tier: Tier;
  status: string;      // active / past_due / canceled / trialing / incomplete
  entitled: boolean;
  // True when the user has hit "Cancel" in the Stripe portal but the
  // subscription is still riding out the paid period. They keep tier
  // access until currentPeriodEnd. UI uses this to render
  // "Pro · Cancels DD/MM" so the user can see their cancel registered.
  cancelAtPeriodEnd: boolean;
  currentPeriodEnd?: string;
  // Moment the Free-tier trial expires (createdAt + tier.MaxDays).
  // Populated only on the Free plan; paid plans omit it. After this
  // timestamp passes, `entitled` flips to false and the UI blocks
  // project creation until the user upgrades.
  trialEndsAt?: string;
  // Set when the request includes ?device=<syncthingDeviceId>. The
  // frontend uses revokedAt to detect "this device has been
  // displaced by another sign-in".
  currentDeviceId?: string;
  currentDeviceRevokedAt?: string;
}

export interface CloudDevice {
  id: string;
  syncthingDeviceId: string;
  name: string;
  lastSeenAt: string;
  createdAt: string;
  revokedAt?: string;
}

// Desktop session row as returned by GET /v1/sessions. Mirrors
// sessionJSON in backend/internal/httpapi/sessions.go. lastUsedAt
// drives the "which session is mine" heuristic in
// revokeCurrentSession.
export interface DesktopSession {
  id: string;
  name: string;
  createdAt: string;
  lastUsedAt: string;
  expiresAt?: string;
}

// Returned (as the JSON body of a 403) when a device-registration
// attempt is blocked because the user already has a different
// active device. The client should prompt for the OTP and call
// verifyDevice with the token.
export interface VerificationRequired {
  error: "verification_required";
  message: string;
  verificationId: string;
  expiresAt: string;
}

// Wire shape of /v1/invitations rows. Mirrors the Go invitationJSON
// in backend/internal/httpapi/invitations.go. Both owner-side and
// recipient-side lists return the same shape; what differs is which
// rows you'll see (yours-as-owner vs yours-as-recipient).
// One person on a project's roster (from the backend members endpoint).
export interface CloudProjectMember {
  deviceId: string;
  email: string;
  name: string;
  role: "owner" | "member";
}

export interface CloudInvitation {
  id: string;
  folderId: string;
  folderLabel: string;
  ownerDeviceId: string;
  // Owner's email + display name (from the joined users row). Used
  // by the recipient's Invitations page to render "From <person>"
  // so they know who's inviting them, not just which device.
  ownerEmail?: string;
  ownerName?: string;
  recipientEmail: string;
  // Display name resolved by the backend from the recipient's Clerk
  // JWT `name` claim once they sign in. Absent until they do. UI
  // should prefer this over recipientEmail when present.
  recipientName?: string;
  status: "pending" | "accepted" | "declined" | "revoked" | "left";
  recipientDeviceId?: string;
  // Project's total size (bytes) as the owner's daemon reported it at
  // invite time. Lets the accept modal show the download size and warn
  // if the destination drive is too small. Absent on older invites and
  // non-cloud folder offers.
  folderSizeBytes?: number;
  createdAt: string;
  updatedAt: string;
  acceptedAt?: string;
}

const DEFAULT_TIMEOUT_MS = 15_000;

export class CloudClient {
  constructor(private readonly cfg: CloudClientConfig) {}

  // Optional deviceID lets the backend tell us whether *this* device
  // is still active or has been revoked by a sign-in elsewhere.
  me(deviceID?: string): Promise<Me> {
    const path = deviceID
      ? `/v1/me?device=${encodeURIComponent(deviceID)}`
      : "/v1/me";
    return this.request<Me>("GET", path);
  }

  listTiers(): Promise<{ tiers: Tier[] }> {
    return this.request<{ tiers: Tier[] }>("GET", "/v1/tiers", { auth: false });
  }

  listDevices(): Promise<{ devices: CloudDevice[] }> {
    return this.request<{ devices: CloudDevice[] }>("GET", "/v1/devices");
  }

  // registerDevice has two possible success shapes:
  //   - CloudDevice  → registration completed (200)
  //   - VerificationRequired → another device is active; OTP was emailed (403)
  // The caller discriminates on the presence of `error`.
  registerDevice(args: {
    syncthingDeviceId: string;
    name: string;
  }): Promise<CloudDevice | VerificationRequired> {
    return this.request<CloudDevice | VerificationRequired>(
      "POST", "/v1/devices",
      { body: args, allowStatuses: [200, 403] },
    );
  }

  verifyDevice(args: {
    verificationId: string;
    code: string;
  }): Promise<CloudDevice> {
    return this.request<CloudDevice>("POST", "/v1/devices/verify", {
      body: args,
    });
  }

  resendVerificationCode(verificationId: string): Promise<VerificationRequired> {
    return this.request<VerificationRequired>(
      "POST", "/v1/devices/resend",
      { body: { verificationId } },
    );
  }

  deleteDevice(id: string): Promise<void> {
    return this.request<void>("DELETE", `/v1/devices/${id}`);
  }

  // --- desktop sessions ---
  //
  // The backend surface (backend/internal/httpapi/sessions.go on the
  // control plane) exposes GET /v1/sessions + DELETE /v1/sessions/{id}.
  // Sign-out from this app revokes the current session so the bearer
  // token stops working immediately on every other device that might
  // have copied auth.bin off-host — clearing the local file alone is
  // not enough.
  //
  // The backend doesn't yet have a "revoke current" endpoint, so we
  // identify our own session heuristically: the GET call itself
  // refreshes our lastUsedAt, so the row with the most recent
  // lastUsedAt is the one this binary is authed under. Other devices'
  // sessions belong to different bearer tokens and can't have a more
  // recent timestamp than the request we just made.

  listSessions(): Promise<{ sessions: DesktopSession[] }> {
    return this.request<{ sessions: DesktopSession[] }>("GET", "/v1/sessions");
  }

  revokeSession(id: string): Promise<void> {
    return this.request<void>("DELETE", `/v1/sessions/${id}`);
  }

  // --- Review comments (per-project, membership-authorized) ---

  // Per-clip rollup for the whole project (count + latest comment time),
  // used to mark unread state across the file browser in one request.
  commentSummary(folderID: string): Promise<VideoCommentSummary[]> {
    return this.request<{ videos: VideoCommentSummary[] }>(
      "GET",
      `/v1/projects/${encodeURIComponent(folderID)}/comments/summary`,
    ).then((r) => r.videos ?? []);
  }

  listComments(
    folderID: string,
    videoPath: string,
    contentKey = "",
  ): Promise<Comment[]> {
    let path =
      `/v1/projects/${encodeURIComponent(folderID)}/comments` +
      `?videoPath=${encodeURIComponent(videoPath)}`;
    if (contentKey) path += `&contentKey=${encodeURIComponent(contentKey)}`;
    return this.request<{ comments: Comment[] }>("GET", path).then(
      (r) => r.comments ?? [],
    );
  }

  createComment(folderID: string, input: CreateCommentInput): Promise<Comment> {
    return this.request<Comment>(
      "POST",
      `/v1/projects/${encodeURIComponent(folderID)}/comments`,
      { body: input },
    );
  }

  setCommentResolved(
    folderID: string,
    id: string,
    resolved: boolean,
  ): Promise<Comment> {
    return this.request<Comment>(
      "PATCH",
      `/v1/projects/${encodeURIComponent(folderID)}/comments/${id}`,
      { body: { resolved } },
    );
  }

  deleteComment(folderID: string, id: string): Promise<void> {
    return this.request<void>(
      "DELETE",
      `/v1/projects/${encodeURIComponent(folderID)}/comments/${id}`,
    );
  }

  // Toggle the caller's emoji reaction on a comment; returns the comment with
  // its refreshed reaction aggregate (mine flags computed for the caller).
  toggleReaction(folderID: string, id: string, emoji: string): Promise<Comment> {
    return this.request<Comment>(
      "POST",
      `/v1/projects/${encodeURIComponent(folderID)}/comments/${id}/reactions`,
      { body: { emoji } },
    );
  }

  // streamComments opens the SSE stream for a single project's comments.
  async streamComments(
    folderID: string,
    onEvent: (ev: CommentStreamEvent) => void,
    signal: AbortSignal,
  ): Promise<void> {
    return this.consumeSSE(
      `/v1/projects/${encodeURIComponent(folderID)}/comments/stream`,
      onEvent,
      signal,
    );
  }

  // streamMyComments opens the multiplexed SSE stream that delivers comment
  // events across ALL the caller's projects on one connection — used for
  // app-wide notifications. Events carry folderId so the client can route them.
  async streamMyComments(
    onEvent: (ev: CommentStreamEvent) => void,
    signal: AbortSignal,
  ): Promise<void> {
    return this.consumeSSE("/v1/me/comments/stream", onEvent, signal);
  }

  // consumeSSE fetches an SSE endpoint (bearer in the Authorization header,
  // not the URL) and invokes onEvent per frame. Resolves when the stream ends
  // (server closed); rejects on network error or abort — callers reconnect
  // with backoff.
  private async consumeSSE(
    path: string,
    onEvent: (ev: CommentStreamEvent) => void,
    signal: AbortSignal,
  ): Promise<void> {
    const token = await this.cfg.getToken();
    if (!token) throw new CloudAPIError("GET", path, 401, "no_token", "not signed in");
    const url = this.cfg.baseURL.replace(/\/+$/, "") + path;
    const res = await fetch(url, {
      headers: { Accept: "text/event-stream", Authorization: `Bearer ${token}` },
      signal,
    });
    if (!res.ok || !res.body) {
      throw new CloudAPIError("GET", url, res.status, "stream_failed", "comment stream failed");
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return;
      buf += decoder.decode(value, { stream: true });
      // SSE frames are separated by a blank line.
      let sep: number;
      while ((sep = buf.indexOf("\n\n")) >= 0) {
        const frame = buf.slice(0, sep);
        buf = buf.slice(sep + 2);
        const data = frame
          .split("\n")
          .filter((l) => l.startsWith("data:"))
          .map((l) => l.slice(5).trim())
          .join("\n");
        if (!data) continue; // keepalive / comment line
        try {
          onEvent(JSON.parse(data) as CommentStreamEvent);
        } catch {
          // ignore malformed frame
        }
      }
    }
  }

  // revokeCurrentSession revokes only the session this binary is
  // using (heuristic above). Returns silently on success; throws on
  // network / auth errors so the caller can decide whether to still
  // wipe the local token.
  async revokeCurrentSession(): Promise<void> {
    const { sessions } = await this.listSessions();
    if (sessions.length === 0) return;
    const current = sessions.reduce((latest, s) =>
      s.lastUsedAt > latest.lastUsedAt ? s : latest,
    );
    await this.revokeSession(current.id);
  }

  // --- billing ---

  startCheckout(args: {
    tier: "pro" | "studio";
    interval: "monthly" | "yearly";
  }): Promise<{ url: string }> {
    // client=desktop pins the backend's return-URL pair to the
    // wails.localhost endpoints (vs the website's URLs). The legacy
    // default also points at wails.localhost, so omitting the hint
    // would still work — but being explicit keeps the two clients
    // symmetric and future-proofs against the default flipping.
    return this.request<{ url: string }>("POST", "/v1/billing/checkout", {
      body: { ...args, client: "desktop" },
    });
  }

  openPortal(): Promise<{ url: string }> {
    return this.request<{ url: string }>("GET", "/v1/billing/portal?client=desktop");
  }

  // --- invitations ---

  // Owner: create a project invite for an email address. The current
  // sync daemon device ID is stamped into the row so the recipient knows
  // who's sharing.
  createInvitation(args: {
    folderID: string;
    email: string;
    folderLabel: string;
    ownerDeviceId: string;
    // Project total size in bytes (owner's globalBytes). Optional —
    // omitted when the size isn't known yet (index not scanned).
    folderSizeBytes?: number;
  }): Promise<CloudInvitation> {
    return this.request<CloudInvitation>(
      "POST",
      `/v1/projects/${encodeURIComponent(args.folderID)}/invitations`,
      {
        body: {
          email: args.email,
          folderLabel: args.folderLabel,
          ownerDeviceId: args.ownerDeviceId,
          folderSizeBytes: args.folderSizeBytes,
        },
      },
    );
  }

  // Owner: list every invite for one of their folders (pending + history).
  listInvitationsForFolder(
    folderID: string,
  ): Promise<{ invitations: CloudInvitation[] }> {
    return this.request<{ invitations: CloudInvitation[] }>(
      "GET",
      `/v1/projects/${encodeURIComponent(folderID)}/invitations`,
    );
  }

  // Full project roster (owner + accepted members), visible to any member —
  // so a recipient sees sibling collaborators, not just the owner.
  projectMembers(folderID: string): Promise<CloudProjectMember[]> {
    return this.request<{ members: CloudProjectMember[] }>(
      "GET",
      `/v1/projects/${encodeURIComponent(folderID)}/members`,
    ).then((r) => r.members ?? []);
  }

  // Owner: cancel a pending invite.
  revokeInvitation(id: string): Promise<void> {
    return this.request<void>(
      "DELETE",
      `/v1/invitations/${encodeURIComponent(id)}`,
    );
  }

  // Recipient: list pending invites addressed to my email. Also
  // back-fills recipient_user_id server-side as a side effect, so an
  // invite sent before signup gets claimed on first call.
  listMyInvitations(): Promise<{ invitations: CloudInvitation[] }> {
    return this.request<{ invitations: CloudInvitation[] }>(
      "GET",
      "/v1/me/invitations",
    );
  }

  // Owner: poll for invites recipients have just accepted. The bridge
  // uses this to know when to PUT the recipient's device onto the
  // local folder. `since` is RFC3339; backend defaults to last 24h.
  listAcceptedSince(
    since?: string,
  ): Promise<{ invitations: CloudInvitation[] }> {
    const path = since
      ? `/v1/me/invitations/accepted?since=${encodeURIComponent(since)}`
      : "/v1/me/invitations/accepted";
    return this.request<{ invitations: CloudInvitation[] }>("GET", path);
  }

  // Recipient: accept a pending invite. The recipientDeviceId must be
  // one of the caller's active devices — backend rejects otherwise.
  acceptInvitation(args: {
    id: string;
    recipientDeviceId: string;
  }): Promise<CloudInvitation> {
    return this.request<CloudInvitation>(
      "POST",
      `/v1/invitations/${encodeURIComponent(args.id)}/accept`,
      { body: { recipientDeviceId: args.recipientDeviceId } },
    );
  }

  // Recipient: decline a pending invite.
  declineInvitation(id: string): Promise<void> {
    return this.request<void>(
      "POST",
      `/v1/invitations/${encodeURIComponent(id)}/decline`,
    );
  }

  // Recipient: leave a project they previously accepted. Server flips
  // the row to "left" so the owner's bridge can drop the recipient's
  // device from folder.devices on the next poll.
  leaveInvitation(id: string): Promise<void> {
    return this.request<void>(
      "POST",
      `/v1/invitations/${encodeURIComponent(id)}/leave`,
    );
  }

  // Owner: poll for invites that have flipped to "left" since the
  // given cursor. Mirrors listAcceptedSince — bridge advances a
  // separate localStorage cursor for left events.
  listLeftSince(
    since?: string,
  ): Promise<{ invitations: CloudInvitation[] }> {
    const path = since
      ? `/v1/me/invitations/left?since=${encodeURIComponent(since)}`
      : "/v1/me/invitations/left";
    return this.request<{ invitations: CloudInvitation[] }>("GET", path);
  }

  // Recipient: server-side fallback for the leave flow when the
  // local invitationID cache is missing (accepted on a different
  // browser, cleared storage, or accepted before the leave code
  // shipped). Returns null on 404 so callers can decide whether
  // to fall through to a pure local delete.
  async findMyAcceptedForFolder(
    folderID: string,
  ): Promise<CloudInvitation | null> {
    try {
      return await this.request<CloudInvitation>(
        "GET",
        `/v1/me/invitations/by-folder/${encodeURIComponent(folderID)}`,
      );
    } catch (e) {
      if (e instanceof CloudAPIError && e.status === 404) return null;
      throw e;
    }
  }

  // --- internals ---

  private async request<T>(
    method: string,
    path: string,
    options: {
      body?: unknown;
      auth?: boolean;
      signal?: AbortSignal;
      // Status codes that should be returned as data rather than
      // thrown as CloudAPIError. Used by registerDevice() so the
      // 403 verification_required body comes back to the caller.
      allowStatuses?: number[];
    } = {},
  ): Promise<T> {
    const url = this.cfg.baseURL.replace(/\/+$/, "") + path;

    const headers: Record<string, string> = {
      Accept: "application/json",
    };
    if (options.body !== undefined) headers["Content-Type"] = "application/json";

    if (options.auth !== false) {
      const token = await this.cfg.getToken();
      if (!token) {
        throw new CloudAPIError(method, path, 401, "no_token",
          "not signed in");
      }
      headers.Authorization = `Bearer ${token}`;
    }

    const ctl = new AbortController();
    const tid = setTimeout(() => ctl.abort(), DEFAULT_TIMEOUT_MS);
    const signal = options.signal ?? ctl.signal;

    let res: Response;
    try {
      res = await fetch(url, {
        method,
        headers,
        body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
        signal,
      });
    } finally {
      clearTimeout(tid);
    }

    if (res.status === 204) return undefined as T;

    const allowed = options.allowStatuses ?? [];
    if (!res.ok && !allowed.includes(res.status)) {
      // A 401 from the server means our token was rejected — the
      // session has been revoked (this device was displaced by the
      // email-code transfer on another machine). Signal the provider
      // so it can sign out locally; the app then shows the sign-in
      // screen. Fire before throwing so the logout happens even though
      // the caller treats this as an error.
      if (res.status === 401) this.cfg.onUnauthorized?.();
      // Backend returns { error: code, message: human-readable }.
      let code = "http_error";
      let message = res.statusText;
      try {
        const body = (await res.json()) as { error?: string; message?: string };
        if (body.error) code = body.error;
        if (body.message) message = body.message;
      } catch {
        // fall through with defaults
      }
      throw new CloudAPIError(method, path, res.status, code, message);
    }

    const ct = res.headers.get("content-type") || "";
    if (ct.includes("application/json")) return (await res.json()) as T;
    return (await res.text()) as unknown as T;
  }
}
