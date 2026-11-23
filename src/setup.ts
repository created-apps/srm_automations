import * as db from './db';
import type { GroupCase, ProjectSetup, StepStatus } from './db';
import * as periskope from './periskope';
import * as drive from './drive';
import * as sync from './sync';
import * as cosmic from './cosmic';
import * as slack from './slack';
import { config } from './config';

/**
 * Run the Stage 5 steps for one case, in order, resuming from wherever a
 * previous attempt got to. A step that throws stops the run: its status is
 * recorded FAILED, the case is left FAILED, and the cron retries it next tick
 * (up to SETUP_MAX_ATTEMPTS). A step that returns "skip" is a deliberate no-op.
 *
 * ## Two gates, not one
 *
 * The steps no longer all wait for the same thing. Naming the WhatsApp group
 * and giving it a description only needs the project details, which arrive
 * from the dashboard or the intake sheet as soon as the brainstorm is done --
 * often well before a mentor exists. Everything else (the Drive folder, the
 * SYNC membership, the mentor's access, COSMIC) genuinely needs the mentor, so
 * those steps wait for the introduction to have gone out.
 *
 * A step whose gate isn't open is BLOCKED: it stays PENDING, the run stops
 * there without being a failure, and the case is picked up again next tick.
 * Blocking never burns a retry -- waiting for a mentor is not a failed attempt.
 *
 * The Drive link belongs in the group description but the folder doesn't exist
 * until the mentor gate opens, so the WhatsApp work is two steps: the details
 * now, the link appended after.
 */

const PLACEHOLDER_SUFFIX = ': Custom Project';

type StepOutcome =
  | { status: Extract<StepStatus, 'OK' | 'SKIPPED'>; note?: string }
  /** Not now, not a failure: leave the step PENDING and stop the run. */
  | { status: 'BLOCKED'; note: string };

/**
 * The WhatsApp group name after applying the project title.
 *
 * Normally only the "...: Custom Project" placeholder is rewritten -- a group
 * that already carries a real project name is left alone, because renaming a
 * family's chat unprompted is worse than a title being slightly stale.
 *
 * `force` is the exception: the details were edited after this case had
 * already been set up, which is someone explicitly correcting the name. Then
 * the part after the first ": " is replaced, keeping whatever prefix the group
 * was created with.
 */
function nextGroupName(
  groupName: string,
  projectTitle: string,
  force: boolean
): string | null {
  if (groupName.toLowerCase().endsWith(PLACEHOLDER_SUFFIX.toLowerCase())) {
    return groupName.slice(0, groupName.length - PLACEHOLDER_SUFFIX.length) + `: ${projectTitle}`;
  }

  if (force) {
    const separator = groupName.indexOf(': ');
    const renamed =
      separator === -1
        ? `${groupName}: ${projectTitle}`
        : `${groupName.slice(0, separator)}: ${projectTitle}`;
    return renamed === groupName ? null : renamed;
  }

  return null; // a real project name is already there -- leave the title alone
}

/** Has the mentor actually been introduced to the family? */
function mentorReady(c: GroupCase): boolean {
  return c.mentorIntroSentAt !== null;
}

const WAITING_FOR_MENTOR = 'waiting for the mentor introduction';

// --- individual steps ------------------------------------------------------

/**
 * The group description: the project description, then the Drive link.
 *
 * One composer for both WhatsApp steps, so whichever runs last writes the same
 * text rather than one of them dropping what the other put there. The folder
 * usually exists before either runs -- intake makes it with the group -- but
 * on a case whose folder was made later, at the mentor gate, the link is
 * simply absent from the first write and present in the second.
 */
function groupDescription(s: ProjectSetup): string {
  const parts: string[] = [];
  const description = (s.projectDescription ?? '').trim();
  if (description) parts.push(description);
  if (s.driveFolderUrl) parts.push(`Project Drive: ${s.driveFolderUrl}`);
  return parts.join('\n\n');
}

/**
 * Step 1 -- the group's name and description, as soon as the details exist.
 *
 * Runs before any mentor is assigned, so the description carries the project
 * text only; the Drive link is appended later by stepWhatsappDriveLink.
 */
async function stepWhatsapp(c: GroupCase, s: ProjectSetup): Promise<StepOutcome> {
  const title = (s.projectTitle ?? '').trim();
  const description = groupDescription(s);

  // An edit after this case was already set up: the rename rule is relaxed so
  // the correction actually reaches the group.
  const force = s.appliedRevision < s.detailsRevision && s.appliedRevision > 0;

  const newName = title ? nextGroupName(c.groupName, title, force) : null;
  const settings: { name?: string; description?: string } = {};
  if (newName) settings.name = newName;
  if (description) settings.description = description;

  if (Object.keys(settings).length === 0) {
    return { status: 'SKIPPED', note: 'nothing to change (no new title/description)' };
  }
  await periskope.updateGroupSettings(c.chatId, settings);
  return { status: 'OK' };
}

/**
 * Step 5 -- put the student's Drive folder in the group description.
 *
 * Separate from step 1 only because the folder doesn't exist until the mentor
 * gate opens. Rewrites the whole description rather than appending to whatever
 * is there, so a re-run can't stack up duplicate links.
 */
