# project-setup-automations

Stage 5 of the CreatED pipeline: **Project Setup & Management** (owner: SRM + Ops).

Once a student has a mentor assigned and the team has filled in the project
details in the operations dashboard, this service runs the setup steps for that
case automatically:

1. **Update the WhatsApp group** title & description (Periskope).
2. **Add the mentor on SYNC**, ensuring student, parent and mentor are linked.
3. **Create the Student Drive folder** (Google Drive) and give the student &
   parent editor access.
4. **Copy the relevant curriculum** (AI, Bio, CS, …) into that folder.
5. **Create the student account in COSMIC LMS** and send the generated login
   into the WhatsApp group.
6. **Create the project in COSMIC LMS**, linked to that student and (if matched)
   the mentor.

Steps 1 and 5 on the source diagram are the same WhatsApp update; with the two
COSMIC steps added, there are six real steps, run in order with resume-on-retry.

## How it runs

It is a **cron**, not a webhook. Every few minutes it reconciles:

```
group_cases (shared DB)                 project_setups (shared DB)
-----------------------                 --------------------------
stage = MENTOR_ASSIGNED   ─┐
                           ├─ ready? ──> claim (compare-and-set to RUNNING)
dashboard fills title/     │                 │
 description/curriculum  ──┘                 ├─ 1. WhatsApp  (Periskope)
 and sets submitted_at                       ├─ 2. SYNC      (mentor link)
                                             ├─ 3. Drive     (folder + access)
                                             └─ 4. Curriculum(copy template)
                                                   │
                                     all OK ──> status = DONE  (+ Slack note)
                                     a throw ─> step FAILED, stop, retry next tick
```

- A case is **ready** when its parent `group_cases.stage = 'MENTOR_ASSIGNED'`
  **and** the dashboard has set `project_setups.submitted_at`.
- Each step's outcome is recorded (`OK` / `SKIPPED` / `FAILED`), so a retry
  **resumes from the first step that isn't done** rather than repeating work.
  The created Drive folder id is saved before access is granted, so a retry
  never makes a second folder.
- A case that keeps failing stops after `SETUP_MAX_ATTEMPTS` and is surfaced in
  Slack / the dashboard for a human.

## The data it touches

- **Shared Supabase** (same project as `assessment-automations` / `Automations`):
  reads `public.group_cases`, owns `public.project_setups`
  (`sql/001_project_setup.sql`). Run that SQL once in the Supabase editor.
- **SYNC Supabase** (separate project): step 2 writes the mentor link here.
- **Periskope**: `POST /chats/{chat_id}/settings` to edit the group.
- **Google Drive**: a service account operating in a Shared Drive.
- **Slack**: a one-line completion / failure note (outbound only).

## The dashboard side (lives in `assessment-automations`)

The **Project Setup** action there lets SRM/Ops enter, after the brainstorm:
project **title**, **description**, and the **curriculum subject**. Submitting
it writes those to `project_setups` and sets `submitted_at` — which is what
makes the case eligible for this cron.

## Step 1 group-name rule

The `Automations` service names groups `CreatED X {student}: {project || 'Custom Project'}`.
Step 1 only rewrites the title when it is still the `…: Custom Project`
placeholder (replacing `Custom Project` with the confirmed project title). If a
real project name is already there, the title is left alone and only the
description is updated.

## COSMIC LMS (steps 5 & 6)

`src/cosmic.ts` talks to the COSMIC FastAPI (`<base>/api/v1`): logs in (the
account must be **super_admin**), creates the student (`POST /students/`),
**approves the account so the student can log in** (`PATCH
/user_approval/approve/{user_id}`, 409 = already approved), and creates the
project (`POST /projects/`). The student's generated password is returned only
on create, so it is posted straight into the WhatsApp group (Slack fallback if
that send fails). On a duplicate email the existing student is recovered via
`GET /students/` so the project step can still run (credentials aren't re-sent).
The project's `mentor_id` is resolved by matching the mentor's SYNC email (then
name) against `GET /mentors/`; an unmatched mentor doesn't block the project.
`project_track` is a fixed default, `start_date` is today and `end_date` is
`+COSMIC_PROJECT_DURATION_WEEKS`. Unset COSMIC config and both steps are SKIPPED.

Run `sql/002_cosmic.sql` once to add the tracking columns.

## SYNC (step 2)

`src/sync.ts` links the mentor into SYNC. SYNC's model: a WhatsApp group is a
`groups` row keyed by `group_jid` (== our `chat_id`), and membership is
`user_group_memberships (user_id, group_id, role)`. Assigning a mentor is a
membership row with role `mentor` on the *student's* group.

The step:
1. Finds the SYNC group by JID; fails (retry + Slack) if it isn't onboarded.
2. Confirms a student membership exists in it; fails if not.
3. Resolves the mentor by **exact (normalised) name** among SYNC's `role=mentor`
   users. Zero or multiple matches is a failure that surfaces to Slack -- it
   never guesses, because linking the wrong mentor is the worst outcome.
4. Inserts the mentor membership if absent (idempotent).

It never creates SYNC groups or users -- that is SYNC's own onboarding, and
`users.phone_number` is NOT NULL with no mentor phone available.

If SYNC is not configured (`SYNC_SUPABASE_URL`/`_SERVICE_KEY` unset), step 2 is
**SKIPPED** so the rest of the pipeline can still be exercised.

**Name alignment (data task):** exact matching only works when the mentor name
stored on the case matches a SYNC mentor. ~29 of the assessment directory's
names already align; the rest need reconciling to SYNC's spellings. Run
`scripts/introspect-sync.mjs` to re-pull SYNC's names when doing that.

## Develop

```bash
cp .env.example .env   # fill in
npm install
npm run typecheck
npm run dev            # server + cron
npm run run-once       # one reconciliation pass, then exit
```

## Deploy

Railway (`railway.toml`), one always-on replica. Keep `numReplicas = 1`.
