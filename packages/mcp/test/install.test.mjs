import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const installScript = fileURLToPath(new URL('../src/install.mjs', import.meta.url));

function runInstaller(home, ...args) {
  return execFileSync(process.execPath, [installScript, ...args], {
    env: { ...process.env, HOME: home },
    encoding: 'utf8',
  });
}

test('install writes valid MCP entries for JSON and TOML clients', () => {
  const home = mkdtempSync(join(tmpdir(), 'coragentic-install-'));
  try {
    const output = runInstaller(home, 'install');
    assert.match(output, /Claude Desktop\s+installed/);
    assert.match(output, /Cursor\s+installed/);

    const cursor = JSON.parse(readFileSync(join(home, '.cursor', 'mcp.json'), 'utf8'));
    assert.equal(cursor.mcpServers.coragentic.command, 'npx');
    assert.deepEqual(cursor.mcpServers.coragentic.args, ['-y', '@coragentic/mcp']);
    assert.equal(cursor.mcpServers.coragentic.env.CORAGENTIC_API_URL, 'https://api.coragentic.app');

    const codex = readFileSync(join(home, '.codex', 'config.toml'), 'utf8');
    assert.match(codex, /\[mcp_servers\.coragentic\]/);
    assert.match(codex, /CORAGENTIC_API_URL = "https:\/\/api\.coragentic\.app"/);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('install is idempotent — second run reports already-installed and does not duplicate', () => {
  const home = mkdtempSync(join(tmpdir(), 'coragentic-install-idem-'));
  try {
    runInstaller(home, 'install');
    const second = runInstaller(home, 'install');
    assert.match(second, /already-installed/);
    assert.doesNotMatch(second, /\sinstalled\s/);

    const cursor = JSON.parse(readFileSync(join(home, '.cursor', 'mcp.json'), 'utf8'));
    assert.equal(Object.keys(cursor.mcpServers).length, 1);

    const codex = readFileSync(join(home, '.codex', 'config.toml'), 'utf8');
    assert.equal(codex.match(/\[mcp_servers\.coragentic\]/g).length, 1);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('dry-run reports would-install without writing any file', () => {
  const home = mkdtempSync(join(tmpdir(), 'coragentic-install-dry-'));
  try {
    const output = runInstaller(home, 'install', '--dry-run');
    assert.match(output, /would-install/);
    assert.equal(existsSync(join(home, '.cursor')), false);
    assert.equal(existsSync(join(home, '.codex')), false);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('preserves unrelated existing MCP servers in the client config', () => {
  const home = mkdtempSync(join(tmpdir(), 'coragentic-install-preserve-'));
  try {
    mkdirSync(join(home, '.cursor'), { recursive: true });
    writeFileSync(join(home, '.cursor', 'mcp.json'), JSON.stringify({ mcpServers: { 'other-server': { command: 'uvx', args: ['something'] } } }));
    runInstaller(home, 'install');
    const cursor = JSON.parse(readFileSync(join(home, '.cursor', 'mcp.json'), 'utf8'));
    assert.ok(cursor.mcpServers['other-server']);
    assert.ok(cursor.mcpServers.coragentic);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