async function stepWhatsappDriveLink(c: GroupCase, s: ProjectSetup): Promise<StepOutcome> {
  if (!mentorReady(c)) return { status: 'BLOCKED', note: WAITING_FOR_MENTOR };
  if (!s.driveFolderUrl) {
    return { status: 'SKIPPED', note: 'no Drive folder to link' };
  }

  await periskope.updateGroupSettings(c.chatId, { description: groupDescription(s) });
  return { status: 'OK' };
}

async function stepSync(c: GroupCase): Promise<StepOutcome> {
  if (!mentorReady(c)) return { status: 'BLOCKED', note: WAITING_FOR_MENTOR };
  const result = await sync.linkMentor(c);
  return result.skipped ? { status: 'SKIPPED', note: result.reason } : { status: 'OK' };
}

async function ensureDrive(c: GroupCase, s: ProjectSetup): Promise<StepOutcome> {
  // Reuse the folder from a prior attempt so a retry never makes a second one.
  let folderId = s.driveFolderId;
  if (!folderId) {
    // Folder is named for the student.
    const name = c.studentName.trim() || c.groupName;
    const created = await drive.createFolder(name, drive.studentsParentId());
    folderId = created.id;
    // Persist the folder before granting, so a crash between the two still
    // leaves the id on record for the retry.
    await db.updateSetup(s.caseId, {
      driveFolderId: created.id,
      driveFolderUrl: created.url,
    });
  }

  const notes: string[] = [];
  const grantees: Array<[label: string, email: string | null]> = [
    ['student', c.studentEmail],
    ['parent', c.parentEmail],
    // The standing ops list. Re-granting someone the same role is accepted by
    // Drive, so this is harmless on a folder intake already shared.
    ...config.google.autoAccessEmails.map(
      (email) => ['team', email] as [string, string | null]
    ),
  ];
  for (const [label, email] of grantees) {
    if (!email || !email.trim()) {
      notes.push(`no ${label} email -- access not granted`);
      continue;
    }
    try {
      await drive.grantAccess(folderId, email.trim(), 'writer');
    } catch (err) {
      // A non-Google address can't be shared with -- note it and move on
      // rather than failing the whole step (and everything after it).
      if (
        err instanceof drive.DriveError &&
        err.status === 403 &&
        JSON.stringify(err.details).includes('cannotInviteNonGoogleUser')
      ) {
        notes.push(`${label} ${email.trim()} has no Google account -- access not granted`);
      } else {
        throw err;
      }
    }
  }
  return { status: 'OK', note: notes.join('; ') || undefined };
}

async function stepDrive(c: GroupCase, s: ProjectSetup): Promise<StepOutcome> {
  if (!mentorReady(c)) return { status: 'BLOCKED', note: WAITING_FOR_MENTOR };
  return ensureDrive(c, s);
}

/**
 * Step 4 -- give the mentor editor access to the student's Drive folder.
 *
 * Its own step rather than a third grantee inside stepDrive, because it is the
 * only part of that work that needs the mentor resolved. Folded in there, a
 * mentor whose name doesn't match SYNC would either fail the Drive step (and
 * with it the WhatsApp, curriculum and COSMIC steps that don't care about
 * mentors at all) or be marked done and never retried once the name was fixed.
 *
 * It runs after stepSync deliberately: the same resolution failure surfaces
 * there first, with a message that says exactly what is wrong with the name.
 */
async function stepMentorAccess(c: GroupCase, s: ProjectSetup): Promise<StepOutcome> {
  if (!mentorReady(c)) return { status: 'BLOCKED', note: WAITING_FOR_MENTOR };
  if (!sync.syncConfigured()) {
    return { status: 'SKIPPED', note: 'SYNC not configured -- no mentor email to grant' };
  }
  if (!s.driveFolderId) {
    throw new Error('mentor access: no Drive folder (step 2 must run first)');
  }

  const mentor = await sync.resolveMentorForCase(c);
  if (!mentor) {
    throw new Error(`mentor access: ${await sync.explainUnresolved(c)}`);
  }

  const email = (mentor.email ?? '').trim();
  if (!email) {
    // Nothing to grant to, and nothing a retry would fix. Skipped with a note
    // rather than failed, so the rest of the setup still completes.
    return {
      status: 'SKIPPED',
      note: `SYNC has no email for ${mentor.name} -- Drive access not granted`,
    };
  }

  try {
    await drive.grantAccess(s.driveFolderId, email, 'writer');
  } catch (err) {
    // Same allowance the family's addresses get: a non-Google address can't be
    // shared with, and no number of retries changes that.
    if (
      err instanceof drive.DriveError &&
      err.status === 403 &&
      JSON.stringify(err.details).includes('cannotInviteNonGoogleUser')
    ) {
      return {
        status: 'SKIPPED',
        note: `${email} has no Google account -- Drive access not granted`,
      };
    }
    throw err;
  }
  return { status: 'OK', note: `granted ${email} editor access` };
}

