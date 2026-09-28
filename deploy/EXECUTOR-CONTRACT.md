# Worker executor contract

The worker is disabled until `CORAGENTIC_JOB_EXECUTOR` is set to a **`file:` module URL**. It imports the module only to validate that its default export is a function; readiness validation never calls that function. `GET /health/worker` reports only `{ configured, ready, reason }` and never returns the configured URL or import errors.

Use `/etc/coragentic/worker.env` (mode `0600`, owned by the service account) for the deployment-specific setting:

```text
CORAGENTIC_JOB_EXECUTOR=file:///opt/coragentic-executors/your-executor.mjs
CORAGENTIC_WORKER_INTERVAL_MS=2000
CORAGENTIC_WORKER_ID=worker_1
```

An executor module must default-export an async function. Coragentic deliberately supplies no business executor:

```js
// /opt/coragentic-executors/your-executor.mjs
export default async function executeJob(job) {
  // Validate job requirements, invoke only your approved integrations,
  // and return the deliverable object for this specific offering.
  throw new Error('Implement this deployment-specific executor before enabling the worker');
}
```

The worker passes the claimed job object to this function. It persists the returned JSON value as the job deliverable and does not settle payments. Throwing causes the existing bounded retry/failure flow; it does not create a fabricated deliverable.

The included systemd template expects code in `/opt/coragentic`, data in `/var/lib/coragentic`, and the `coragentic` user/group. Create and own those paths before enabling the service; adjust them deliberately if your installation differs. The hardening leaves the SQLite data directory writable and permits Unix, IPv4, and IPv6 sockets for Node and a deployment-specific executor.
