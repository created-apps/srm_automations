import { config } from './config';

/**
 * The slice of the COSMIC LMS API this service needs: log in for a token,
 * create a student, create a project, and look up an existing student/mentor by
 * email. Verified against the COSMIC FastAPI source (app/api/endpoints).
 *
 * Notes from the API:
 *  - Collection routes need the trailing slash (/students/, /projects/,
 *    /mentors/) -- without it FastAPI 307-redirects and the Authorization
 *    header can be dropped, yielding a surprise 401.
 *  - The token must belong to a super_admin or manager.
 *  - A student's generated password is returned only on create.
 */

const SCOPE_PREFIX = '/api/v1';

export class CosmicError extends Error {
  status: number;
  details: unknown;
  constructor(message: string, status: number, details: unknown) {
    super(message);
    this.name = 'CosmicError';
    this.status = status;
    this.details = details;
  }
}

export function cosmicConfigured(): boolean {
  return config.cosmic.configured;
}

let token: { value: string; expiresAt: number } | null = null;

async function login(): Promise<string> {
  const res = await fetch(`${config.cosmic.baseUrl}${SCOPE_PREFIX}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email: config.cosmic.adminEmail,
      password: config.cosmic.adminPassword,
    }),
  });
  const text = await res.text();
  let data: unknown;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { raw: text };
  }
  if (!res.ok) {
    throw new CosmicError(`COSMIC login failed (${res.status}): ${text.slice(0, 200)}`, res.status, data);
  }
  const accessToken = (data as { access_token?: string }).access_token;
  if (!accessToken) throw new CosmicError('COSMIC login returned no access_token', 500, data);
  // Tokens last 24h; refresh with a wide margin.
  token = { value: accessToken, expiresAt: Date.now() + 12 * 60 * 60 * 1000 };
  return accessToken;
}

async function accessToken(force = false): Promise<string> {
  if (!force && token && Date.now() < token.expiresAt) return token.value;
  return login();
}

async function call<T>(
  method: 'GET' | 'POST' | 'PATCH',
  pathname: string,
  init: { body?: unknown; retryAuth?: boolean } = {}
): Promise<T> {
  const bearer = await accessToken();
  const res = await fetch(`${config.cosmic.baseUrl}${SCOPE_PREFIX}${pathname}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      authorization: `Bearer ${bearer}`,
    },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });

  // A stale token -> re-login once and retry.
  if (res.status === 401 && init.retryAuth !== false) {
    await accessToken(true);
    return call<T>(method, pathname, { ...init, retryAuth: false });
  }

  const text = await res.text();
  let data: unknown;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { raw: text };
  }
  if (!res.ok) {
    const detail =
      (data as { detail?: unknown })?.detail !== undefined
        ? JSON.stringify((data as { detail: unknown }).detail)
        : text.slice(0, 200);
    throw new CosmicError(`COSMIC ${method} ${pathname} returned ${res.status}: ${detail}`, res.status, data);
  }
  return data as T;
}

// --- Students --------------------------------------------------------------

export interface StudentCreateInput {
  first_name: string;
  last_name: string;
  email: string;
  phone?: string;
  whatsapp_phone?: string;
  parent_name?: string;
  parent_email?: string;
  parent_phone?: string;
  project_themes_interested?: string[];
  field_interest_tags?: string[];
  board_curriculum?: string;
}

export interface Credentials {
  username: string;
  password: string;
  email: string;
}

export interface CreatedStudent {
  id: string;
  user_id: string;
  credentials?: Credentials;
}

export async function createStudent(input: StudentCreateInput): Promise<CreatedStudent> {
  const row = await call<{ id: string; user_id: string; credentials?: Credentials }>(
    'POST',
    '/students/',
    { body: input }
  );
  return { id: row.id, user_id: row.user_id, credentials: row.credentials };
}

/**
 * Mark a user verified/approved so the student can log in
 * (PATCH /user_approval/approve/{user_id}). Requires a super_admin token.
 * A 409 means they were already approved -- treated as success (idempotent).
 */
export async function verifyUser(userId: string): Promise<void> {
  try {
    await call('PATCH', `/user_approval/approve/${encodeURIComponent(userId)}`);
  } catch (err) {
    if (err instanceof CosmicError && err.status === 409) return; // already approved
    throw err;
  }
}

/** Find an existing student's id/user_id by email (for the duplicate case). */
export async function findStudentByEmail(
  email: string
): Promise<{ id: string; user_id: string } | null> {
  const rows = await call<{ id: string; user_id?: string; email?: string }[]>('GET', '/students/');
  const target = email.trim().toLowerCase();
  const hit = rows.find((r) => (r.email ?? '').trim().toLowerCase() === target);
  return hit ? { id: hit.id, user_id: hit.user_id ?? '' } : null;
}

// --- Mentors ---------------------------------------------------------------

/** Resolve a COSMIC mentor id by email first, then by exact (normalised) name. */
export async function findMentorId(opts: {
  email?: string | null;
  name?: string | null;
}): Promise<string | null> {
  const rows = await call<
    { id: string; email?: string | null; first_name?: string | null; last_name?: string | null }[]
  >('GET', '/mentors/');

  const norm = (s: string) => s.normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase();

  if (opts.email) {
    const target = norm(opts.email);
    const byEmail = rows.find((r) => r.email && norm(r.email) === target);
    if (byEmail) return byEmail.id;
  }
  if (opts.name) {
    const target = norm(opts.name);
    const byName = rows.find(
      (r) => norm(`${r.first_name ?? ''} ${r.last_name ?? ''}`) === target
    );
    if (byName) return byName.id;
  }
  return null;
}

// --- Projects --------------------------------------------------------------

export interface ProjectCreateInput {
  mentor_id?: string;
  student_id: string;
  project_name: string;
  project_description?: string;
  project_track?: string;
  status?: string;
  start_date?: string; // YYYY-MM-DD
  end_date?: string; // YYYY-MM-DD
}

export async function createProject(input: ProjectCreateInput): Promise<{ id: string }> {
  const row = await call<{ id: string }>('POST', '/projects/', { body: input });
  return { id: row.id };
}

/**
 * Link a COSMIC project to its SYNC WhatsApp group
 * (PATCH /projects/{id}/sync-group). `syncGroupId` is the SYNC groups.id uuid;
 * passing the group_jid helps SYNC register the bridge. Re-linking the same
 * group is idempotent (409 only when a *different* group is already linked).
 */
export async function setProjectSyncGroup(
  projectId: string,
  syncGroupId: string,
  groupJid?: string
): Promise<void> {
  await call('PATCH', `/projects/${encodeURIComponent(projectId)}/sync-group`, {
    body: { sync_group_id: syncGroupId, ...(groupJid ? { group_jid: groupJid } : {}) },
  });
}
