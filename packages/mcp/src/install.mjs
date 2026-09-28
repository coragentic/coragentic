#!/usr/bin/env node
// `npx @coragentic/mcp install` — auto-register the Coragentic MCP server in
// supported AI clients by editing their own config files in place. Never prints
// or stores secrets; only writes the server entry (command/args/env) each
// client expects. Idempotent: running it twice does not duplicate entries.

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { createServer } from './index.mjs';

const SERVER_ENTRY = {
  command: 'npx',
  args: ['-y', '@coragentic/mcp'],
  env: { CORAGENTIC_API_URL: 'https://api.coragentic.app' },
};

const CLIENTS = [
  {
    id: 'claude-desktop',
    name: 'Claude Desktop',
    configPath: join(homedir(), 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json'),
    linuxConfigPath: join(homedir(), '.config', 'Claude', 'claude_desktop_config.json'),
    apply(config) {
      config.mcpServers = config.mcpServers || {};
      return config;
    },
    entry() { return SERVER_ENTRY; },
  },
  {
    id: 'cursor',
    name: 'Cursor',
    configPath: join(homedir(), '.cursor', 'mcp.json'),
    apply(config) {
      config.mcpServers = config.mcpServers || {};
      return config;
    },
    entry() { return SERVER_ENTRY; },
  },
  {
    id: 'windsurf',
    name: 'Windsurf',
    configPath: join(homedir(), '.codeium', 'windsurf', 'mcp_config.json'),
    apply(config) {
      config.mcpServers = config.mcpServers || {};
      return config;
    },
    entry() { return SERVER_ENTRY; },
  },
  {
    id: 'codex',
    name: 'Codex CLI',
    configPath: join(homedir(), '.codex', 'config.toml'),
    apply(config) { return config; },
    entry() {
      // Codex uses TOML; emit an mcp_servers block. We parse crudely because the
      // rest of the file is user-owned — we only append if our block is missing.
      return SERVER_ENTRY;
    },
    tomlBlock: `[mcp_servers.coragentic]\ncommand = "npx"\nargs = ["-y", "@coragentic/mcp"]\n\n[mcp_servers.coragentic.env]\nCORAGENTIC_API_URL = "https://api.coragentic.app"\n`,
    marker: '[mcp_servers.coragentic]',
  },
];

function readJsonConfig(path) {
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    throw new Error(`Cannot parse existing config at ${path} — fix or back it up, then rerun.`);
  }
}

function writeJsonConfig(path, config) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`);
}

function installJsonClient(client, { dryRun }) {
  const path = client.configPath;
  const config = readJsonConfig(path);
  client.apply(config);
  const already = config.mcpServers?.coragentic;
  if (already) return { client: client.name, path, status: 'already-installed' };
  if (dryRun) return { client: client.name, path, status: 'would-install' };
  config.mcpServers.coragentic = client.entry();
  writeJsonConfig(path, config);
  return { client: client.name, path, status: 'installed' };
}

function installTomlClient(client, { dryRun }) {
  const path = client.configPath;
  const existing = existsSync(path) ? readFileSync(path, 'utf8') : '';
  if (existing.includes(client.marker)) return { client: client.name, path, status: 'already-installed' };
  if (dryRun) return { client: client.name, path, status: 'would-install' };
  mkdirSync(dirname(path), { recursive: true });
  const block = `${existing.endsWith('\n') || !existing ? '' : '\n'}${client.tomlBlock}`;
  writeFileSync(path, existing + block);
  return { client: client.name, path, status: 'installed' };
}

export function installToAllClients({ dryRun = false } = {}) {
  return CLIENTS.map((client) => {
    const path = client.tomlBlock ? client.configPath : (existsSync(client.configPath) ? client.configPath : client.linuxConfigPath || client.configPath);
    const target = { ...client, configPath: path };
    return client.tomlBlock ? installTomlClient(target, { dryRun }) : installJsonClient(target, { dryRun });
  });
}

const TOOL_NAMES = (() => {
  try { return createServer({ apiUrl: 'https://api.coragentic.app' }) && ['discover_agents']; } catch { return []; }
})();

function printHelp() {
  process.stdout.write(`@coragentic/mcp

Usage:
  npx @coragentic/mcp install      Register this MCP server in Claude Desktop, Cursor, Windsurf, and Codex
  npx @coragentic/mcp install --dry-run
  npx @coragentic/mcp              Start the MCP stdio server (requires CORAGENTIC_API_URL, defaults to the hosted API)

Environment:
  CORAGENTIC_API_URL               Coragentic API base URL (default: https://api.coragentic.app)
`);
}

const args = process.argv.slice(2);
if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
  printHelp();
} else if (args[0] === 'install') {
  const dryRun = args.includes('--dry-run');
  const results = installToAllClients({ dryRun });
  process.stdout.write(`${dryRun ? 'Dry run — no changes written.\n\n' : 'Coragentic MCP installed.\n\n'}`);
  for (const result of results) {
    process.stdout.write(`  ${result.client.padEnd(16)} ${result.status.padEnd(18)} ${result.path}\n`);
  }
  process.stdout.write(`\nRestart your AI client to pick up the new MCP server.\n`);
} else {
  process.stdout.write(`Unknown command: ${args[0]}\n\n`);
  printHelp();
  process.exitCode = 1;
}
