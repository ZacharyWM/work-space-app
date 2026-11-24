// picker round-trips (notes/006): one short-lived socket per request — open,
// send the token-carrying message, await the single reply, close. Not the
// Connection class; nothing here joins a room. Each call takes a fresh clerk
// token since session tokens expire in ~60s.
import {
  decodeServerMessage,
  encodeMessage,
  type ClientMessage,
  type MemberEntry,
  type ServerMessage,
  type WorkspaceInfo,
  type WorkspaceListEntry,
} from "shared";

// open a socket, send one message, resolve with the first server reply
function request(url: string, msg: ClientMessage): Promise<ServerMessage> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    socket.onopen = () => socket.send(encodeMessage(msg));
    socket.onmessage = (ev) => {
      try {
        resolve(decodeServerMessage(String(ev.data)));
      } catch (err) {
        reject(err instanceof Error ? err : new Error(String(err)));
      }
      socket.close();
    };
    // fires for failed connects and drops; a no-op after the reply resolved
    socket.onclose = () => reject(new Error("connection closed"));
  });
}

// the workspaces this account has joined, newest first (mine marks the ones
// it created — deletable); throws on any failure (bad token included — the
// picker just shows a retryable error)
export async function listWorkspaces(url: string, token: string): Promise<WorkspaceListEntry[]> {
  const reply = await request(url, { type: "listWorkspaces", token });
  if (reply.type !== "workspaceList") throw new Error(`workspace list failed (${reply.type})`);
  return reply.workspaces;
}

// createWorkspace outcome the picker can act on: the new workspace, or the
// server's typed reason (slugTaken → pick another name; limitReached → the
// per-account cap, delete one first, notes/007)
export type CreateResult =
  | { ok: true; workspace: WorkspaceInfo }
  | { ok: false; reason: "slugTaken" | "invalidName" | "unauthorized" | "limitReached" };

// create a workspace from a name; the server derives the slug (notes/006)
export async function createWorkspace(
  url: string,
  token: string,
  name: string,
): Promise<CreateResult> {
  const reply = await request(url, { type: "createWorkspace", token, name });
  if (reply.type === "workspaceCreated") {
    return { ok: true, workspace: { slug: reply.slug, name: reply.name } };
  }
  if (reply.type === "createRejected") return { ok: false, reason: reply.reason };
  throw new Error(`workspace create failed (${reply.type})`);
}

// deleteWorkspace outcome the picker can act on (notes/007)
export type DeleteResult =
  | { ok: true }
  | { ok: false; reason: "unauthorized" | "notFound" | "notCreator" };

// delete a workspace this account created; anyone aboard is kicked server-side (notes/007)
export async function deleteWorkspace(
  url: string,
  token: string,
  slug: string,
): Promise<DeleteResult> {
  const reply = await request(url, { type: "deleteWorkspace", token, slug });
  if (reply.type === "workspaceDeleted") return { ok: true };
  if (reply.type === "deleteRejected") return { ok: false, reason: reply.reason };
  throw new Error(`workspace delete failed (${reply.type})`);
}

// the member-panel lists for a workspace this account created (notes/008;
// invites + requests notes/015); throws on any failure like listWorkspaces —
// the panel shows a retryable error
export type MemberList = {
  members: MemberEntry[];
  banned: MemberEntry[];
  invites: string[];
  requests: MemberEntry[];
};

export async function listMembers(url: string, token: string, slug: string): Promise<MemberList> {
  const reply = await request(url, { type: "listMembers", token, slug });
  if (reply.type !== "memberList") throw new Error(`member list failed (${reply.type})`);
  return {
    members: reply.members,
    banned: reply.banned,
    invites: reply.invites,
    requests: reply.requests,
  };
}

// remove/unban outcome the member panel can act on (notes/008)
export type MemberActionResult =
  | { ok: true }
  | { ok: false; reason: "unauthorized" | "notFound" | "notCreator" | "isCreator" };

// remove (ban) a member: kicked if aboard, blocked from rejoining until unbanned (notes/008)
export async function removeMember(
  url: string,
  token: string,
  slug: string,
  userId: string,
): Promise<MemberActionResult> {
  const reply = await request(url, { type: "removeMember", token, slug, userId });
  if (reply.type === "memberRemoved") return { ok: true };
  if (reply.type === "memberRejected") return { ok: false, reason: reply.reason };
  throw new Error(`member remove failed (${reply.type})`);
}

// lift a ban; the user rejoins via an invite or join request afterwards (notes/008, notes/015)
export async function unbanMember(
  url: string,
  token: string,
  slug: string,
  userId: string,
): Promise<MemberActionResult> {
  const reply = await request(url, { type: "unbanMember", token, slug, userId });
  if (reply.type === "memberUnbanned") return { ok: true };
  if (reply.type === "memberRejected") return { ok: false, reason: reply.reason };
  throw new Error(`member unban failed (${reply.type})`);
}