async function stepCurriculum(c: GroupCase, s: ProjectSetup): Promise<StepOutcome> {
  if (!mentorReady(c)) return { status: 'BLOCKED', note: WAITING_FOR_MENTOR };

  const subject = (s.curriculumSubject ?? '').trim();
  if (subject.toUpperCase() === 'NONE') {
    return { status: 'SKIPPED', note: 'curriculum explicitly set to NONE' };
  }
  // The subject is only ever chosen in the dashboard, so a case submitted from
  // the intake sheet arrives without one. That is a hold, not a skip: the case
  // stops just short of DONE and stays visible as unfinished until somebody
  // picks a subject, rather than quietly completing with no curriculum copied.
  if (!subject) {
    return { status: 'BLOCKED', note: 'no curriculum subject chosen yet (dashboard)' };
  }
  if (!s.driveFolderId) {
    throw new Error('curriculum: no Drive folder to copy into (step 3 must run first)');
  }

  // Case-insensitive lookup of the subject -> template folder mapping.
  const entry = Object.entries(config.google.templates).find(
    ([label]) => label.toLowerCase() === subject.toLowerCase()
  );
  if (!entry) {
    throw new Error(
      `curriculum: no template folder configured for subject "${subject}" ` +
        `(add it to CURRICULUM_TEMPLATES_JSON)`
    );
  }
  await drive.copyFolderContents(entry[1], s.driveFolderId);
  return { status: 'OK', note: `copied "${entry[0]}" curriculum` };
}

/** Split a single name: last whitespace token is the surname, the rest given. */
function splitName(full: string): { first: string; last: string } {
  const parts = full.trim().split(/\s+/).filter(Boolean);
  if (parts.length <= 1) return { first: parts[0] ?? full.trim() ?? '-', last: '-' };
  return { first: parts.slice(0, -1).join(' '), last: parts[parts.length - 1]! };
}

/**
 * COMP_AI country from a phone's dialling code. Phones are stored as bare
 * digits with the country code (WhatsApp format), e.g. 919876543210.
 * Note +1 also covers Canada, which therefore comes out as USA.
 */
function compAiCountryFromPhone(phone: string): cosmic.CompAiCountry {
  const digits = phone.replace(/\D/g, '');
  if (digits.length === 12 && digits.startsWith('91')) return 'India';
  if (digits.length === 11 && digits.startsWith('1')) return 'USA';
  if (digits.length <= 10) {
    throw new Error(`cosmic student: phone ${phone} has no country code, can't tell the COMP_AI country`);
  }
  return 'Worldwide';
}

function credentialsMessage(studentName: string, c: cosmic.Credentials): string {
  return (
    `Hi ${studentName}! For your project, we will be using the Learning Management System\n` +
    `Login at ${config.cosmic.loginUrl}\n` +
    `Email: ${c.email}\n` +
    `Password: ${c.password}\n` +
    `Please change your password after your first login.`
  );
}

interface CosmicStudentStep {
  outcome: StepOutcome;
  credentials?: cosmic.Credentials;
}

/** Create/resolve the COSMIC student. Credential delivery can be delayed until
 * the POC project exists, which is the new-student bootstrap contract. */
async function ensureCosmicStudent(
  c: GroupCase,
  s: ProjectSetup,
  deliverCredentials: boolean
): Promise<CosmicStudentStep> {
  if (!cosmic.cosmicConfigured()) {
    return { outcome: { status: 'SKIPPED', note: 'COSMIC not configured' } };
  }
  if (s.cosmicStudentId) {
    return {
      outcome: { status: 'OK' },
      ...(!deliverCredentials && s.pendingCosmicCredentials
        ? { credentials: s.pendingCosmicCredentials }
        : {}),
    };
  }

  const email = (c.studentEmail ?? '').trim();
  if (!email) throw new Error('cosmic student: case has no student email');

  // COMP_AI country is compulsory; derive it from the student's phone, else the parent's.
  const phoneForCountry = (c.studentPhone ?? '').trim() || (c.parentPhone ?? '').trim();
  if (!phoneForCountry) throw new Error('cosmic student: case has no phone to derive the COMP_AI country from');
  const compAiCountry = compAiCountryFromPhone(phoneForCountry);

  if (!c.programCode) throw new Error('cosmic student: programme has not been selected');

  const { first, last } = splitName(c.studentName);
  const themes =
    s.curriculumSubject && s.curriculumSubject.toUpperCase() !== 'NONE'
      ? [s.curriculumSubject]
      : [];
  const payload: cosmic.StudentCreateInput = {
    first_name: first,
    last_name: last,
    email,
    comp_ai_country: compAiCountry,
    program_enrolled: c.programCode,
    ...(c.studentPhone ? { phone: c.studentPhone, whatsapp_phone: c.studentPhone } : {}),
    ...(c.parentName ? { parent_name: c.parentName } : {}),
    ...(c.parentEmail ? { parent_email: c.parentEmail } : {}),
    ...(c.parentPhone ? { parent_phone: c.parentPhone } : {}),
    ...(themes.length ? { project_themes_interested: themes, field_interest_tags: themes } : {}),
  };

  let created: cosmic.CreatedStudent;
  try {
    created = await cosmic.createStudent(payload);
  } catch (err) {
    // A duplicate-email conflict has two shapes:
    //  1. The email is an existing STUDENT -> recover their id so the project
    //     can still be created; the one-time password isn't retrievable, so it
    //     is not re-sent.
    //  2. The email belongs to a NON-student user (mentor/staff/counsellor) ->
    //     there is no student to attach a project to, so skip the COSMIC steps
    //     (self-heal + Slack) rather than failing the whole pipeline.
    const isDuplicate =
      err instanceof cosmic.CosmicError &&
      err.status === 400 &&
      /already exists|duplicate key|users_email_key|23505/i.test(
        `${JSON.stringify(err.details)} ${err.message}`
      );
    if (isDuplicate) {
      const existing = await cosmic.findStudentByEmail(email);
      if (existing) {
        await db.updateSetup(s.caseId, {
          cosmicStudentId: existing.id,
          cosmicUserId: existing.user_id || null,
        });
        console.log(`[${s.caseId}] COSMIC student ${email} already exists -- credentials unchanged`);
        return { outcome: { status: 'OK', note: 'student already existed in COSMIC (credentials not re-sent)' } };
      }
      // Email is taken by a non-student user: nothing to attach. Skip the two
      // downstream COSMIC steps too, so the case still finishes DONE.
      await db.updateSetup(s.caseId, {
        stepCosmicProject: 'SKIPPED',
        stepCosmicSyncGroup: 'SKIPPED',
        stepCosmicPocProject: 'SKIPPED',
      });
      await slack.postNote(
        `:warning: COSMIC account skipped for ${c.studentName}: ${email} already belongs to a ` +
          `non-student COSMIC user (mentor/staff/counsellor). No student or project was created.`
      );
      return { outcome: { status: 'SKIPPED', note: `${email} belongs to a non-student COSMIC user` } };
    }
    throw err;
  }

  // Persist ids before the (best-effort) credentials send.
  await db.updateSetup(s.caseId, {
    cosmicStudentId: created.id,
    cosmicUserId: created.user_id,
    ...(!deliverCredentials && created.credentials
      ? { pendingCosmicCredentials: created.credentials }
      : {}),
  });

  // Approve/verify the account so the student can actually log in.
  await cosmic.verifyUser(created.user_id);

  if (deliverCredentials && created.credentials) {
    try {
      await periskope.sendMessage(c.chatId, credentialsMessage(c.studentName, created.credentials));
    } catch (err) {
      // Never lose a one-time password: fall back to Slack.
      const m = err instanceof Error ? err.message : String(err);
      await slack.postNote(
        `:key: COSMIC login for ${c.studentName} (WhatsApp send failed: ${m}) -- ` +
          `username: ${created.credentials.username}, password: ${created.credentials.password}`
      );
      return { outcome: { status: 'OK', note: 'credentials delivered to Slack (WhatsApp send failed)' } };
    }
  }
  return { outcome: { status: 'OK' }, credentials: created.credentials };
}

