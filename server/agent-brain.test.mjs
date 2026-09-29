import test from 'node:test';
import assert from 'node:assert/strict';
import { buildAgentBrainPrompt, parseAgentBrainOutput } from './agent-brain.mjs';

test('buildAgentBrainPrompt binds the answer to an agent mission, user request and retained context', () => {
  const prompt = buildAgentBrainPrompt({
    mission: 'Research payment risk',
    request: 'What is the main blocker?',
    context: '[m1] key=blocker: Sandbox API keys expire Friday',
  });
  assert.match(prompt, /Research payment risk/);
  assert.match(prompt, /What is the main blocker/);
  assert.match(prompt, /Sandbox API keys expire Friday/);
  assert.match(prompt, /never invent/i);
});

test('parseAgentBrainOutput accepts a structured answer with next actions and cited ids', () => {
  const result = parseAgentBrainOutput(JSON.stringify({
    answer: 'The keys expiring Friday are the blocker.',
    confidence: 0.91,
    citedEvidenceIds: ['m1'],
    nextActions: ['Rotate keys before Friday'],
    reportTitle: 'Payment risk brief',
  }));
  assert.equal(result.answer, 'The keys expiring Friday are the blocker.');
  assert.equal(result.confidence, 0.91);
  assert.deepEqual(result.citedEvidenceIds, ['m1']);
  assert.deepEqual(result.nextActions, ['Rotate keys before Friday']);
});

test('parseAgentBrainOutput refuses an empty or malformed answer', () => {
  assert.throws(() => parseAgentBrainOutput('{}'), /no answer/i);
  assert.throws(() => parseAgentBrainOutput('not json'), /Unexpected token|JSON/);
});
