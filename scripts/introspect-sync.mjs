#!/usr/bin/env node
/**
 * SYNC schema introspection — a throwaway tool to answer "what tables/columns
 * does SYNC expose, and how are student / parent / mentor linked?".
 *
 * It reads the PostgREST OpenAPI (Swagger) document that every Supabase project
 * serves at `<url>/rest/v1/`. That document lists every exposed table, its
 * columns with types, and primary-/foreign-key relationships — and it is
 * readable with the anon key even when row-level security hides the actual
 * rows. As a bonus it then tries to pull up to 2 sample rows per table (these
 * may come back empty if RLS blocks the anon role — that's fine, the schema is
 * what we're after).
 *
 * Usage (either form):
 *   node scripts/introspect-sync.mjs --url https://<ref>.supabase.co --key <anon_key>
 *   SYNC_SUPABASE_URL=... SYNC_SUPABASE_ANON_KEY=... node scripts/introspect-sync.mjs
 *
 * Nothing is written anywhere. Output is meant to be copied back to Claude.
 */

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t === '--url') out.url = argv[++i];
    else if (t === '--key') out.key = argv[++i];
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const rawUrl = args.url || process.env.SYNC_SUPABASE_URL || process.env.SYNC_DB_URL;
const key = args.key || process.env.SYNC_SUPABASE_ANON_KEY || process.env.SYNC_ANON_KEY;

if (!rawUrl || !key) {
  console.error(
    'Missing credentials.\n' +
      '  node scripts/introspect-sync.mjs --url https://<ref>.supabase.co --key <anon_key>\n' +
      'or set SYNC_SUPABASE_URL and SYNC_SUPABASE_ANON_KEY in the environment.'
  );
  process.exit(1);
}

if (rawUrl.startsWith('postgres://') || rawUrl.startsWith('postgresql://')) {
  console.error(
    'That looks like a Postgres connection string. This script needs the\n' +
      'Supabase project URL (https://<ref>.supabase.co) and the anon key.'
  );
  process.exit(1);
}
const base = rawUrl.replace(/\/+$/, '').replace(/\/rest\/v1$/, '');
const restRoot = `${base}/rest/v1/`;
const headers = { apikey: key, authorization: `Bearer ${key}` };

function typeOf(prop) {
  const fmt = prop.format ? ` (${prop.format})` : '';
  return `${prop.type ?? '?'}${fmt}`;
}

function flagsOf(prop, requiredList, name) {
  const flags = [];
  const desc = prop.description || '';
  if (/Primary Key/i.test(desc)) flags.push('PK');
  const fk = desc.match(/<fk table='([^']+)' column='([^']+)'\/>/);
  if (fk) flags.push(`FK -> ${fk[1]}.${fk[2]}`);
  if (requiredList?.includes(name)) flags.push('required');
  if (prop.default !== undefined) flags.push(`default=${JSON.stringify(prop.default)}`);
  return flags;
}

async function main() {
  console.log(`\n# SYNC schema @ ${base}\n`);

  let swagger;
  try {
    const res = await fetch(restRoot, { headers });
    const text = await res.text();
    if (!res.ok) {
      console.error(`OpenAPI fetch failed: HTTP ${res.status}\n${text.slice(0, 400)}`);
      process.exit(1);
    }
    swagger = JSON.parse(text);
  } catch (err) {
    console.error('Could not reach the REST API:', err.message);
    process.exit(1);
  }

  const defs = swagger.definitions || {};
  const tables = Object.keys(defs).sort();
  if (tables.length === 0) {
    console.log('No tables are exposed to this key. (Check the anon key / exposed schema.)');
    return;
  }

  console.log(`Tables exposed (${tables.length}): ${tables.join(', ')}\n`);

  for (const table of tables) {
    const def = defs[table];
    const props = def.properties || {};
    const required = def.required || [];
    console.log(`\n## ${table}`);
    for (const [col, prop] of Object.entries(props)) {
      const flags = flagsOf(prop, required, col);
      const suffix = flags.length ? `  [${flags.join(', ')}]` : '';
      console.log(`  - ${col}: ${typeOf(prop)}${suffix}`);
    }

    try {
      const res = await fetch(`${restRoot}${table}?limit=2`, { headers });
      if (res.ok) {
        const rows = await res.json();
        if (Array.isArray(rows) && rows.length) {
          console.log(`  sample (${rows.length} row/s):`);
          for (const r of rows) {
            const shape = Object.fromEntries(
              Object.entries(r).map(([k, v]) => [
                k,
                v == null ? null : typeof v === 'object' ? '{…}' : String(v).slice(0, 40),
              ])
            );
            console.log(`    ${JSON.stringify(shape)}`);
          }
        } else {
          console.log('  sample: (no rows visible to anon key)');
        }
      } else {
        console.log(`  sample: (HTTP ${res.status} — likely RLS)`);
      }
    } catch {
      console.log('  sample: (fetch error)');
    }
  }

  console.log('\nDone. Copy everything above back to Claude.\n');
}

main();
