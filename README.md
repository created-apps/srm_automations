# project-setup-automations

Stage 5 of the CreatED pipeline: **Project Setup & Management** (owner: SRM + Ops).

Once the team has filled in the project details — in the operations dashboard
**or** in the intake Google Sheet — this service runs the setup steps for that
case automatically:

1. **Update the WhatsApp group** title & description (Periskope).
2. **Create the Student Drive folder** (Google Drive) and give the student &
   parent editor access.
3. **Add the mentor on SYNC**, ensuring student, parent and mentor are linked.
4. **Give the mentor editor access** to that Drive folder.
5. **Put the Drive link** into the WhatsApp group description.
6. **Create the student account in COSMIC LMS** and send the generated login
   into the WhatsApp group.
7. **Create the project in COSMIC LMS**, linked to that student and (if matched)
   the mentor, and **link it to the SYNC group**.
8. **Copy the relevant curriculum** (AI, Bio, CS, …) into the Drive folder.

## Two gates, not one

Step 1 is not gated on a mentor. Naming the group and giving it a description
only needs the project details, which land as soon as the brainstorm is done —
often well before a mentor exists. Everything from step 2 on genuinely needs the
mentor, and waits for the introduction to have actually gone out
(`group_cases.mentor_intro_sent_at`, not the coarser `stage`).

A step whose gate isn't open is **BLOCKED**: it stays PENDING, the run stops
there, and the case is picked up again next tick. Blocking is not a failure and
never burns a retry — a case waiting on a mentor must not exhaust its attempt
budget and drop out of the working set.

The Drive link belongs in the group description, but the folder doesn't exist
until the mentor gate opens. So the WhatsApp work is two steps: the details in
step 1, the link appended in step 5.

## How it runs

It is a **cron**, not a webhook. Every few minutes it reconciles:

```
group_cases (shared DB)              project_setups (shared DB)
-----------------------              --------------------------
dashboard OR intake sheet fills  ──> submitted_at set
 title + description                      │
                                          ├─ claim (compare-and-set to RUNNING)
                                          │
                                          ├─ 1. WhatsApp (title + description)
                                          │        ── ungated ──
                                          │  ──── mentor introduced? ────
                                          ├─ 2. Drive     (folder + family)
                                          ├─ 3. SYNC      (mentor membership)
                                          ├─ 4. Drive     (mentor access)
                                          ├─ 5. WhatsApp  (Drive link)
                                          ├─ 6-8. COSMIC  (student, project, link)
                                          └─ 9. Curriculum(copy template)
                                                │
                            all OK      ──> status = DONE  (+ Slack note)
                            blocked     ──> status = PENDING, retried next tick
                            a throw     ──> step FAILED, stop, retry next tick
```

- A case is **eligible** when `project_setups.submitted_at` is set. The
  dashboard sets it on submit; the sheet sync sets it once the row carries both
  a Project Name and a Project Description.
- Each step's outcome is recorded (`OK` / `SKIPPED` / `FAILED`), so a retry
  **resumes from the first step that isn't done** rather than repeating work.
  The created Drive folder id is saved before access is granted, so a retry
  never makes a second folder.
- A case that keeps failing stops after `SETUP_MAX_ATTEMPTS` and is surfaced in
  Slack / the dashboard for a human.

## Project details can be edited in two places

The title and description are written by the dashboard's Project Setup action
**and** by whoever edits the intake sheet. `assessment-automations` owns
reconciling the two (see its `src/sheet-sync.ts`); this service only reads the
result.

What it does care about is `details_revision` / `applied_revision`. An edit
bumps the first; a completed WhatsApp step records the second. When they differ,
the WhatsApp steps re-open so the correction actually reaches the group — and
the rename rule is relaxed for that run, since an edit is somebody explicitly
correcting the name. A case that had already reached DONE is put back to
PENDING by the writer, so the change isn't stranded.

## Curriculum holds rather than skips

The curriculum subject is only ever chosen in the dashboard, so a case
submitted from the sheet arrives without one. That is a **hold**: the case
finishes every other step and stops just short of DONE, staying visible as
unfinished until someone picks a subject. An explicit `NONE` is a real skip.
This is why curriculum runs last — a hold there must not delay COSMIC.

## The data it touches

- **Shared Supabase** (same project as `assessment-automations` / `Automations`):
  reads `public.group_cases`, owns `public.project_setups`
  (`sql/001_project_setup.sql`, plus `002_cosmic.sql` and
  `003_sheet_details_and_mentor_access.sql`). Run each once in the Supabase editor.
- **SYNC Supabase** (separate project): step 2 writes the mentor link here.
- **Periskope**: `POST /chats/{chat_id}/settings` to edit the group.
- **Google Drive**: a service account operating in a Shared Drive.
- **Slack**: a one-line completion / failure note (outbound only).

## The dashboard side (lives in `assessment-automations`)

The **Project Setup** action there lets SRM/Ops enter, after the brainstorm:
project **title**, **description**, and the **curriculum subject**. Submitting
it writes those to `project_setups` and sets `submitted_at` — which is what
makes the case eligible for this cron.

The same title and description can instead be typed straight into the intake
sheet. `assessment-automations` polls it and writes changes through to
`project_setups`, setting `submitted_at` once the row carries both. The
curriculum subject has no sheet column and is dashboard-only.

## Step 1 group-name rule

The `Automations` service names groups `CreatED X {student}: {project || 'Custom Project'}`.
Step 1 only rewrites the title when it is still the `…: Custom Project`
placeholder (replacing `Custom Project` with the confirmed project title). If a
real project name is already there, the title is left alone and only the
description is updated — renaming a family's chat unprompted is worse than a
title being slightly stale.

The exception is an **edit** (`applied_revision < details_revision` on a case
that has already had a revision applied). That is somebody explicitly
correcting the name, so the part after the first `": "` is replaced, keeping
whatever prefix the group was created with.

## COSMIC LMS (steps 6 & 7)

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

## SYNC (steps 3 & 4)

`src/sync.ts` links the mentor into SYNC. SYNC's model: a WhatsApp group is a
`groups` row keyed by `group_jid` (== our `chat_id`), and membership is
`user_group_memberships (user_id, group_id, role)`. Assigning a mentor is a
membership row with role `mentor` on the *student's* group.

The step:
1. Finds the SYNC group by JID; fails (retry + Slack) if it isn't onboarded.
2. Confirms a student membership exists in it; fails if not.
3. Resolves the mentor — **by `group_cases.mentor_sync_user_id`**, the SYNC
   user id stamped on the case when the mentor was introduced.
4. Inserts the mentor membership if absent (idempotent).

Step 4 (`mentor_access`) then grants that mentor's SYNC email editor access to
the student's Drive folder. It is a separate step on purpose: folded into the
Drive step, a mentor who couldn't be resolved would either block the steps that
don't need a mentor at all, or be marked done and never retried once fixed.

It never creates SYNC groups or users — that is SYNC's own onboarding, and
`assessment-automations` creates the SYNC account when a mentor is added from
the dashboard.

**Name matching is now the fallback, not the rule.** Mentors added from the
dashboard get a SYNC account at creation and carry its id. Only older,
name-only cases fall back to an exact (normalised) name match, which still
refuses to guess: zero or several matches is a failure that surfaces to Slack,
never a silent pick. Run `scripts/introspect-sync.mjs` to re-pull SYNC's names
when reconciling those.

If SYNC is not configured (`SYNC_SUPABASE_URL`/`_SERVICE_KEY` unset), the SYNC
steps are **SKIPPED** so the rest of the pipeline can still be exercised.

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
