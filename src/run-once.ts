import { reconcileOnce } from './setup';

/**
 * Run a single reconciliation pass and exit -- for local testing and for
 * poking the pipeline by hand without waiting for the cron.
 *
 *   npm run run-once
 */
reconcileOnce()
  .then(({ ran }) => {
    console.log(`done -- ran ${ran} case(s)`);
    process.exit(0);
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
