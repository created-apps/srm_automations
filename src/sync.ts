import { config } from './config';
import type { GroupCase } from './db';

/**
 * Step 2 -- "Add mentor on SYNC (ensure all participants are linked)".
 *
 * SYNC is a separate Supabase project. Its model (confirmed against the live
 * schema): a WhatsApp group is a `groups` row keyed by `group_jid`, people are
 * `users` rows, and who belongs to a group is `user_group_memberships`
 * (user_id, group_id, role). A mentor is a pre-existing user with role
 * 'mentor'; assigning them to a student is a membership row on the STUDENT's
 * group with role 'mentor'. `group_pairs` is effectively unused.
 *
 * So this step: find the SYNC group by JID (== our chat_id), confirm a student
 * is in it, resolve the mentor by name, and insert the mentor membership if it
 * isn't already there. It never creates groups or users -- SYNC's own
 * onboarding does that; a missing group/student is a failure to retry, not
 * something to invent (users.phone_number is NOT NULL and we have no mentor
 * phone anyway).
 */

export class SyncError extends Error {
  status: number;
  details: unknown;
  constructor(message: string, status: number, details: unknown) {
    super(message);
    this.name = 'SyncError';
    this.status = status;
    this.details = details;
  }
}

export interface SyncResult {
  skipped: boolean;
  reason?: string;
}

/** Collapse whitespace (SYNC has names with trailing tabs), fold case. */
function norm(s: string): string {
  return s.normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase();
}

async function call<T>(
  method: 'GET' | 'POST',
  pathname: string,
  init: { body?: unknown; prefer?: string } = {}
): Promise<T> {
  const res = await fetch(`${config.sync.url}/rest/v1${pathname}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      apikey: config.sync.serviceKey,
      authorization: `Bearer ${config.sync.serviceKey}`,
      ...(init.prefer ? { Prefer: init.prefer } : {}),
    },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  const text = await res.text();
  let data: unknown;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { raw: text };
  }
  if (!res.ok) {
    throw new SyncError(
      `SYNC ${method} ${pathname.split('?')[0]} returned ${res.status}: ${text.slice(0, 300)}`,
      res.status,
      data
    );
  }
  return data as T;
}

interface SyncGroupRow { id: string }
interface SyncUserRow { id: string; name: string }
interface MembershipRow { id: string }

export function syncConfigured(): boolean {
  return config.sync.configured;
}

/** The SYNC group id (groups.id uuid) for a WhatsApp JID, or null if absent. */
export async function findGroupIdByJid(jid: string): Promise<string | null> {
  if (!config.sync.configured) return null;
  const rows = await call<{ id: string }[]>(
    'GET',
    `/groups?select=id&group_jid=eq.${encodeURIComponent(jid)}&limit=1`
  );
  return rows[0]?.id ?? null;
}

export interface ResolvedMentor {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
}

/**
 * Resolve a mentor by exact (normalised) name among SYNC's mentors, returning
 * their email/phone. Used to look the mentor up in COSMIC (by email). Returns
 * null on zero or multiple matches -- never guesses.
 */
export async function resolveMentor(name: string): Promise<ResolvedMentor | null> {
  if (!config.sync.configured) return null;
  const trimmed = (name ?? '').trim();
  if (!trimmed) return null;
  const rows = await call<
    { id: string; name: string; email: string | null; phone_number: string | null }[]
  >('GET', `/users?select=id,name,email,phone_number&role=eq.mentor`);
  const target = norm(trimmed);
  const matches = rows.filter((r) => norm(r.name) === target);
  if (matches.length !== 1) return null;
  const m = matches[0]!;
  return { id: m.id, name: m.name, email: m.email, phone: m.phone_number };
}

export async function linkMentor(groupCase: GroupCase): Promise<SyncResult> {
  if (!config.sync.configured) {
    return { skipped: true, reason: 'SYNC not configured (SYNC_SUPABASE_URL/KEY unset)' };
  }

  const jid = groupCase.chatId;
  const mentorName = (groupCase.mentorName ?? '').trim();
  if (!mentorName) {
    // stage=MENTOR_ASSIGNED should guarantee this, but never link a blank name.
    throw new SyncError('case has no mentor_name to link on SYNC', 400, null);
  }

  // 1. The SYNC group for this WhatsApp JID.
  const groups = await call<SyncGroupRow[]>(
    'GET',
    `/groups?select=id&group_jid=eq.${encodeURIComponent(jid)}&limit=1`
  );
  const group = groups[0];
  if (!group) {
    throw new SyncError(
      `no SYNC group for JID ${jid} -- not onboarded on SYNC yet`,
      404,
      null
    );
  }

  // 2. Confirm the student is in the group (per "fail if the student isn't
  //    there"). We only need existence, not the row.
  const students = await call<MembershipRow[]>(
    'GET',
    `/user_group_memberships?select=id&group_id=eq.${group.id}&role=eq.student&limit=1`
  );
  if (!students[0]) {
    throw new SyncError(
      `SYNC group ${group.id} (JID ${jid}) has no student membership yet`,
      404,
      null
    );
  }

  // 3. Resolve the mentor by exact (normalised) name among SYNC's mentors.
  //    Refuse to guess: zero matches or more than one is a failure to surface,
  //    never a silent pick -- linking the wrong mentor is the worst outcome.
  const mentors = await call<SyncUserRow[]>(
    'GET',
    `/users?select=id,name&role=eq.mentor`
  );
  const target = norm(mentorName);
  const matches = mentors.filter((m) => norm(m.name) === target);
  if (matches.length === 0) {
    throw new SyncError(
      `no SYNC mentor named "${mentorName}" (name must match a SYNC mentor exactly)`,
      404,
      null
    );
  }
  if (matches.length > 1) {
    throw new SyncError(
      `"${mentorName}" matches ${matches.length} SYNC mentors -- ambiguous, not linking`,
      409,
      { ids: matches.map((m) => m.id) }
    );
  }
  const mentorUserId = matches[0]!.id;

  // 4. Insert the membership if it isn't already there (idempotent).
  const existing = await call<MembershipRow[]>(
    'GET',
    `/user_group_memberships?select=id&user_id=eq.${mentorUserId}&group_id=eq.${group.id}&limit=1`
  );
  if (existing[0]) {
    return { skipped: false }; // already linked -- nothing to do, count as OK
  }

  await call('POST', '/user_group_memberships', {
    body: { user_id: mentorUserId, group_id: group.id, role: 'mentor' },
    prefer: 'return=minimal',
  });
  return { skipped: false };
}
