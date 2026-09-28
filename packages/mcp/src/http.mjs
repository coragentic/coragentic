#!/usr/bin/env node
import { createHttpService } from './http-service.mjs';

const port = Number(process.env.CORAGENTIC_MCP_PORT || 3001);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('CORAGENTIC_MCP_PORT must be a valid TCP port');
const host = process.env.CORAGENTIC_MCP_HOST || '127.0.0.1';
const service = createHttpService();
service.listen(port, host, () => console.error(`Coragentic MCP HTTP listening on ${host}:${port}`));
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => service.close(() => process.exit(0)));
