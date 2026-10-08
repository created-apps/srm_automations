import { config } from './config';

/**
 * Storage for this service, over the Supabase REST API of the shared project.
 *
 * We read public.group_cases (owned by the sibling services -- read only from
 * here) and own public.project_setups (sql/001_project_setup.sql). The service
 * key bypasses row-level security. Rows come back snake_case; everything above
 * this module works in camelCase with real Dates, so the mapping lives here.
 */

export class DbError extends Error {
  status: number;
  details: unknown;

  constructor(message: string, status: number, details: unknown) {
    super(message);
    this.name = 'DbError';
    this.status = status;
    this.details = details;
  }
}

async function call<T>(
  method: 'GET' | 'POST' | 'PATCH',
  pathname: string,
  init: { body?: unknown; prefer?: string } = {}
): Promise<T> {
  const res = await fetch(`${config.supabase.url}/rest/v1${pathname}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      apikey: config.supabase.serviceKey,
      authorization: `Bearer ${config.supabase.serviceKey}`,
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
    throw new DbError(
      `Supabase ${method} ${pathname.split('?')[0]} returned ${res.status}: ${text.slice(0, 500)}`,
      res.status,
      data
    );
  }

  return data as T;
}

// ---------------------------------------------------------------------------
// group_cases (read only) -- just the columns Stage 5 needs.

export type CaseStage =
  | 'AWAITING_JOIN'
  | 'NEW'
  | 'IN_PROGRESS'
  | 'MENTOR_ASSIGNED'
  | 'ABANDONED';

export interface GroupCase {
  id: string;
  chatId: string;
  groupName: string;
  studentName: string;
  studentPhone: string | null;
  studentEmail: string | null;
  parentName: string | null;
  parentPhone: string | null;
  parentEmail: string | null;
  projectName: string | null;
  stage: CaseStage;
  mentorName: string | null;
  /**
   * When the mentor's introduction actually went out. This is the gate the
   * mentor-dependent steps wait on -- `stage` is a coarser field that other
   * flows write, and "the family has been introduced to their mentor" is the
   * thing those steps genuinely require.
   */
  mentorIntroSentAt: Date | null;
  /** The mentor's SYNC users.id, stamped at introduction. */
  mentorSyncUserId: string | null;
  /**
   * The dashboard's kill switch. Set means someone stopped this case: nothing
   * here may touch its WhatsApp group, Drive folder, SYNC or Cosmic records
   * ever again.
   */
  operationsStoppedAt: Date | null;
}

interface GroupCaseRow {
  id: string;
  chat_id: string;
  group_name: string;
  student_name: string;
  student_phone: string | null;
  student_email: string | null;
  parent_name: string | null;
  parent_phone: string | null;
  parent_email: string | null;
  project_name: string | null;
  stage: CaseStage;
  mentor_name: string | null;
  mentor_intro_sent_at: string | null;
  mentor_sync_user_id: string | null;
  operations_stopped_at: string | null;
}

const CASE_COLUMNS =
  'id,chat_id,group_name,student_name,student_phone,student_email,parent_name,parent_phone,parent_email,project_name,stage,mentor_name,mentor_intro_sent_at,mentor_sync_user_id,operations_stopped_at';

function toCase(row: GroupCaseRow): GroupCase {
  return {
    id: row.id,
    chatId: row.chat_id,
    groupName: row.group_name,
    studentName: row.student_name,
    studentPhone: row.student_phone,
    studentEmail: row.student_email,
    parentName: row.parent_name,
    parentPhone: row.parent_phone,
    parentEmail: row.parent_email,
    projectName: row.project_name,
    stage: row.stage,
    mentorName: row.mentor_name,
    mentorIntroSentAt: row.mentor_intro_sent_at ? new Date(row.mentor_intro_sent_at) : null,
    mentorSyncUserId: row.mentor_sync_user_id,
    operationsStoppedAt: row.operations_stopped_at
      ? new Date(row.operations_stopped_at)
      : null,
  };
}

export async function findCaseById(id: string): Promise<GroupCase | null> {
  const params = new URLSearchParams({
    select: CASE_COLUMNS,
    id: `eq.${id}`,
    limit: '1',
  });
  const rows = await call<GroupCaseRow[]>('GET', `/group_cases?${params}`);
  return rows[0] ? toCase(rows[0]) : null;
}

// ---------------------------------------------------------------------------
// intake_rows (read only) -- the sheet row a case was created from. Owned by
// the intake service; `raw` holds every cell of the row, keyed by header.

const PROGRAM_TYPE_COLUMN = 'Program Type(s)';

/** The row's "Program Type(s)" cell (PPP / RBP / ...), or null if blank or no row. */
export async function findProgramType(chatId: string): Promise<string | null> {
  const params = new URLSearchParams({
    select: 'raw',
    chat_id: `eq.${chatId}`,
    order: 'created_at.desc',
    limit: '1',
  });
  const rows = await call<{ raw: Record<string, string> | null }[]>('GET', `/intake_rows?${params}`);
  const value = (rows[0]?.raw?.[PROGRAM_TYPE_COLUMN] ?? '').trim();
  return value || null;
}

// ---------------------------------------------------------------------------
// project_setups (read/write) -- this service's state.

export type SetupStatus = 'PENDING' | 'RUNNING' | 'DONE' | 'FAILED';
export type StepStatus = 'PENDING' | 'OK' | 'FAILED' | 'SKIPPED';

export interface ProjectSetup {
  caseId: string;
  projectTitle: string | null;
  projectDescription: string | null;
  curriculumSubject: string | null;
  submittedAt: Date | null;
  submittedBy: string | null;
  status: SetupStatus;
  stepWhatsapp: StepStatus;
  stepWhatsappDriveLink: StepStatus;
  stepSync: StepStatus;
  stepDrive: StepStatus;
  stepMentorAccess: StepStatus;
  stepCurriculum: StepStatus;
  stepCosmicStudent: StepStatus;
  stepCosmicProject: StepStatus;
  stepCosmicSyncGroup: StepStatus;
  driveFolderId: string | null;
  driveFolderUrl: string | null;
  cosmicStudentId: string | null;
  cosmicUserId: string | null;
  cosmicProjectId: string | null;
  attempts: number;
  lastError: string | null;
  lastRunAt: Date | null;
  completedAt: Date | null;
  /** Bumped by whichever writer last changed the title or description. */
  detailsRevision: number;
  /** The revision this service has already put on WhatsApp. */
  appliedRevision: number;
}

interface ProjectSetupRow {
  case_id: string;
  project_title: string | null;
  project_description: string | null;
  curriculum_subject: string | null;
  submitted_at: string | null;
  submitted_by: string | null;
  status: SetupStatus;
  step_whatsapp: StepStatus;
  step_whatsapp_drive_link: StepStatus;
  step_sync: StepStatus;
  step_drive: StepStatus;
  step_mentor_access: StepStatus;
  step_curriculum: StepStatus;
  step_cosmic_student: StepStatus;
  step_cosmic_project: StepStatus;
  step_cosmic_sync_group: StepStatus;
  drive_folder_id: string | null;
  drive_folder_url: string | null;
  cosmic_student_id: string | null;
  cosmic_user_id: string | null;
  cosmic_project_id: string | null;
  attempts: number;
  last_error: string | null;
  last_run_at: string | null;
  completed_at: string | null;
  details_revision: number;
  applied_revision: number;
}

const date = (v: string | null): Date | null => (v === null ? null : new Date(v));

function toSetup(row: ProjectSetupRow): ProjectSetup {
  return {
    caseId: row.case_id,
    projectTitle: row.project_title,
    projectDescription: row.project_description,
    curriculumSubject: row.curriculum_subject,
    submittedAt: date(row.submitted_at),
    submittedBy: row.submitted_by,
    status: row.status,
    stepWhatsapp: row.step_whatsapp,
    stepWhatsappDriveLink: row.step_whatsapp_drive_link,
    stepSync: row.step_sync,
    stepDrive: row.step_drive,
    stepMentorAccess: row.step_mentor_access,
    stepCurriculum: row.step_curriculum,
    stepCosmicStudent: row.step_cosmic_student,
    stepCosmicProject: row.step_cosmic_project,
    stepCosmicSyncGroup: row.step_cosmic_sync_group,
    driveFolderId: row.drive_folder_id,
    driveFolderUrl: row.drive_folder_url,
    cosmicStudentId: row.cosmic_student_id,
    cosmicUserId: row.cosmic_user_id,
    cosmicProjectId: row.cosmic_project_id,
    attempts: row.attempts,
    lastError: row.last_error,
    lastRunAt: date(row.last_run_at),
    completedAt: date(row.completed_at),
    detailsRevision: row.details_revision,
    appliedRevision: row.applied_revision,
  };
}

export async function findSetup(caseId: string): Promise<ProjectSetup | null> {
  const params = new URLSearchParams({
    select: '*',
    case_id: `eq.${caseId}`,
    limit: '1',
  });
  const rows = await call<ProjectSetupRow[]>('GET', `/project_setups?${params}`);
  return rows[0] ? toSetup(rows[0]) : null;
}

/**
 * Cases the cron should look at: details submitted, not already finished.
 *
 * Note what is NOT filtered here any more. The mentor gate used to live in
 * this query (`group_cases.stage = 'MENTOR_ASSIGNED'`), which kept the whole
 * case out of the working set until a mentor existed. The WhatsApp title and
 * description no longer wait for one, so the gate moved onto the individual
 * steps that genuinely need a mentor -- see `mentorReady` in setup.ts. A case
 * with no mentor yet is picked up, has its group renamed, and stops there.
 *
 * maxAttempts (when non-zero) drops cases that have failed too many times.
 */
export async function listRunnable(maxAttempts: number): Promise<ProjectSetup[]> {
  const params = new URLSearchParams();
  // The embed is `!inner` purely to filter on the case: a stopped case's setup
  // must never be claimed, and an inner join is how PostgREST expresses that
  // in one request. Nothing reads the embedded columns -- toSetup ignores them.
  params.set('select', '*,group_cases!inner(operations_stopped_at)');
  params.set('submitted_at', 'not.is.null');
  params.set('status', 'in.(PENDING,FAILED)');
  params.set('group_cases.operations_stopped_at', 'is.null');
  if (maxAttempts > 0) params.set('attempts', `lt.${maxAttempts}`);
  params.set('order', 'submitted_at.asc');

  const rows = await call<ProjectSetupRow[]>('GET', `/project_setups?${params}`);
  return rows.map(toSetup);
}

/**
 * The auto-fire gate: cases nobody has submitted, but which plainly are ready.
 *
 * A case becomes eligible for the cron when `submitted_at` is set, which the
 * dashboard's Project Setup action and the sheet sync both do. Neither always
 * gets the chance: the sheet sync adopts details it finds on its first pass as
 * a baseline rather than a submission, and a case whose details were written
 * before that gate existed has none either. Those cases would sit with a
 * complete title, a complete description and an introduced mentor, waiting for
 * a human to press a button that adds nothing.
 *
 * So when a row carries both halves of the details and the mentor has actually
 * been introduced, this stamps `submitted_at` itself (`submitted_by = 'auto'`,
 * to keep it distinguishable from a real submission) and the case joins the
 * normal working set on the same tick. Every step then runs as it always has
 * -- including the curriculum's hold, which is the one thing this cannot
 * supply: the subject is only ever chosen in the dashboard, so an auto-fired
 * case completes everything else and stops just short of DONE.
 *
 * The PATCH is filtered on `submitted_at=is.null`, so a real submission landing
 * in between wins and this writes nothing.
 *
 * Returns the ids it fired, for the log.
 */
export async function autoSubmitReady(): Promise<string[]> {
  const params = new URLSearchParams();
  params.set('select', 'case_id,project_title,project_description,group_cases!inner(mentor_intro_sent_at,operations_stopped_at)');
  params.set('submitted_at', 'is.null');
  params.set('status', 'in.(PENDING,FAILED)');
  params.set('project_title', 'not.is.null');
  params.set('project_description', 'not.is.null');
  // The two case-side conditions: introduced, and not stopped.
  params.set('group_cases.mentor_intro_sent_at', 'not.is.null');
  params.set('group_cases.operations_stopped_at', 'is.null');

  type Row = Pick<ProjectSetupRow, 'case_id' | 'project_title' | 'project_description'>;
  const rows = await call<Row[]>('GET', `/project_setups?${params}`);

  const fired: string[] = [];
  for (const row of rows) {
    // `not.is.null` does not exclude the empty string a cleared cell leaves
    // behind, and neither half is really there if it is blank.
    if (!row.project_title?.trim() || !row.project_description?.trim()) continue;

    const now = new Date().toISOString();
    const patched = await call<ProjectSetupRow[]>(
      'PATCH',
      `/project_setups?case_id=eq.${encodeURIComponent(row.case_id)}&submitted_at=is.null`,
      {
        body: { submitted_at: now, submitted_by: 'auto', updated_at: now },
        prefer: 'return=representation',
      }
    );
    if (patched[0]) fired.push(row.case_id);
  }
  return fired;
}

export interface SetupPatch {
  status?: SetupStatus;
  stepWhatsapp?: StepStatus;
  stepWhatsappDriveLink?: StepStatus;
  stepSync?: StepStatus;
  stepDrive?: StepStatus;
  stepMentorAccess?: StepStatus;
  stepCurriculum?: StepStatus;
  stepCosmicStudent?: StepStatus;
  stepCosmicProject?: StepStatus;
  stepCosmicSyncGroup?: StepStatus;
  driveFolderId?: string | null;
  driveFolderUrl?: string | null;
  cosmicStudentId?: string | null;
  cosmicUserId?: string | null;
  cosmicProjectId?: string | null;
  attempts?: number;
  lastError?: string | null;
  lastRunAt?: Date | null;
  completedAt?: Date | null;
  appliedRevision?: number;
}

export async function updateSetup(
  caseId: string,
  patch: SetupPatch
): Promise<ProjectSetup> {
  const body: Record<string, unknown> = { updated_at: new Date().toISOString() };
  const set = (column: string, value: unknown) => {
    if (value !== undefined) {
      body[column] = value instanceof Date ? value.toISOString() : value;
    }
  };

  set('status', patch.status);
  set('step_whatsapp', patch.stepWhatsapp);
  set('step_whatsapp_drive_link', patch.stepWhatsappDriveLink);
  set('step_sync', patch.stepSync);
  set('step_drive', patch.stepDrive);
  set('step_mentor_access', patch.stepMentorAccess);
  set('step_curriculum', patch.stepCurriculum);
  set('step_cosmic_student', patch.stepCosmicStudent);
  set('step_cosmic_project', patch.stepCosmicProject);
  set('step_cosmic_sync_group', patch.stepCosmicSyncGroup);
  set('drive_folder_id', patch.driveFolderId);
  set('drive_folder_url', patch.driveFolderUrl);
  set('cosmic_student_id', patch.cosmicStudentId);
  set('cosmic_user_id', patch.cosmicUserId);
  set('cosmic_project_id', patch.cosmicProjectId);
  set('attempts', patch.attempts);
  set('last_error', patch.lastError);
  set('last_run_at', patch.lastRunAt);
  set('completed_at', patch.completedAt);
  set('applied_revision', patch.appliedRevision);

  const rows = await call<ProjectSetupRow[]>(
    'PATCH',
    `/project_setups?case_id=eq.${encodeURIComponent(caseId)}`,
    { body, prefer: 'return=representation' }
  );
  const row = rows[0];
  if (!row) throw new DbError(`project_setups ${caseId} not found`, 404, rows);
  return toSetup(row);
}

/**
 * Claim a case for this run: flip PENDING/FAILED -> RUNNING and bump attempts,
 * but only if it is still PENDING or FAILED. The status filter in the PATCH
 * makes this a compare-and-set, so if two ticks (or two replicas) race, only
 * one gets a row back and the other sees none -- that one skips the case.
 * Returns the claimed row, or null if someone else already claimed it.
 */
export async function claimForRun(
  caseId: string,
  attempts: number
): Promise<ProjectSetup | null> {
  const rows = await call<ProjectSetupRow[]>(
    'PATCH',
    `/project_setups?case_id=eq.${encodeURIComponent(caseId)}&status=in.(PENDING,FAILED)`,
    {
      body: {
        status: 'RUNNING',
        attempts: attempts + 1,
        last_run_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      },
      prefer: 'return=representation',
    }
  );
  return rows[0] ? toSetup(rows[0]) : null;
}

/** Cheapest query that proves the API, the key and the tables all work. */
export async function ping(): Promise<void> {
  await call('GET', '/project_setups?select=case_id&limit=1');
}
