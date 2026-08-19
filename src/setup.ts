import * as db from './db';
import type { GroupCase, ProjectSetup, StepStatus } from './db';
import * as periskope from './periskope';
import * as drive from './drive';
import * as sync from './sync';
import * as cosmic from './cosmic';
import * as slack from './slack';
import { config } from './config';

/**
 * Run the five Stage 5 steps for one case, in order, resuming from wherever a
 * previous attempt got to. A step that throws stops the run: its status is
 * recorded FAILED, the case is left FAILED, and the cron retries it next tick
 * (up to SETUP_MAX_ATTEMPTS). A step that returns "skip" is a deliberate no-op.
 *
 * Steps 1 and 5 on the diagram are the same WhatsApp update, so there are four
 * real steps: whatsapp, sync, drive, curriculum.
 */

const PLACEHOLDER_SUFFIX = ': Custom Project';

type StepOutcome = { status: Extract<StepStatus, 'OK' | 'SKIPPED'>; note?: string };

/** The WhatsApp group name after applying the project title, per the rule:
 *  only rewrite when the name is still the "...: Custom Project" placeholder. */
function nextGroupName(groupName: string, projectTitle: string): string | null {
  if (groupName.toLowerCase().endsWith(PLACEHOLDER_SUFFIX.toLowerCase())) {
    return groupName.slice(0, groupName.length - PLACEHOLDER_SUFFIX.length) + `: ${projectTitle}`;
  }
  return null; // a real project name is already there -- leave the title alone
}

// --- individual steps ------------------------------------------------------

async function stepWhatsapp(c: GroupCase, s: ProjectSetup): Promise<StepOutcome> {
  const title = (s.projectTitle ?? '').trim();
  const description = (s.projectDescription ?? '').trim();

  // The group description carries the project description and the student's
  // Drive link. Drive runs before this step, so driveFolderUrl is set by now.
  const descriptionParts: string[] = [];
  if (description) descriptionParts.push(description);
  if (s.driveFolderUrl) descriptionParts.push(`Project Drive: ${s.driveFolderUrl}`);
  const fullDescription = descriptionParts.join('\n\n');

  const newName = title ? nextGroupName(c.groupName, title) : null;
  const settings: { name?: string; description?: string } = {};
  if (newName) settings.name = newName;
  if (fullDescription) settings.description = fullDescription;

  if (Object.keys(settings).length === 0) {
    return { status: 'SKIPPED', note: 'nothing to change (no new title/description)' };
  }
  await periskope.updateGroupSettings(c.chatId, settings);
  return { status: 'OK' };
}

async function stepSync(c: GroupCase): Promise<StepOutcome> {
  const result = await sync.linkMentor(c);
  return result.skipped ? { status: 'SKIPPED', note: result.reason } : { status: 'OK' };
}

