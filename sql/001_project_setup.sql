-- Stage 5 project-setup state.
--
-- Lives in the SAME Supabase project as public.group_cases (the
-- assessment-automations / Automations database), in `public`, reached over
-- PostgREST with the service key. Run this once in the Supabase SQL editor.
--
-- One row per case. The dashboard's "Project Setup" and "Curriculum" actions
-- fill the top half (title / description / subject and submitted_at); the
-- Stage 5 cron owns the bottom half (per-step status, the created Drive
-- folder, retries). Statuses are TEXT + CHECK, matching the sibling services,
-- so adding a value is an ALTER of one constraint rather than an ALTER TYPE.

create table if not exists public.project_setups (
  case_id uuid primary key
    references public.group_cases (id) on delete cascade,

  -- ---- Filled by the dashboard (SRM / Ops), after the brainstorm ----------
  -- The confirmed project title. Used to rewrite the WhatsApp group name (only
  -- when it is still the "...: Custom Project" placeholder) and to name the
  -- student's Drive folder.
  project_title       text,
  -- Shown as the WhatsApp group description.
  project_description text,
  -- Which curriculum to copy in step 4. A subject label that maps to a Drive
  -- template folder (see CURRICULUM_TEMPLATES_JSON), or 'NONE' to skip step 4.
  curriculum_subject  text,

  -- The readiness gate. NULL means the details have not been confirmed in the
  -- dashboard yet, so the cron leaves the case alone. Set when SRM submits the
  -- Project Setup action.
  submitted_at timestamptz,
  submitted_by text,

  -- ---- Owned by the Stage 5 cron ------------------------------------------
  status text not null default 'PENDING'
    check (status in ('PENDING', 'RUNNING', 'DONE', 'FAILED')),

  -- Per-step outcome, so a retry resumes from the first step that isn't OK
  -- rather than repeating the ones that already succeeded. SKIPPED is a
  -- deliberate no-op (e.g. no curriculum chosen, or a missing email).
  step_whatsapp   text not null default 'PENDING'
    check (step_whatsapp   in ('PENDING', 'OK', 'FAILED', 'SKIPPED')),
  step_sync       text not null default 'PENDING'
    check (step_sync       in ('PENDING', 'OK', 'FAILED', 'SKIPPED')),
  step_drive      text not null default 'PENDING'
    check (step_drive      in ('PENDING', 'OK', 'FAILED', 'SKIPPED')),
  step_curriculum text not null default 'PENDING'
    check (step_curriculum in ('PENDING', 'OK', 'FAILED', 'SKIPPED')),

  -- The Drive folder created in step 3, kept so step 4 (and a later retry)
  -- reuse it instead of creating a second one.
  drive_folder_id  text,
  drive_folder_url text,

  attempts     integer not null default 0,
  last_error   text,
  last_run_at  timestamptz,
  completed_at timestamptz,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- The cron's working set: submitted, not yet done.
create index if not exists project_setups_status_idx
  on public.project_setups (status);
create index if not exists project_setups_submitted_idx
  on public.project_setups (submitted_at);

-- Same lockdown as the sibling tables: this sits in `public`, which Supabase
-- exposes over PostgREST, and it carries names and a Drive folder link. RLS on
-- with no policies means anon and authenticated get nothing; the service key
-- each service uses bypasses RLS entirely.
alter table public.project_setups enable row level security;
revoke all on public.project_setups from anon, authenticated;