async function stepCosmicStudent(c: GroupCase, s: ProjectSetup): Promise<StepOutcome> {
  // New accounts belong to the early POC lane: that is what guarantees the
  // one-time password is not sent until the POC project exists. The regular
  // lane only observes the completed/skipped result.
  if (!c.pocOwnerId || (s.stepCosmicPocProject !== 'OK' && s.stepCosmicPocProject !== 'SKIPPED')) {
    return { status: 'BLOCKED', note: 'waiting for POC owner and POC project bootstrap' };
  }
  if (s.cosmicStudentId) return { status: 'OK' };
  return { status: 'SKIPPED', note: 'POC bootstrap did not create a COSMIC student' };
}

/** Step 6 -- create the project in COSMIC, linked to the student and mentor. */
async function stepCosmicProject(c: GroupCase, s: ProjectSetup): Promise<StepOutcome> {
  if (!mentorReady(c)) return { status: 'BLOCKED', note: WAITING_FOR_MENTOR };
  if (c.programCode === 'CMP') return { status: 'SKIPPED', note: 'CMP has no regular mentor project' };
  if (!c.pocOwnerId) return { status: 'BLOCKED', note: 'waiting for POC owner' };
  if (!(s.projectTitle ?? '').trim() || !(s.projectDescription ?? '').trim()) {
    return { status: 'BLOCKED', note: 'waiting for project title and description' };
  }
  if (!cosmic.cosmicConfigured()) return { status: 'SKIPPED', note: 'COSMIC not configured' };
  if (s.cosmicProjectId) {
    // A retry may resume after the project id was saved but before the step
    // completed. Re-apply the authoritative case owner so such rows are not
    // left invisible on the POC dashboard.
    await cosmic.setProjectPocOwner(s.cosmicProjectId, c.pocOwnerId);
    return { status: 'OK' };
  }
  if (!s.cosmicStudentId) throw new Error('cosmic project: no student id (student step must run first)');

  const title = (s.projectTitle ?? '').trim() || c.groupName;

  // Resolve the COSMIC mentor id: mentor email via SYNC, then match in COSMIC
  // (falling back to a name match).
  let mentorId: string | undefined;
  const mentorName = (c.mentorName ?? '').trim();
  if (mentorName) {
    const resolved = await sync.resolveMentorForCase(c).catch(() => null);
    mentorId = (await cosmic.findMentorId({ email: resolved?.email ?? null, name: mentorName })) ?? undefined;
  }

  // COSMIC cannot create a project without a mentor -- a missing mentor_id is
  // stringified to "None" and rejected as an invalid uuid. Fail with an
  // actionable message rather than sending that request; once the mentor exists
  // in COSMIC (matching name or email) this step succeeds on the next retry.
  if (!mentorId) {
    throw new Error(
      `cosmic project: no COSMIC mentor matches "${mentorName || '(no mentor on case)'}" ` +
        `-- create the mentor in COSMIC with a matching name or email, then this retries.`
    );
  }

  const start = new Date();
  const end = new Date(start);
  end.setDate(end.getDate() + config.cosmic.durationWeeks * 7);
  const ymd = (d: Date) => d.toISOString().slice(0, 10);

  const created = await cosmic.createProject({
    mentor_id: mentorId,
    student_id: s.cosmicStudentId,
    poc_owner_id: c.pocOwnerId,
    project_name: title,
    ...(s.projectDescription ? { project_description: s.projectDescription } : {}),
    project_track: c.programCode === 'RBP' ? 'product_research' : 'product',
    status: 'not_started',
    start_date: ymd(start),
    end_date: ymd(end),
  });
  await db.updateSetup(s.caseId, { cosmicProjectId: created.id });
  return { status: 'OK' };
}

