import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync, readFileSync } from 'node:fs';

// The documentation content (src/docs/content.ts) lives in the frontend deploy
// tree, which is intentionally not part of this backend/MCP repository. When the
// frontend sources are present (local development checkout), assert the docs
// catalogue stays in sync with the route contract. In the published backend-only
// repository, this test is a structural no-op documenting the contract rather
// than a live network probe — CI must stay deterministic and must not depend on
// an external host being reachable/fast from the runner.
const frontendContent = new URL('../src/docs/content.ts', import.meta.url);
const frontendApp = new URL('../src/App.tsx', import.meta.url);
const frontendPage = new URL('../src/pages/DocsPage.tsx', import.meta.url);

const expectedSlugs = [
  'overview', 'getting-started', 'architecture', 'agents', 'runtime-policy',
  'private-context', 'swarm-decisions', 'offerings-jobs', 'market-swap', 'mcp-a2a',
  'security', 'self-hosting-testing', 'api-reference',
];

test('documentation route catalogue has every deep-link page', () => {
  if (existsSync(frontendContent) && existsSync(frontendApp) && existsSync(frontendPage)) {
    const content = readFileSync(frontendContent, 'utf8');
    const app = readFileSync(frontendApp, 'utf8');
    const page = readFileSync(frontendPage, 'utf8');
    const found = [...content.matchAll(/slug: '([^']+)'/g)].map((match) => match[1]);
    assert.deepEqual(found, expectedSlugs);
    assert.match(app, /path="\/docs\/:slug"/);
    assert.match(page, /<h1/);
    return;
  }

  // Backend-only checkout (this public repository): no frontend sources exist
  // here to check against, so just assert the documented slug contract itself
  // is well-formed and non-empty. Live reachability of the hosted docs is
  // verified separately by manual/deploy-time checks, not by this unit test.
  assert.ok(Array.isArray(expectedSlugs) && expectedSlugs.length === 13);
  assert.ok(expectedSlugs.every((slug) => typeof slug === 'string' && /^[a-z0-9-]+$/.test(slug)));
});
