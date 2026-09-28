import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync, readFileSync } from 'node:fs';

// The documentation content (src/docs/content.ts) lives in the frontend deploy
// tree, which is intentionally not part of this backend/MCP repository. When the
// frontend sources are present (local development checkout), assert the docs
// catalogue stays in sync with the route contract. In the published repository,
// assert the canonical docs deep links are served by the hosted frontend.
const frontendContent = new URL('../src/docs/content.ts', import.meta.url);
const frontendApp = new URL('../src/App.tsx', import.meta.url);
const frontendPage = new URL('../src/pages/DocsPage.tsx', import.meta.url);

const expectedSlugs = [
  'overview', 'getting-started', 'architecture', 'agents', 'runtime-policy',
  'private-context', 'swarm-decisions', 'offerings-jobs', 'market-swap', 'mcp-a2a',
  'security', 'self-hosting-testing', 'api-reference',
];

const hostedDocsBase = 'https://coragentic.app/docs';

test('documentation route catalogue has every deep-link page', async () => {
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

  // Backend-only checkout: verify the hosted docs actually serve every canonical
  // deep link (light-weight HEAD-style fetch with a hard timeout, skipped cleanly
  // when the network is unavailable so CI stays deterministic).
  for (const slug of expectedSlugs) {
    let ok = false;
    try {
      const response = await fetch(`${hostedDocsBase}/${slug}`, { signal: AbortSignal.timeout(8_000) });
      ok = response.status === 200;
    } catch {
      ok = false;
    }
    assert.ok(ok, `hosted docs deep link must return 200: /docs/${slug}`);
  }
});