async function stepDrive(c: GroupCase, s: ProjectSetup): Promise<StepOutcome> {
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

async function stepCurriculum(s: ProjectSetup): Promise<StepOutcome> {
  const subject = (s.curriculumSubject ?? '').trim();
  if (!subject || subject.toUpperCase() === 'NONE') {
    return { status: 'SKIPPED', note: 'no curriculum chosen' };
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

function credentialsMessage(studentName: string, c: cosmic.Credentials): string {
  return (
    `Hi ${studentName}! Your COSMIC LMS account is ready.\n` +
    `Login at ${config.cosmic.loginUrl}\n` +
    `Username: ${c.username}\n` +
    `Password: ${c.password}\n` +
    `Please change your password after your first login.`
  );
}

/** Step 5 -- create the student in COSMIC and send their login to the group. */
async function stepCosmicStudent(c: GroupCase, s: ProjectSetup): Promise<StepOutcome> {
  if (!cosmic.cosmicConfigured()) return { status: 'SKIPPED', note: 'COSMIC not configured' };
  if (s.cosmicStudentId) return { status: 'OK' }; // created on a prior attempt

  const email = (c.studentEmail ?? '').trim();
  if (!email) throw new Error('cosmic student: case has no student email');

  const { first, last } = splitName(c.studentName);
  const themes =
    s.curriculumSubject && s.curriculumSubject.toUpperCase() !== 'NONE'
      ? [s.curriculumSubject]
      : [];
  const payload: cosmic.StudentCreateInput = {
    first_name: first,
    last_name: last,
    email,
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
    // Duplicate email (400) -> recover the existing student so the project can
    // still be created. The one-time password isn't retrievable, so it isn't
    // re-sent.
    if (err instanceof cosmic.CosmicError && err.status === 400) {
      const existing = await cosmic.findStudentByEmail(email);
      if (existing) {
        await db.updateSetup(s.caseId, {
          cosmicStudentId: existing.id,
          cosmicUserId: existing.user_id || null,
        });
        // Make sure they can log in even if a prior attempt left them unverified.
        if (existing.user_id) await cosmic.verifyUser(existing.user_id);
        return { status: 'OK', note: 'student already existed in COSMIC (credentials not re-sent)' };
      }
    }
    throw err;
  }

  // Persist ids before the (best-effort) credentials send.
  await db.updateSetup(s.caseId, {
    cosmicStudentId: created.id,
    cosmicUserId: created.user_id,
  });

  // Approve/verify the account so the student can actually log in.
  await cosmic.verifyUser(created.user_id);

  if (created.credentials) {
    try {
      await periskope.sendMessage(c.chatId, credentialsMessage(c.studentName, created.credentials));
    } catch (err) {
      // Never lose a one-time password: fall back to Slack.
      const m = err instanceof Error ? err.message : String(err);
      await slack.postNote(
        `:key: COSMIC login for ${c.studentName} (WhatsApp send failed: ${m}) -- ` +
          `username: ${created.credentials.username}, password: ${created.credentials.password}`
      );
      return { status: 'OK', note: 'credentials delivered to Slack (WhatsApp send failed)' };
    }
  }
  return { status: 'OK' };
}

/** Step 6 -- create the project in COSMIC, linked to the student and mentor. */
async function stepCosmicProject(c: GroupCase, s: ProjectSetup): Promise<StepOutcome> {
  if (!cosmic.cosmicConfigured()) return { status: 'SKIPPED', note: 'COSMIC not configured' };
  if (s.cosmicProjectId) return { status: 'OK' };
  if (!s.cosmicStudentId) throw new Error('cosmic project: no student id (student step must run first)');

  const title = (s.projectTitle ?? '').trim() || c.groupName;

  // Resolve the COSMIC mentor id: mentor email via SYNC, then match in COSMIC
  // (falling back to a name match). A missing mentor doesn't block the project.
  let mentorId: string | undefined;
  const mentorName = (c.mentorName ?? '').trim();
  if (mentorName) {
    const resolved = await sync.resolveMentor(mentorName).catch(() => null);
    mentorId = (await cosmic.findMentorId({ email: resolved?.email ?? null, name: mentorName })) ?? undefined;
  }

  const start = new Date();
  const end = new Date(start);
  end.setDate(end.getDate() + config.cosmic.durationWeeks * 7);
  const ymd = (d: Date) => d.toISOString().slice(0, 10);

  const created = await cosmic.createProject({
    ...(mentorId ? { mentor_id: mentorId } : {}),
    student_id: s.cosmicStudentId,
    project_name: title,
    ...(s.projectDescription ? { project_description: s.projectDescription } : {}),
    project_track: config.cosmic.projectTrack,
    status: 'not_started',
    start_date: ymd(start),
    end_date: ymd(end),
  });
  await db.updateSetup(s.caseId, { cosmicProjectId: created.id });
  return {
    status: 'OK',
    note: mentorId ? undefined : `no COSMIC mentor matched "${mentorName}" -- project created without a mentor`,
  };
}

/** Step 7 -- link the COSMIC project to its SYNC group (sets sync_group_id). */
async function stepCosmicSyncGroup(c: GroupCase, s: ProjectSetup): Promise<StepOutcome> {
  if (!cosmic.cosmicConfigured()) return { status: 'SKIPPED', note: 'COSMIC not configured' };
  if (!sync.syncConfigured()) return { status: 'SKIPPED', note: 'SYNC not configured -- no group id to link' };
  if (!s.cosmicProjectId) throw new Error('cosmic sync-group: no project id (project step must run first)');

  const groupId = await sync.findGroupIdByJid(c.chatId);
  if (!groupId) throw new Error(`cosmic sync-group: no SYNC group for JID ${c.chatId}`);

  await cosmic.setProjectSyncGroup(s.cosmicProjectId, groupId, c.chatId);
  return { status: 'OK' };
}

// --- orchestration ---------------------------------------------------------

interface StepDef {
  key:
    | 'whatsapp'
    | 'sync'
    | 'drive'
    | 'curriculum'
    | 'cosmic_student'
    | 'cosmic_project'
    | 'cosmic_sync_group';
  column:
    | 'stepWhatsapp'
    | 'stepSync'
    | 'stepDrive'
    | 'stepCurriculum'
    | 'stepCosmicStudent'
    | 'stepCosmicProject'
    | 'stepCosmicSyncGroup';
  current: (s: ProjectSetup) => StepStatus;
  run: (c: GroupCase, s: ProjectSetup) => Promise<StepOutcome>;
}

// Drive runs before WhatsApp so the group description can include the Drive
// link. Curriculum copies into the Drive folder, so it stays after Drive too.
const STEPS: StepDef[] = [
  { key: 'drive', column: 'stepDrive', current: (s) => s.stepDrive, run: (c, s) => stepDrive(c, s) },
  { key: 'whatsapp', column: 'stepWhatsapp', current: (s) => s.stepWhatsapp, run: (c, s) => stepWhatsapp(c, s) },
  { key: 'sync', column: 'stepSync', current: (s) => s.stepSync, run: (c) => stepSync(c) },
  { key: 'curriculum', column: 'stepCurriculum', current: (s) => s.stepCurriculum, run: (_c, s) => stepCurriculum(s) },
  { key: 'cosmic_student', column: 'stepCosmicStudent', current: (s) => s.stepCosmicStudent, run: (c, s) => stepCosmicStudent(c, s) },
  { key: 'cosmic_project', column: 'stepCosmicProject', current: (s) => s.stepCosmicProject, run: (c, s) => stepCosmicProject(c, s) },
  { key: 'cosmic_sync_group', column: 'stepCosmicSyncGroup', current: (s) => s.stepCosmicSyncGroup, run: (c, s) => stepCosmicSyncGroup(c, s) },
];

/**
 * Run (or resume) one case that has already been claimed (status RUNNING).
 * `setup` is the freshly-claimed row. Returns nothing; all state is persisted.
 */
export async function runCase(caseId: string): Promise<void> {
  const groupCase = await db.findCaseById(caseId);
  if (!groupCase) throw new Error(`case ${caseId} vanished`);

  // Re-read the setup so we act on the latest step statuses (and the folder id
  // a prior attempt may have saved).
  let setup = await db.findSetup(caseId);
  if (!setup) throw new Error(`project_setups ${caseId} vanished`);

  for (const step of STEPS) {
    if (step.current(setup) === 'OK' || step.current(setup) === 'SKIPPED') continue;

    try {
      const outcome = await step.run(groupCase, setup);
      setup = await db.updateSetup(caseId, {
        [step.column]: outcome.status,
        lastError: null,
      } as db.SetupPatch);
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

  const done = await db.updateSetup(caseId, {
    status: 'DONE',
    completedAt: new Date(),
    lastError: null,
  });
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
  const runnable = await db.listRunnable(config.setup.maxAttempts);
  let ran = 0;
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