/** Step 7 -- link the COSMIC project to its SYNC group (sets sync_group_id). */
async function stepCosmicSyncGroup(c: GroupCase, s: ProjectSetup): Promise<StepOutcome> {
  if (!mentorReady(c)) return { status: 'BLOCKED', note: WAITING_FOR_MENTOR };
  if (!cosmic.cosmicConfigured()) return { status: 'SKIPPED', note: 'COSMIC not configured' };
  if (!sync.syncConfigured()) return { status: 'SKIPPED', note: 'SYNC not configured -- no group id to link' };
  if (!s.cosmicProjectId) throw new Error('cosmic sync-group: no project id (project step must run first)');

  const groupId = await sync.findGroupIdByJid(c.chatId);
  if (!groupId) throw new Error(`cosmic sync-group: no SYNC group for JID ${c.chatId}`);

  await cosmic.setProjectSyncGroup(s.cosmicProjectId, groupId, c.chatId);
  return { status: 'OK' };
}

async function deliverCredentialsAfterPocProject(
  c: GroupCase,
  credentials: cosmic.Credentials
): Promise<void> {
  try {
    await periskope.sendMessage(c.chatId, credentialsMessage(c.studentName, credentials));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await slack.postNote(
      `:key: COSMIC login for ${c.studentName} (WhatsApp send failed: ${message}) -- ` +
        `username: ${credentials.username}, password: ${credentials.password}`
    );
  }
}

/**
 * The early, programme-independent POC bootstrap. It runs after the family is
 * welcomed and a POC is chosen, without waiting for a regular mentor or the
 * real project's title/description.
 */
