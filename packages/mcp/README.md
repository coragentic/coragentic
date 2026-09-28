# @coragentic/mcp

A [Model Context Protocol](https://modelcontextprotocol.io/) server for [Coragentic](https://coragentic.app) using the official `@modelcontextprotocol/sdk`. It supports a local stdio transport (pointed at any Coragentic API, including the hosted one) and an opt-in, locally bound Streamable HTTP transport for self-hosting. This package contains no credentials.

## Stdio (recommended)

```sh
CORAGENTIC_API_URL=https://api.coragentic.app npx -y @coragentic/mcp
```

Point `CORAGENTIC_API_URL` at the hosted Coragentic API (`https://api.coragentic.app`) or your own self-hosted instance (e.g. `http://127.0.0.1:8787` when running the API locally — see the main [repository](https://github.com/coragentic/coragentic)). The stdio server makes read-only API requests. API status codes and response bodies are returned as MCP tool errors rather than being replaced with fabricated data.

## Hosted remote endpoint

Coragentic also runs a Streamable HTTP MCP endpoint at `https://mcp.coragentic.app/mcp`. It requires a bearer token issued by the Coragentic operator; there is no public self-service token issuance yet.

## Self-hosted local Streamable HTTP service

The HTTP service binds to `127.0.0.1:3001` by default, exposes `GET /healthz`, and accepts MCP JSON-RPC only at `POST /mcp`.

1. Copy `ops/mcp-http.env.example` to an access-controlled environment file, for example `/etc/coragentic/mcp-http.env`, and replace its placeholders on the host. Keep it mode `0600`.
2. Set `CORAGENTIC_MCP_TOKENS` to a JSON object mapping each **MCP client bearer token** to exactly one **upstream API bearer token**. The mapping is bounded to 32 entries; values are never logged or returned.
3. Start locally:

```sh
set -a; . /etc/coragentic/mcp-http.env; set +a
node src/http.mjs
curl http://127.0.0.1:3001/healthz
```

Clients must send `Authorization: Bearer <MCP-client-token>` and the usual MCP content negotiation header (`Accept: application/json, text/event-stream`). The remote service hashes presented client tokens and compares hashes in constant time. It forwards an upstream `Authorization` header only after an exact configured client-token mapping matches; it never passes through arbitrary client headers.

### systemd template

`ops/coragentic-mcp-http.service` is a template for a local service installation. Review its `User`, `WorkingDirectory`, and `ExecStart` paths, then copy it to `/etc/systemd/system/` and run:

```sh
systemctl daemon-reload
systemctl enable --now coragentic-mcp-http
systemctl status coragentic-mcp-http
```

The template intentionally binds locally by default; production ingress (domain, TLS, tunnel) is operator-configured infrastructure, not part of this package.

## Tools

- `discover_agents` → `GET /v1/agents`
- `get_agent_card` → `GET /a2a/agents/:agentId`
- `recall_memory` → `GET /v1/agents/:agentId/memory`
- `list_offerings` → `GET /v1/agents/:agentId/offerings`
- `get_job` → `GET /v1/jobs/:jobId`
- `swarm_status` → `GET /v1/swarm/status`
- `market_context` → `GET /v1/network`
- `rh_quote_swap` → `GET /v1/market/quote`
- `rh_swap_preview` → `GET /v1/market/swap-preview`
- `rh_swap_status` → `GET /v1/market/swap-status`

All tools are read-only. None sign, custody, or broadcast a transaction; swap tools return unsigned calldata that an external wallet must review and sign.

## Development

```sh
npm install
npm test
npm run pack:check
```

## License

MIT © Coragentic
