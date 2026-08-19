import express from 'express';
import { config } from './config';
import * as db from './db';
import { startScheduler } from './scheduler';

/**
 * The service is really the cron in scheduler.ts; the HTTP surface is just a
 * health check so Railway (and a load balancer) can tell it's alive and the
 * database is reachable.
 */
const app = express();

app.get('/health', async (_req, res) => {
  try {
    await db.ping();
    return res.json({ ok: true });
  } catch (err) {
    console.error('healthcheck failed:', err);
    return res.status(503).json({ ok: false, error: 'database unreachable' });
  }
});

app.listen(config.port, () => {
  console.log(`project-setup service listening on :${config.port}`);
  startScheduler();
});