export async function runPocBootstrap(caseId: string): Promise<void> {
  const c = await db.findCaseById(caseId);
  let s = await db.findSetup(caseId);
  if (!c || !s) throw new Error(`POC bootstrap state missing for ${caseId}`);
  if (!c.programCode || !c.pocOwnerId || c.stage === 'AWAITING_JOIN') {
    await db.updateSetup(caseId, { pocStatus: 'PENDING', pocAttempts: 0 });
    return;
  }
  if (c.operationsStoppedAt) {
    await db.updateSetup(caseId, { pocStatus: 'PENDING' });
    return;
  }

  let credentials: cosmic.Credentials | undefined;
  try {
    if (s.stepPocDrive !== 'OK' && s.stepPocDrive !== 'SKIPPED') {
      const outcome = await ensureDrive(c, s);
      if (outcome.status === 'BLOCKED') throw new Error(outcome.note);
      s = await db.updateSetup(caseId, { stepPocDrive: outcome.status, lastError: null });
    }

    if (s.stepCosmicStudent !== 'OK' && s.stepCosmicStudent !== 'SKIPPED') {
      const student = await ensureCosmicStudent(c, s, false);
      credentials = student.credentials;
      if (student.outcome.status === 'BLOCKED') throw new Error(student.outcome.note);
      s = await db.updateSetup(caseId, {
        stepCosmicStudent: student.outcome.status,
        ...(student.outcome.status === 'SKIPPED'
          ? { stepCosmicPocProject: 'SKIPPED' as const }
          : {}),
        lastError: null,
      });
    }

    if (s.stepCosmicPocProject !== 'OK' && s.stepCosmicPocProject !== 'SKIPPED') {
      if (!s.cosmicStudentId) throw new Error('POC project: no COSMIC student id');
      if (!sync.syncConfigured()) throw new Error('POC project: SYNC is not configured');
      const groupId = await sync.findGroupIdByJid(c.chatId);
      if (!groupId) throw new Error(`POC project: no SYNC group for JID ${c.chatId}`);

      let project: { id: string };
      if (c.programCode === 'CMP') {
        // New CMP engagements are ordinary projects (with no mentor or
        // milestones). Keep recognizing an existing legacy poc_projects row
        // so this rollout does not migrate or duplicate old students.
        const existing = await cosmic.findCmpProject(
          s.cosmicStudentId,
          groupId,
          c.pocOwnerId
        );
        const legacy = existing
          ? null
          : await cosmic.findPocProject(s.cosmicStudentId, groupId);

        if (legacy) {
          if (legacy.poc_owner_id && legacy.poc_owner_id !== c.pocOwnerId) {
            throw new Error(
              `Legacy CMP POC project ${legacy.id} belongs to a different Cosmic POC owner`
            );
          }
          if (!legacy.poc_owner_id) {
            await cosmic.setPocProjectOwner(legacy.id, c.pocOwnerId);
          }
          project = legacy;
        } else {
          if (existing?.poc_owner_id && existing.poc_owner_id !== c.pocOwnerId) {
            throw new Error(
              `CMP project ${existing.id} belongs to a different Cosmic POC owner`
            );
          }
          project = existing ?? await cosmic.createProject({
            student_id: s.cosmicStudentId,
            poc_owner_id: c.pocOwnerId,
            project_name: `CreatED X ${c.studentName}: Custom Project`,
            project_track: 'product',
            status: 'not_started',
          });

          // Persist before linking. If the SYNC check fails or this process is
          // restarted, the next run reuses the same unlinked project.
          if (s.cosmicPocProjectId !== project.id) {
            s = await db.updateSetup(caseId, { cosmicPocProjectId: project.id });
          }
          if (!existing?.poc_owner_id) {
            await cosmic.setProjectPocOwner(project.id, c.pocOwnerId);
          }
          if (existing?.sync_group_id !== groupId) {
            await cosmic.setProjectSyncGroup(project.id, groupId);
          }
        }
      } else {
        const existing = await cosmic.findPocProject(s.cosmicStudentId, groupId);
        if (existing?.poc_owner_id && existing.poc_owner_id !== c.pocOwnerId) {
          throw new Error(
            `POC project ${existing.id} already belongs to a different Cosmic POC owner`
          );
        }
        if (existing && !existing.poc_owner_id) {
          await cosmic.setPocProjectOwner(existing.id, c.pocOwnerId);
        }
        project = existing ?? await cosmic.createPocProject({
          poc_owner_id: c.pocOwnerId,
          student_id: s.cosmicStudentId,
          sync_group_id: groupId,
          project_name: `CreatED X ${c.studentName}: Custom Project`,
          project_track: c.programCode === 'RBP' ? 'product_research' : 'product',
        });
      }
      s = await db.updateSetup(caseId, {
        cosmicPocProjectId: project.id,
        stepCosmicPocProject: 'OK',
        lastError: null,
      });
    }

    credentials = credentials ?? s.pendingCosmicCredentials ?? undefined;
    if (s.stepCosmicPocProject === 'OK' && credentials && !s.cosmicCredentialsDeliveredAt) {
      await deliverCredentialsAfterPocProject(c, credentials);
      s = await db.updateSetup(caseId, {
        pendingCosmicCredentials: null,
        cosmicCredentialsDeliveredAt: new Date(),
        lastError: null,
      });
    }

    if (s.stepPocDriveAccess !== 'OK' && s.stepPocDriveAccess !== 'SKIPPED') {
      if (!s.driveFolderId) throw new Error('POC Drive access: no Drive folder');
      const owner = await cosmic.findPocOwner(c.pocOwnerId);
      if (!owner) throw new Error(`POC Drive access: Cosmic owner ${c.pocOwnerId} not found`);
      const actualEmail = (owner.actualEmail ?? '').trim();
      if (!actualEmail) {
        throw new Error(`POC Drive access: ${owner.name} has no actual_email`);
      }
      await drive.grantAccess(s.driveFolderId, actualEmail, 'writer');
      s = await db.updateSetup(caseId, { stepPocDriveAccess: 'OK', lastError: null });
    }

    await db.updateSetup(caseId, { pocStatus: 'DONE', pocAttempts: 0, lastError: null });
    console.log(`[${caseId}] POC bootstrap DONE (${c.programCode})`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await db.updateSetup(caseId, { pocStatus: 'FAILED', lastError: `poc bootstrap: ${message}` });
    await slack.postNote(`:warning: POC bootstrap failed for <${slack.caseLink(caseId)}> (${c.studentName}): ${message}`);
  }
}

/** Apply an introduced RBP research mentor to Drive and the real Cosmic project. */
export async function runResearchMentorSetup(caseId: string): Promise<void> {
  const c = await db.findCaseById(caseId);
  let s = await db.findSetup(caseId);
  if (!c || !s) throw new Error(`research mentor state missing for ${caseId}`);
  if (c.programCode !== 'RBP' || !c.researchMentorIntroSentAt || !c.researchMentorSyncUserId) {
    await db.updateSetup(caseId, { researchStatus: 'PENDING', researchAttempts: 0 });
    return;
  }

  try {
    const mentor = await sync.findMentorById(c.researchMentorSyncUserId);
    if (!mentor) throw new Error(`research mentor ${c.researchMentorSyncUserId} not found on SYNC`);

    if (s.stepResearchDriveAccess !== 'OK') {
      if (!s.driveFolderId) throw new Error('research mentor Drive access: no Drive folder');
      if (!mentor.email) throw new Error(`${mentor.name} has no email for Drive access`);
      await drive.grantAccess(s.driveFolderId, mentor.email, 'writer');
      if (
        c.previousResearchMentorSyncUserId &&
        c.previousResearchMentorSyncUserId !== c.mentorSyncUserId &&
        c.previousResearchMentorSyncUserId !== c.researchMentorSyncUserId
      ) {
        const previous = await sync.findMentorById(c.previousResearchMentorSyncUserId);
        if (previous?.email) await drive.revokeAccess(s.driveFolderId, previous.email);
      }
      s = await db.updateSetup(caseId, { stepResearchDriveAccess: 'OK', lastError: null });
    }

    if (s.stepCosmicResearchMentor !== 'OK') {
      if (!s.cosmicProjectId) throw new Error('research mentor: real Cosmic project does not exist yet');
      const cosmicMentorId = await cosmic.findMentorId({ email: mentor.email, name: mentor.name });
      if (!cosmicMentorId) throw new Error(`no Cosmic mentor matches ${mentor.name}`);
      await cosmic.replaceProjectMentor(s.cosmicProjectId, cosmicMentorId);
      s = await db.updateSetup(caseId, {
        stepCosmicResearchMentor: 'OK',
        appliedResearchMentorSyncUserId: c.researchMentorSyncUserId,
        lastError: null,
      });
    }

    await db.updateSetup(caseId, { researchStatus: 'DONE', researchAttempts: 0, lastError: null });
    console.log(`[${caseId}] RBP research mentor applied: ${mentor.name}`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await db.updateSetup(caseId, { researchStatus: 'FAILED', lastError: `research mentor: ${message}` });
    await slack.postNote(`:warning: Research mentor setup failed for <${slack.caseLink(caseId)}> (${c.studentName}): ${message}`);
  }
}

// --- orchestration ---------------------------------------------------------

interface StepDef {
  key: string;
  column: keyof db.SetupPatch;
  current: (s: ProjectSetup) => StepStatus;
  run: (c: GroupCase, s: ProjectSetup) => Promise<StepOutcome>;
}

/**
 * Order matters in three places:
 *  - whatsapp is first and ungated, so the group is named as soon as the
 *    details land;
 *  - drive precedes mentor_access and whatsapp_drive_link, which both need the
 *    folder, and sync precedes mentor_access so a bad mentor name is reported
 *    by the step whose message explains it;
 *  - curriculum is last, because it is the one step that can hold on something
 *    only a human supplies, and holding it must not delay COSMIC.
 */
const STEPS: StepDef[] = [
  { key: 'whatsapp', column: 'stepWhatsapp', current: (s) => s.stepWhatsapp, run: (c, s) => stepWhatsapp(c, s) },
  { key: 'drive', column: 'stepDrive', current: (s) => s.stepDrive, run: (c, s) => stepDrive(c, s) },
  { key: 'sync', column: 'stepSync', current: (s) => s.stepSync, run: (c) => stepSync(c) },
  { key: 'mentor_access', column: 'stepMentorAccess', current: (s) => s.stepMentorAccess, run: (c, s) => stepMentorAccess(c, s) },
  { key: 'whatsapp_drive_link', column: 'stepWhatsappDriveLink', current: (s) => s.stepWhatsappDriveLink, run: (c, s) => stepWhatsappDriveLink(c, s) },
  { key: 'cosmic_student', column: 'stepCosmicStudent', current: (s) => s.stepCosmicStudent, run: (c, s) => stepCosmicStudent(c, s) },
  { key: 'cosmic_project', column: 'stepCosmicProject', current: (s) => s.stepCosmicProject, run: (c, s) => stepCosmicProject(c, s) },
  { key: 'cosmic_sync_group', column: 'stepCosmicSyncGroup', current: (s) => s.stepCosmicSyncGroup, run: (c, s) => stepCosmicSyncGroup(c, s) },
  { key: 'curriculum', column: 'stepCurriculum', current: (s) => s.stepCurriculum, run: (c, s) => stepCurriculum(c, s) },
];

/**
 * Run (or resume) one case that has already been claimed (status RUNNING).
 * Returns nothing; all state is persisted.
 */
export async function runCase(caseId: string): Promise<void> {
  const groupCase = await db.findCaseById(caseId);
  if (!groupCase) throw new Error(`case ${caseId} vanished`);

  // Stopped between listRunnable and the claim above. Hand the row back as
  // PENDING rather than leaving it RUNNING or marking it FAILED: nothing went
  // wrong, and nothing ran. listRunnable will not offer it again while the
  // case is stopped, so PENDING is where it correctly comes to rest.
  if (groupCase.operationsStoppedAt) {
    await db.updateSetup(caseId, { status: 'PENDING' });
    console.log(`[${caseId}] operations stopped -- setup not run`);
    return;
  }

  // Re-read the setup so we act on the latest step statuses (and the folder id
  // a prior attempt may have saved).
  let setup = await db.findSetup(caseId);
  if (!setup) throw new Error(`project_setups ${caseId} vanished`);

  // SYNC's mentor list is cached for the duration of one case, so the three
  // steps that need the mentor share a single fetch. Cleared here rather than
  // at the end so a mentor added between ticks is picked up.
  sync.resetMentorCache();

  // Whether this run is re-applying an edit to a case that had already been
  // set up, rather than setting one up for the first time. Captured before the
  // loop: the WhatsApp step advances appliedRevision, so by the end of the run
  // the two revisions match and the distinction is gone.
  const isReapplication =
    setup.appliedRevision > 0 && setup.appliedRevision < setup.detailsRevision;

  // Details edited since the last run: re-open the WhatsApp step so the
  // correction reaches the group instead of being stranded on a case that
  // already finished. The Drive link step goes with it, since it rewrites the
  // same description.
  if (setup.appliedRevision < setup.detailsRevision && setup.stepWhatsapp !== 'PENDING') {
    setup = await db.updateSetup(caseId, {
      stepWhatsapp: 'PENDING',
      ...(setup.stepWhatsappDriveLink === 'OK' ? { stepWhatsappDriveLink: 'PENDING' as const } : {}),
    });
    console.log(
      `[${caseId}] project details changed (revision ${setup.appliedRevision} -> ` +
        `${setup.detailsRevision}), re-applying to WhatsApp`
    );
  }

  const blocked: string[] = [];
  let progressed = false;

  for (const step of STEPS) {
    if (step.current(setup) === 'OK' || step.current(setup) === 'SKIPPED') continue;

    try {
      const outcome = await step.run(groupCase, setup);

      if (outcome.status === 'BLOCKED') {
        // Not now, and not a failure. The step stays PENDING and the run stops
        // here -- everything after it either needs this step's output or is
        // waiting on the same thing.
        blocked.push(`${step.key}: ${outcome.note}`);
        break;
      }

      setup = await db.updateSetup(caseId, {
        [step.column]: outcome.status,
        lastError: null,
        // The group now reflects this revision of the details.
        ...(step.key === 'whatsapp' ? { appliedRevision: setup.detailsRevision } : {}),
      } as db.SetupPatch);
      progressed = true;
      if (outcome.note) console.log(`[${caseId}] ${step.key}: ${outcome.status} (${outcome.note})`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await db.updateSetup(caseId, {
        [step.column]: 'FAILED',
        status: 'FAILED',
        lastError: `${step.key}: ${message}`,
      } as db.SetupPatch);
      await slack.postNote(
        `:warning: Project setup failed at *${step.key}* for <${slack.caseLink(caseId)}> ` +
          `(${groupCase.studentName}): ${message}`
      );
      console.error(`[${caseId}] ${step.key} FAILED:`, message);
      return; // stop -- retried next tick
    }
  }

  if (blocked.length > 0) {
    // Back to PENDING for the next tick, and attempts reset: a case waiting on
    // a mentor or a curriculum choice must not exhaust its retry budget and
    // drop out of the working set for something that was never a failure.
    await db.updateSetup(caseId, {
      status: 'PENDING',
      attempts: 0,
      lastError: null,
    });
    // Only worth saying when something actually moved. A case waiting on a
    // mentor is re-examined every tick, and logging that each time would bury
    // everything else in the deploy logs.
    if (progressed) console.log(`[${caseId}] holding -- ${blocked.join('; ')}`);

    // Curriculum is the last step, so if it is the only thing holding, every
    // other part of the setup has just finished. That case never reaches DONE
    // and so never posts the completion note, which on an auto-fired case (no
    // dashboard submission, hence never a subject) would mean the work
    // completes in silence. Say it once -- `progressed` is only true on the
    // tick that finished the last step, so the following ticks stay quiet.
    if (progressed && blocked.length === 1 && blocked[0]!.startsWith('curriculum:')) {
      await slack.postNote(
        `:white_check_mark: Project setup complete for <${slack.caseLink(caseId)}> ` +
          `(${groupCase.studentName}), except the curriculum -- pick a subject in the ` +
          `dashboard and it will be copied in.` +
          (setup.driveFolderUrl ? ` Drive: ${setup.driveFolderUrl}` : '')
      );
    }
    return;
  }

  const done = await db.updateSetup(caseId, {
    status: 'DONE',
    completedAt: new Date(),
    lastError: null,
  });

  // A case that was already set up and has just had an edit re-applied is not
  // a completion, and saying so a second time reads as a duplicate of the
  // original -- the setup steps did not run again, only the group name and
  // description were rewritten. Report what actually happened instead.
  if (isReapplication) {
    await slack.postNote(
      `:pencil2: Project details updated for <${slack.caseLink(caseId)}> ` +
        `(${groupCase.studentName}) -- the WhatsApp group name and description ` +
        `have been rewritten. The rest of the setup was already done.`
    );
    console.log(`[${caseId}] details re-applied (revision ${done.appliedRevision})`);
    return;
  }

  const link = done.driveFolderUrl ? ` Drive: ${done.driveFolderUrl}` : '';
  await slack.postNote(
    `:white_check_mark: Project setup complete for <${slack.caseLink(caseId)}> ` +
      `(${groupCase.studentName}).${link}`
  );
  console.log(`[${caseId}] setup DONE`);
}

/**
 * One reconciliation pass: find ready cases, claim each (compare-and-set to
 * RUNNING), and run it. Claiming is what stops two ticks running the same case.
 */
export async function reconcileOnce(): Promise<{ ran: number }> {
  let ran = 0;

  const pocRunnable = await db.listPocBootstrapRunnable(config.setup.maxAttempts);
  for (const s of pocRunnable) {
    const claimed = await db.claimPocBootstrap(s.caseId, s.pocAttempts);
    if (!claimed) continue;
    await runPocBootstrap(s.caseId);
    ran++;
  }

  const researchRunnable = await db.listResearchRunnable(config.setup.maxAttempts);
  for (const s of researchRunnable) {
    const claimed = await db.claimResearchRun(s.caseId, s.researchAttempts);
    if (!claimed) continue;
    await runResearchMentorSetup(s.caseId);
    ran++;
  }

  // Before looking at the working set, let in the cases that are plainly ready
  // but that nobody submitted -- a complete title and description with the
  // mentor already introduced. They join the same pass; see db.autoSubmitReady.
  try {
    const fired = await db.autoSubmitReady();
    for (const caseId of fired) {
      console.log(`[${caseId}] auto-fired: details complete and mentor introduced`);
    }
  } catch (err) {
    // Never let this stop the cases that were submitted the ordinary way.
    console.error('auto-fire sweep threw:', err instanceof Error ? err.message : err);
  }

  const runnable = await db.listRunnable(config.setup.maxAttempts);
  for (const s of runnable) {
    const claimed = await db.claimForRun(s.caseId, s.attempts);
    if (!claimed) continue; // someone else got it
    try {
      await runCase(s.caseId);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await db.updateSetup(s.caseId, { status: 'FAILED', lastError: message });
      console.error(`[${s.caseId}] run threw:`, message);
    }
    ran++;
  }
  return { ran };
}
