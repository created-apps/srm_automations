-- Sheet-sourced project details, the mentor's Drive access, and the split of
-- the WhatsApp step into an ungated and a mentor-gated half.
-- Run once in the Supabase SQL editor.
--
-- Three changes:
--
-- 1. The project title/description can now be edited in the intake sheet as
--    well as in the dashboard. `sheet_details_seen` is what the sheet last
--    said; a value that differs from it is an edit to apply. Both writers keep
--    it current, which is what stops the mirror-write bouncing back as a
--    fresh "change" on the next pass.
--
-- 2. The mentor gets editor access to the student's Drive folder. It is its
--    own step rather than a third grantee inside step_drive, so that failing
--    to resolve the mentor retries on its own instead of either blocking the
--    steps that don't need one or being marked done and never retried.
--
-- 3. The group rename/description no longer waits for a mentor, but the Drive
--    link in that description does (the folder isn't created until the mentor
--    gate opens). So the WhatsApp work is two steps: the details now, the
--    Drive link appended after.

alter table public.project_setups
  add column if not exists step_mentor_access text not null default 'PENDING'
    check (step_mentor_access in ('PENDING', 'OK', 'FAILED', 'SKIPPED')),
  add column if not exists step_whatsapp_drive_link text not null default 'PENDING'
    check (step_whatsapp_drive_link in ('PENDING', 'OK', 'FAILED', 'SKIPPED'));

-- What the sheet row last held: {"title": "...", "description": "..."}.
-- Null means the row has never been read, so the first pass adopts whatever is
-- there without treating it as an edit.
alter table public.project_setups
  add column if not exists sheet_details_seen jsonb;

-- Bumped by whichever writer changes the title or description (the dashboard
-- endpoint or the sheet cron). The setup run records the revision it applied,
-- so a later edit re-opens the WhatsApp step instead of being silently
-- dropped on a case that already reached DONE.
alter table public.project_setups
  add column if not exists details_revision integer not null default 0,
  add column if not exists applied_revision integer not null default 0;

-- The sheet cron's working set: rows whose details have moved on.
create index if not exists project_setups_revision_idx
  on public.project_setups (details_revision, applied_revision);
