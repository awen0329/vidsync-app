// Tiny localStorage-backed lookup for "what cloud invitation produced
// this local folder?". When the recipient accepts a project invite,
// we cache the invitationID keyed by folderID. Later, when the same
// user leaves that project via the project-detail page, we pull the
// id back out so we can POST /v1/invitations/:id/leave.
//
// This is per-browser and best-effort: the leave flow degrades to a
// pure local deleteFolder if the cache is missing (different browser,
// cleared storage, joined out-of-band). The owner's team panel just
// won't auto-update in that case, which is the existing behavior.

const KEY_PREFIX = "vidsync.acceptedInvitations.";

export function rememberAcceptedInvitation(
  folderID: string,
  invitationID: string,
): void {
  try {
    localStorage.setItem(KEY_PREFIX + folderID, invitationID);
  } catch {
    /* quota / private-mode — silent */
  }
}

export function lookupAcceptedInvitation(folderID: string): string | null {
  try {
    return localStorage.getItem(KEY_PREFIX + folderID);
  } catch {
    return null;
  }
}

export function forgetAcceptedInvitation(folderID: string): void {
  try {
    localStorage.removeItem(KEY_PREFIX + folderID);
  } catch {
    /* silent */
  }
}
