import path from 'node:path';

// Load .env here rather than relying on a CLI flag, so the app picks up its
// config however it's started. Real environment variables win.
try {
  process.loadEnvFile(path.join(__dirname, '..', '.env'));
} catch {
  // No .env file -- fall back to the ambient environment.
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`Missing ${name} -- set it in .env`);
    process.exit(1);
  }
  return value;
}

function optional(name: string): string {
  return (process.env[name] ?? '').trim();
}

function num(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    console.error(`${name} must be a number, got "${raw}"`);
    process.exit(1);
  }
  return parsed;
}

/**
 * A service account private key arrives one of two ways: with the literal
 * two-character "\n" escapes it has inside JSON, or with real newlines when the
 * whole PEM was pasted between quotes. Normalise both to real newlines.
 */
function privateKey(name: string): string {
  return required(name).replace(/\\n/g, '\n');
}

/**
 * Subject label -> Drive template folder id. Parsed from a JSON object; an
 * empty or missing value just means no curriculum templates are configured yet
 * (step 4 then skips for every case).
 */
function curriculumTemplates(): Record<string, string> {
  const raw = optional('CURRICULUM_TEMPLATES_JSON');
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, string>;
    }
    console.error('CURRICULUM_TEMPLATES_JSON must be a JSON object of subject -> folder id');
    process.exit(1);
  } catch {
    console.error('CURRICULUM_TEMPLATES_JSON is not valid JSON');
    process.exit(1);
  }
}

const syncUrl = optional('SYNC_SUPABASE_URL').replace(/\/+$/, '');
const syncKey = optional('SYNC_SUPABASE_SERVICE_KEY');

const cosmicBaseUrl = optional('COSMIC_BASE_URL').replace(/\/+$/, '');
const cosmicEmail = optional('COSMIC_ADMIN_EMAIL');
const cosmicPassword = optional('COSMIC_ADMIN_PASSWORD');

export const config = {
  port: num('PORT', 3000),

  supabase: {
    // The shared project, holding public.group_cases and public.project_setups.
    url: required('SUPABASE_URL').replace(/\/+$/, ''),
    serviceKey: required('SUPABASE_SERVICE_KEY'),
  },

  sync: {
    // SYNC's own Supabase project. Optional at boot so the rest of the service
    // can run before SYNC is wired up; step 2 checks `configured` and skips
    // when it is absent.
    url: syncUrl,
    serviceKey: syncKey,
    configured: Boolean(syncUrl && syncKey),
  },

  periskope: {
    apiKey: required('PERISKOPE_API_KEY'),
    phone: required('PERISKOPE_PHONE'),
    baseUrl: optional('PERISKOPE_BASE_URL') || 'https://api.periskope.app/v1',
  },

  google: {
    clientEmail: required('GOOGLE_SA_CLIENT_EMAIL'),
    privateKey: privateKey('GOOGLE_SA_PRIVATE_KEY'),
    sharedDriveId: required('GOOGLE_SHARED_DRIVE_ID'),
    // Optional folder within the Shared Drive to nest student folders under.
    studentsParentFolderId: optional('GOOGLE_STUDENTS_PARENT_FOLDER_ID'),
    /**
     * People who get editor access to every student folder -- the ops team.
     * Same DRIVE_AUTO_ACCESS_EMAILS the intake service reads, so a folder made
     * by either of them ends up shared with the same people. Mentors are not
     * on this list: they are granted access individually, once introduced.
     */
    autoAccessEmails: optional('DRIVE_AUTO_ACCESS_EMAILS')
      .split(',')
      .map((e) => e.trim())
      .filter(Boolean),
    templates: curriculumTemplates(),
  },

  slack: {
    botToken: required('SLACK_BOT_TOKEN'),
    channel: required('SLACK_CHANNEL_ID'),
    baseUrl: optional('SLACK_BASE_URL') || 'https://slack.com/api',
  },

  dashboard: {
    // Linked from a failure note so a human can jump straight to the case.
    url: optional('DASHBOARD_URL').replace(/\/+$/, ''),
  },

  setup: {
    // Every 5 minutes. The cron scans for ready cases and runs them.
    cron: optional('SETUP_CRON') || '*/5 * * * *',
    // Stop retrying a case after this many failed attempts (it stays FAILED and
    // is surfaced for a human). 0 = retry forever.
    maxAttempts: num('SETUP_MAX_ATTEMPTS', 5),
  },

  /**
   * COSMIC LMS. Steps 5/6 create the student account and their project there.
   * Optional: unset and those two steps are SKIPPED.
   */
  cosmic: {
    baseUrl: cosmicBaseUrl,
    adminEmail: cosmicEmail,
    adminPassword: cosmicPassword,
    // "fixed default" per the spec: product | research | product_research.
    projectTrack: optional('COSMIC_PROJECT_TRACK') || 'product',
    // Project runs from today for this many weeks (end_date).
    durationWeeks: num('COSMIC_PROJECT_DURATION_WEEKS', 12),
    // Where students log in -- included in the credentials message.
    loginUrl: (optional('COSMIC_LOGIN_URL') || 'https://cosmic.create-ed.in').replace(/\/+$/, ''),
    configured: Boolean(cosmicBaseUrl && cosmicEmail && cosmicPassword),
  },
} as const;
