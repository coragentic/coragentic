import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';

const expectedSlugs = [
  'overview', 'getting-started', 'architecture', 'agents', 'runtime-policy',
  'private-context', 'swarm-decisions', 'offerings-jobs', 'market-swap', 'mcp-a2a',
  'security', 'self-hosting-testing', 'api-reference',
];

test('documentation route catalogue has every deep-link page', () => {
  const content = readFileSync(new URL('../src/docs/content.ts', import.meta.url), 'utf8');
  const app = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8');
  const page = readFileSync(new URL('../src/pages/DocsPage.tsx', import.meta.url), 'utf8');
  const found = [...content.matchAll(/slug: '([^']+)'/g)].map((match) => match[1]);

  assert.deepEqual(found, expectedSlugs);
  assert.match(app, /path="\/docs\/:slug"/);
  assert.match(page, /<h1/);
});
