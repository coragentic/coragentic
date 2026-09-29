import test from 'node:test';
import assert from 'node:assert/strict';
import { createResearchBriefExecutor, buildPrompt, parseModelOutput } from './research-brief.mjs';

const job = {
  id: 'job-1',
  requirements_json: JSON.stringify({ topic: 'Robinhood Chain settlement finality', questions: ['What confirmation depth is safe?', 'What are the tradeoffs?'] }),
};

test('buildPrompt renders the topic and questions into a single grounded instruction', () => {
  const prompt = buildPrompt({ topic: 'X', questions: ['Q1', 'Q2'] });
  assert.match(prompt, /X/);
  assert.match(prompt, /Q1/);
  assert.match(prompt, /Q2/);
  assert.match(prompt, /JSON/i);
});

test('parseModelOutput extracts a valid structured brief from a fenced JSON code block', () => {
  const raw = 'Some preamble\n```json\n{"summary":"s","keyPoints":["a","b"],"risks":["r"],"openQuestions":["q"]}\n```\ntrailing';
  const parsed = parseModelOutput(raw);
  assert.deepEqual(parsed, { summary: 's', keyPoints: ['a', 'b'], risks: ['r'], openQuestions: ['q'] });
});

test('parseModelOutput extracts raw JSON with no fence', () => {
  const parsed = parseModelOutput('{"summary":"s","keyPoints":[],"risks":[],"openQuestions":[]}');
  assert.equal(parsed.summary, 's');
});

test('parseModelOutput throws on unparseable output rather than fabricating a result', () => {
  assert.throws(() => parseModelOutput('not json at all'), /could not parse/i);
});

test('parseModelOutput throws when required fields are missing or wrong-typed', () => {
  assert.throws(() => parseModelOutput('{"summary":"s"}'), /missing/i);
  assert.throws(() => parseModelOutput('{"summary":123,"keyPoints":[],"risks":[],"openQuestions":[]}'), /summary/i);
});

test('executor calls the LLM with a grounded prompt and returns a structured deliverable', async () => {
  let capturedBody;
  const fetchImpl = async (url, init) => {
    capturedBody = JSON.parse(init.body);
    return {
      ok: true,
      status: 200,
      json: async () => ({ choices: [{ message: { content: '```json\n{"summary":"Confirmation depth of 3 blocks is a reasonable default.","keyPoints":["Robinhood Chain produces blocks fast","3 confirmations adds negligible latency"],"risks":["A reorg deeper than the configured depth could still slip through"],"openQuestions":["Has Robinhood Chain published a formal finality guarantee?"]}\n```' } }] }),
    };
  };
  const executor = createResearchBriefExecutor({ apiKey: 'test-key', fetchImpl, model: 'glm/glm-5.3-flash' });
  const deliverable = await executor(job);

  assert.equal(capturedBody.model, 'glm/glm-5.3-flash');
  assert.match(capturedBody.messages[0].content, /Robinhood Chain settlement finality/);
  assert.equal(capturedBody.messages[0].content.includes('What confirmation depth is safe?'), true);

  assert.equal(deliverable.jobId, 'job-1');
  assert.equal(deliverable.format, 'agent_research_brief_v1');
  assert.equal(deliverable.model, 'glm/glm-5.3-flash');
  assert.equal(typeof deliverable.generatedAt, 'string');
  assert.equal(deliverable.brief.summary, 'Confirmation depth of 3 blocks is a reasonable default.');
  assert.equal(deliverable.brief.keyPoints.length, 2);
});

test('executor throws (never fabricates a deliverable) when the LLM call fails', async () => {
  const fetchImpl = async () => ({ ok: false, status: 500, text: async () => 'upstream error' });
  const executor = createResearchBriefExecutor({ apiKey: 'test-key', fetchImpl });
  await assert.rejects(() => executor(job), /upstream/i);
});

test('executor throws when requirements are missing a topic, never guesses one', async () => {
  const executor = createResearchBriefExecutor({ apiKey: 'test-key', fetchImpl: async () => { throw new Error('should not be called'); } });
  await assert.rejects(() => executor({ id: 'job-2', requirements_json: '{}' }), /topic is required/i);
});

test('executor throws immediately with no network call when apiKey is not configured', async () => {
  let called = false;
  const executor = createResearchBriefExecutor({ apiKey: '', fetchImpl: async () => { called = true; } });
  await assert.rejects(() => executor(job), /api key/i);
  assert.equal(called, false);
});