// --- invites + join requests (notes/015) ---

// invite/request outcome the panels can act on: one shared reason set per
// family — notFound covers a vanished workspace, invite, or request
export type InviteReason =
  | "unauthorized"
  | "notFound"
  | "notCreator"
  | "removed"
  | "alreadyMember"
  | "full";
export type InviteResult = { ok: true } | { ok: false; reason: InviteReason };

// send an invite to one email address, creator-only; the server stores it
// trimmed + lowercased (ADR 0003)
export async function sendInvite(
  url: string,
  token: string,
  slug: string,
  email: string,
): Promise<InviteResult> {
  const reply = await request(url, { type: "invite", token, slug, email });
  if (reply.type === "inviteSent") return { ok: true };
  if (reply.type === "inviteRejected") return { ok: false, reason: reply.reason };
  throw new Error(`invite failed (${reply.type})`);
}

// cancel a pending invite, creator-only
export async function cancelInvite(
  url: string,
  token: string,
  slug: string,
  email: string,
): Promise<InviteResult> {
  const reply = await request(url, { type: "cancelInvite", token, slug, email });
  if (reply.type === "inviteCancelled") return { ok: true };
  if (reply.type === "inviteRejected") return { ok: false, reason: reply.reason };
  throw new Error(`invite cancel failed (${reply.type})`);
}

// the picker's pending lists: invites addressed to this account's email, and
// this account's own join requests
export type PendingLists = { invites: WorkspaceInfo[]; requests: WorkspaceInfo[] };

export async function listPending(url: string, token: string): Promise<PendingLists> {
  const reply = await request(url, { type: "listPending", token });
  if (reply.type !== "pendingList") throw new Error(`pending list failed (${reply.type})`);
  return { invites: reply.invites, requests: reply.requests };
}

// accept an invite: the membership is created (bans + the member cap
// re-checked) and the workspace joins the picker list
export async function acceptInvite(
  url: string,
  token: string,
  slug: string,
): Promise<InviteResult> {
  const reply = await request(url, { type: "acceptInvite", token, slug });
  if (reply.type === "inviteAccepted") return { ok: true };
  if (reply.type === "inviteRejected") return { ok: false, reason: reply.reason };
  throw new Error(`invite accept failed (${reply.type})`);
}

// decline an invite: the pending row is removed, nothing else changes
export async function declineInvite(
  url: string,
  token: string,
  slug: string,
): Promise<InviteResult> {
  const reply = await request(url, { type: "declineInvite", token, slug });
  if (reply.type === "inviteDeclined") return { ok: true };
  if (reply.type === "inviteRejected") return { ok: false, reason: reply.reason };
  throw new Error(`invite decline failed (${reply.type})`);
}

// petition to join a workspace by its name (a slug works too — the server
// resolves through the same derivation as creation); the reply names the
// matched workspace for the picker's requests list
export type RequestJoinResult =
  | { ok: true; workspace: WorkspaceInfo }
  | { ok: false; reason: InviteReason };

export async function requestJoin(
  url: string,
  token: string,
  name: string,
): Promise<RequestJoinResult> {
  const reply = await request(url, { type: "requestJoin", token, name });
  if (reply.type === "requestSent") {
    return { ok: true, workspace: { slug: reply.slug, name: reply.name } };
  }
  if (reply.type === "requestRejected") return { ok: false, reason: reply.reason };
  throw new Error(`join request failed (${reply.type})`);
}

// withdraw this account's own pending join request
export async function cancelRequest(
  url: string,
  token: string,
  slug: string,
): Promise<InviteResult> {
  const reply = await request(url, { type: "cancelRequest", token, slug });
  if (reply.type === "requestCancelled") return { ok: true };
  if (reply.type === "requestRejected") return { ok: false, reason: reply.reason };
  throw new Error(`request cancel failed (${reply.type})`);
}

// approve a join request, creator-only: the membership is created (bans + the
// member cap checked at this moment)
export async function approveRequest(
  url: string,
  token: string,
  slug: string,
  userId: string,
): Promise<InviteResult> {
  const reply = await request(url, { type: "approveRequest", token, slug, userId });
  if (reply.type === "requestApproved") return { ok: true };
  if (reply.type === "requestRejected") return { ok: false, reason: reply.reason };
  throw new Error(`request approve failed (${reply.type})`);
}

// deny a join request, creator-only: the pending row is removed
export async function denyRequest(
  url: string,
  token: string,
  slug: string,
  userId: string,
): Promise<InviteResult> {
  const reply = await request(url, { type: "denyRequest", token, slug, userId });
  if (reply.type === "requestDenied") return { ok: true };
  if (reply.type === "requestRejected") return { ok: false, reason: reply.reason };
  throw new Error(`request deny failed (${reply.type})`);
}
