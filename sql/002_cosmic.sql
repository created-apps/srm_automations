-- Stage 5: COSMIC LMS student + project creation.
--
-- Three more steps in the project-setup pipeline: create the student account in
-- COSMIC LMS, create their project there, and link that project to its SYNC
-- group. Tracked alongside the other steps on public.project_setups. Run once
-- in the Supabase SQL editor (after 001_project_setup.sql).
--
-- The sync-group column was added after this file was first run, so re-run it
-- if step_cosmic_sync_group is missing -- every statement is `if not exists`.

alter table public.project_setups
  add column if not exists step_cosmic_student text not null default 'PENDING'
    check (step_cosmic_student in ('PENDING', 'OK', 'FAILED', 'SKIPPED')),
  add column if not exists step_cosmic_project text not null default 'PENDING'
    check (step_cosmic_project in ('PENDING', 'OK', 'FAILED', 'SKIPPED')),
  -- Links the created COSMIC project to its SYNC group (sets projects.sync_group_id).
  add column if not exists step_cosmic_sync_group text not null default 'PENDING'
    check (step_cosmic_sync_group in ('PENDING', 'OK', 'FAILED', 'SKIPPED')),
  -- Ids returned by COSMIC, kept so a retry reuses them instead of creating
  -- duplicates, and so ops can find the created records.
  add column if not exists cosmic_student_id text,
  add column if not exists cosmic_user_id text,
  add column if not exists cosmic_project_id text;
