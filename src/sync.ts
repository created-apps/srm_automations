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
 * SYNC's mentors, fetched once per run.
 *
 * Three steps need the mentor (the group membership, their Drive access and
 * the COSMIC match) and each used to pull the whole mentor list for itself.
 * The cache is cleared at the start of every case so a mentor added between
 * ticks is still seen.
 */
let mentorCache: ResolvedMentor[] | null = null;

export function resetMentorCache(): void {
  mentorCache = null;
}

interface MentorRow {
  id: string;
  name: string;
  email: string | null;
  phone_number: string | null;
}

async function allMentors(): Promise<ResolvedMentor[]> {
  if (mentorCache) return mentorCache;
  const rows = await call<MentorRow[]>(
    'GET',
    `/users?select=id,name,email,phone_number&role=eq.mentor`
  );
  mentorCache = rows.map((r) => ({
    id: r.id,
    name: r.name,
    email: r.email,
    phone: r.phone_number,
  }));
  return mentorCache;
}

/**
 * The mentor for a case.
 *
 * By SYNC id when the case carries one -- mentors added from the dashboard get
 * a SYNC account at creation, and the id is stamped on the case when they are
 * introduced. Only the older, name-only cases fall back to matching on name,
 * which refuses to guess: zero or several matches is a failure to surface, not
 * a pick, because linking the wrong mentor is the worst outcome available.
 */
export async function resolveMentorForCase(
  groupCase: GroupCase
): Promise<ResolvedMentor | null> {
  if (!config.sync.configured) return null;

  const mentors = await allMentors();

  if (groupCase.mentorSyncUserId) {
    const byId = mentors.find((m) => m.id === groupCase.mentorSyncUserId);
    if (byId) return byId;
    // The stored id no longer resolves (removed on SYNC, or no longer a
    // mentor): fall through to the name match rather than doing nothing.
  }

  return resolveMentor(groupCase.mentorName ?? '');
}

/**
 * Resolve a mentor by exact (normalised) name among SYNC's mentors. Returns
 * null on zero or multiple matches -- never guesses.
 */
export async function resolveMentor(name: string): Promise<ResolvedMentor | null> {
  if (!config.sync.configured) return null;
  const trimmed = (name ?? '').trim();
  if (!trimmed) return null;
  const target = norm(trimmed);
  const matches = (await allMentors()).filter((m) => norm(m.name) === target);
  return matches.length === 1 ? matches[0]! : null;
}

/**
 * Why a mentor couldn't be resolved, in words worth putting in front of a
 * person. Only called on the failure path, so the extra request is fine.
 */
export async function explainUnresolved(groupCase: GroupCase): Promise<string> {
  const name = (groupCase.mentorName ?? '').trim();
  if (!name) return 'the case has no mentor name';
  const matches = (await allMentors()).filter((m) => norm(m.name) === norm(name));
  if (matches.length === 0) {
    return `no SYNC mentor named "${name}" (the name must match a SYNC mentor exactly)`;
  }
  if (matches.length > 1) {
    return `"${name}" matches ${matches.length} SYNC mentors -- ambiguous, not linking`;
  }
  return `"${name}" could not be resolved on SYNC`;
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

  // 3. Resolve the mentor -- by the id stamped on the case, else by exact name.
  const mentor = await resolveMentorForCase(groupCase);
  if (!mentor) {
    throw new SyncError(await explainUnresolved(groupCase), 404, null);
  }
  const mentorUserId = mentor.id;

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
