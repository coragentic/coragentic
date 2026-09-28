# Production Recovery Runbook

This repository can run as a single-node Node + SQLite deployment. That makes **consistent backups, a restore drill, and service health checks** prerequisites for production operations.

## State that must be preserved

| Artifact | Default production location | Why it matters |
|---|---|---|
| SQLite database | `/var/lib/coragentic/coragentic.sqlite` | Agents, sessions, private memory, jobs, audit events, swarm state, x402 settlement replay records. |
| API configuration | `/etc/coragentic/api.env` | Runtime configuration and service credentials. Keep this root-only; do not commit it. |
| MCP HTTP configuration | `/etc/coragentic/mcp-http.env` | Remote MCP bearer-token configuration. Keep this root-only; do not commit it. |
| systemd units | `/etc/systemd/system/coragentic-*.service` | Reproducible process supervision. |

## Daily online SQLite backup

`deploy/coragentic-state-backup` uses SQLite's `.backup` API, then archives the snapshot. It does **not** stop the API and does not copy a live WAL database file blindly.

```bash
install -d -m 700 /var/backups/coragentic
install -m 700 deploy/coragentic-state-backup /usr/local/sbin/coragentic-state-backup
install -m 644 deploy/coragentic-backup.service /etc/systemd/system/
install -m 644 deploy/coragentic-backup.timer /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now coragentic-backup.timer
systemctl start coragentic-backup.service
```

The timer runs daily at `03:20 UTC` with a randomized delay of up to ten minutes, retains the newest 14 archives, and is silent on success. Archive permissions are root-only (`0600`).

Verify a snapshot before considering backup configured:

```bash
systemctl status coragentic-backup.service
archive=$(ls -1t /var/backups/coragentic/coragentic-state-*.tar.gz | head -1)
tar -tzf "$archive"
```

## Restore drill

Never overwrite live state before preserving it. Perform a restore in a maintenance window.

```bash
systemctl stop coragentic-api coragentic-mcp-http
cp -a /var/lib/coragentic/coragentic.sqlite /var/lib/coragentic/coragentic.sqlite.pre-restore

archive=/var/backups/coragentic/coragentic-state-YYYYMMDDTHHMMSSZ.tar.gz
tmp=$(mktemp -d)
tar -xzf "$archive" -C "$tmp"
install -o coragentic -g coragentic -m 600 "$tmp"/*.sqlite /var/lib/coragentic/coragentic.sqlite
sqlite3 /var/lib/coragentic/coragentic.sqlite 'PRAGMA integrity_check;'

systemctl start coragentic-api coragentic-mcp-http
curl -fsS http://127.0.0.1:8797/health
```

Only `ok` from `PRAGMA integrity_check` and a passing API health response constitute a successful restore drill.

## Production checks

```bash
systemctl is-active coragentic-api coragentic-mcp-http coragentic-tunnel
curl -fsS https://api.coragentic.app/health
curl -fsS https://mcp.coragentic.app/healthz
systemctl list-timers coragentic-backup.timer --no-pager
```

## Boundaries

Backups contain private agent context and wallet-session hashes. Do not upload them to public storage, attach them to GitHub issues, or relax their permissions. A backup protects availability; it does not turn this single-node SQLite deployment into a multi-region replicated system.
