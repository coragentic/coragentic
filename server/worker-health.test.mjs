import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const root = new URL('..', import.meta.url).pathname;

test('GET /health/worker returns only the public worker readiness state', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'coragentic-api-health-'));
  const secretPath = '/private/worker/secret-executor.mjs';
  const port = 30_000 + (process.pid % 10_000);
  const child = spawn(process.execPath, ['server/index.mjs'], {
    cwd: root,
    env: { ...process.env, PORT: String(port), CORAGENTIC_DB: join(dir, 'api.sqlite'), CORAGENTIC_JOB_EXECUTOR: secretPath },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  try {
    await once(child.stdout, 'data');
    const response = await fetch(`http://127.0.0.1:${port}/health/worker`);
    const body = await response.json();
    assert.equal(response.status, 503);
    assert.deepEqual(body, { ok: false, worker: { configured: true, ready: false, reason: 'executor_configured_worker_not_running' } });
    assert.equal(JSON.stringify(body).includes(secretPath), false);
  } finally {
    child.kill('SIGTERM');
    await once(child, 'exit');
    rmSync(dir, { recursive: true, force: true });
  }
});
