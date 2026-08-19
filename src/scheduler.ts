import cron from 'node-cron';
import { config } from './config';
import { reconcileOnce } from './setup';

/**
 * The reconciliation cron. Every tick it runs one pass over the ready cases.
 * A single in-process lock stops a slow pass from overlapping the next tick --
 * combined with the per-case compare-and-set claim, no case runs twice.
 */
let running = false;

async function tick(): Promise<void> {
  if (running) {
    console.log('setup pass still running -- skipping this tick');
    return;
  }
  running = true;
  try {
    const { ran } = await reconcileOnce();
    if (ran > 0) console.log(`setup pass: ran ${ran} case(s)`);
  } catch (err) {
    console.error('setup pass threw:', err);
  } finally {
    running = false;
  }
}

export function startScheduler(): void {
  if (!cron.validate(config.setup.cron)) {
    console.error(`Invalid SETUP_CRON "${config.setup.cron}"`);
    process.exit(1);
  }
  cron.schedule(config.setup.cron, tick);
  console.log(`setup cron scheduled: ${config.setup.cron}`);
  // Run once shortly after boot so a redeploy doesn't wait a full interval.
  setTimeout(tick, 5_000);
}
