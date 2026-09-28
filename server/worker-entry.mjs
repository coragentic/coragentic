import { randomUUID } from 'node:crypto';
import { openDatabase } from './db.mjs';
import { migrateWorkerSchema, processJob } from './worker.mjs';
import { migrateSwarmSchema } from './swarm.mjs';
import { getWorkerReadiness } from './worker-readiness.mjs';

const intervalMs = Number(process.env.CORAGENTIC_WORKER_INTERVAL_MS || 2_000);
const workerId = process.env.CORAGENTIC_WORKER_ID || `worker_${randomUUID()}`;
const executorPath = process.env.CORAGENTIC_JOB_EXECUTOR;

const readiness = await getWorkerReadiness({ executorUrl: executorPath });
if (!readiness.ready) {
  console.error(`Worker executor is not ready: ${readiness.reason}`);
  process.exit(1);
}

const executorModule = await import(executorPath);

const db = openDatabase();
migrateWorkerSchema(db);
migrateSwarmSchema(db); // ensures worker_heartbeat table exists

function writeHeartbeat(ready, reason = null) {
  const stamp = new Date().toISOString();
  db.prepare('INSERT INTO worker_heartbeat (id, worker_id, ready, reason, updated_at) VALUES (1, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET worker_id=excluded.worker_id, ready=excluded.ready, reason=excluded.reason, updated_at=excluded.updated_at')
    .run(workerId, ready ? 1 : 0, reason, stamp);
}

let stopped = false;
let running = false;

async function tick() {
  if (stopped || running) return;
  running = true;
  try {
    await processJob(db, executorModule.default, { workerId, leaseMs: 30_000, maxAttempts: 3 });
    writeHeartbeat(true);
  } catch (error) {
    console.error('worker tick failed', error);
    writeHeartbeat(false, 'tick_error');
  } finally {
    running = false;
  }
}

const timer = setInterval(() => void tick(), intervalMs);
const stop = () => {
  stopped = true;
  clearInterval(timer);
  writeHeartbeat(false, 'stopped');
  db.close?.();
};
process.once('SIGTERM', stop);
process.once('SIGINT', stop);
writeHeartbeat(true);
console.log(`Coragentic worker ${workerId} ready`);
void tick();
