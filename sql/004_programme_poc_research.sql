-- Early POC bootstrap and the RBP research-mentor follow-up.

alter table public.project_setups
  add column if not exists poc_status text not null default 'PENDING',
  add column if not exists poc_attempts integer not null default 0,
  add column if not exists step_poc_drive text not null default 'PENDING',
  add column if not exists step_poc_drive_access text not null default 'PENDING',
  add column if not exists step_cosmic_poc_project text not null default 'PENDING',
  add column if not exists cosmic_poc_project_id uuid,
  -- COSMIC returns a new student's password once. Keep it only across the
  -- student→POC-project gap, then clear it immediately after delivery.
  add column if not exists pending_cosmic_credentials jsonb,
  add column if not exists cosmic_credentials_delivered_at timestamptz,
  add column if not exists research_status text not null default 'PENDING',
  add column if not exists research_attempts integer not null default 0,
  add column if not exists step_research_drive_access text not null default 'PENDING',
  add column if not exists step_cosmic_research_mentor text not null default 'PENDING',
  add column if not exists applied_research_mentor_sync_user_id uuid;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'project_setups_poc_status_check') then
    alter table public.project_setups add constraint project_setups_poc_status_check
      check (poc_status in ('PENDING', 'RUNNING', 'DONE', 'FAILED'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'project_setups_research_status_check') then
    alter table public.project_setups add constraint project_setups_research_status_check
      check (research_status in ('PENDING', 'RUNNING', 'DONE', 'FAILED'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'project_setups_poc_drive_step_check') then
    alter table public.project_setups add constraint project_setups_poc_drive_step_check
      check (step_poc_drive in ('PENDING', 'OK', 'FAILED', 'SKIPPED'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'project_setups_poc_access_step_check') then
    alter table public.project_setups add constraint project_setups_poc_access_step_check
      check (step_poc_drive_access in ('PENDING', 'OK', 'FAILED', 'SKIPPED'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'project_setups_cosmic_poc_step_check') then
    alter table public.project_setups add constraint project_setups_cosmic_poc_step_check
      check (step_cosmic_poc_project in ('PENDING', 'OK', 'FAILED', 'SKIPPED'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'project_setups_research_access_step_check') then
    alter table public.project_setups add constraint project_setups_research_access_step_check
      check (step_research_drive_access in ('PENDING', 'OK', 'FAILED', 'SKIPPED'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'project_setups_cosmic_research_step_check') then
    alter table public.project_setups add constraint project_setups_cosmic_research_step_check
      check (step_cosmic_research_mentor in ('PENDING', 'OK', 'FAILED', 'SKIPPED'));
  end if;
end $$;

create index if not exists project_setups_poc_runnable_idx
  on public.project_setups (poc_status, updated_at);
create index if not exists project_setups_research_runnable_idx
  on public.project_setups (research_status, updated_at);
