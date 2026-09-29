// Agent Research Brief executor.
//
// This is a real, working job executor -- not a placeholder. It generates a
// structured research brief for a job's declared topic using the configured
// LLM provider, grounded in exactly what the job requester asked (topic +
// optional questions). It never fabricates a deliverable: any failure to
// reach the model or parse its output throws, which the worker's existing
// bounded-retry logic (server/worker.mjs) already handles correctly.
//
// Wire this in via CORAGENTIC_JOB_EXECUTOR=file:///path/to/this/file.mjs
// (see deploy/EXECUTOR-CONTRACT.md). Requires VIKEY_API_KEY (or pass apiKey
// directly when constructing for tests).

const DEFAULT_MODEL = 'glm/glm-5.3-flash';
const DEFAULT_API_URL = 'https://api.vikey.ai/v1/chat/completions';
// This model spends part of its token budget on internal reasoning before
// producing the final answer, so max_tokens must comfortably exceed the
// expected JSON payload size or the response comes back empty. Observed live:
// 1200 was insufficient (reasoning alone exhausted it); 4000 works reliably.
const DEFAULT_MAX_TOKENS = 4000;

export function buildPrompt({ topic, questions = [] }) {
  const questionList = questions.length
    ? questions.map((q, i) => `${i + 1}. ${q}`).join('\n')
    : '(no specific questions were asked -- cover the most decision-relevant angles yourself)';
  return `You are producing a research brief for a paying client of an agent operating network. Be precise, cite concrete reasoning, and never invent facts you are not confident about -- say so explicitly if something is uncertain.

Topic: ${topic}

Questions to address:
${questionList}

Respond with ONLY a single JSON object (no prose outside it) with exactly this shape:
{
  "summary": "<2-4 sentence direct answer to the topic>",
  "keyPoints": ["<concrete point>", "..."],
  "risks": ["<a real risk, tradeoff, or caveat>", "..."],
  "openQuestions": ["<something genuinely unresolved or that needs more input>", "..."]
}`;
}

export function parseModelOutput(raw) {
  if (typeof raw !== 'string' || !raw.trim()) throw new Error('could not parse model output: empty response');
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1] : raw;
  const jsonStart = candidate.indexOf('{');
  const jsonEnd = candidate.lastIndexOf('}');
  if (jsonStart === -1 || jsonEnd === -1 || jsonEnd < jsonStart) {
    throw new Error('could not parse model output: no JSON object found');
  }
  let parsed;
  try {
    parsed = JSON.parse(candidate.slice(jsonStart, jsonEnd + 1));
  } catch (error) {
    throw new Error(`could not parse model output: ${error.message}`);
  }
  for (const field of ['summary', 'keyPoints', 'risks', 'openQuestions']) {
    if (!(field in parsed)) throw new Error(`model output missing required field: ${field}`);
  }
  if (typeof parsed.summary !== 'string') throw new Error('model output field summary must be a string');
  for (const field of ['keyPoints', 'risks', 'openQuestions']) {
    if (!Array.isArray(parsed[field])) throw new Error(`model output field ${field} must be an array`);
  }
  return { summary: parsed.summary, keyPoints: parsed.keyPoints, risks: parsed.risks, openQuestions: parsed.openQuestions };
}

export function createResearchBriefExecutor({
  apiKey = process.env.VIKEY_API_KEY || process.env.HERMES_CUSTOM_API_VIKEY_AI_API_KEY,
  apiUrl = DEFAULT_API_URL,
  model = DEFAULT_MODEL,
  maxTokens = DEFAULT_MAX_TOKENS,
  fetchImpl = fetch,
} = {}) {
  return async function researchBriefExecutor(job) {
    if (!apiKey) throw new Error('research brief executor: API key is not configured (set VIKEY_API_KEY)');

    let requirements;
    try {
      requirements = JSON.parse(job.requirements_json || '{}');
    } catch {
      requirements = {};
    }
    const topic = typeof requirements.topic === 'string' ? requirements.topic.trim() : '';
    if (!topic) throw new Error('research brief executor: requirements.topic is required and was not provided by the requester');
    const questions = Array.isArray(requirements.questions)
      ? requirements.questions.filter((q) => typeof q === 'string' && q.trim()).slice(0, 10)
      : [];

    const prompt = buildPrompt({ topic, questions });
    const response = await fetchImpl(apiUrl, {
      method: 'POST',
      headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model, max_tokens: maxTokens, messages: [{ role: 'user', content: prompt }] }),
    });
    if (!response.ok) {
      const detail = typeof response.text === 'function' ? await response.text().catch(() => '') : '';
      throw new Error(`research brief executor: upstream model call failed (${response.status}) ${detail}`.trim());
    }
    const body = await response.json();
    const content = body?.choices?.[0]?.message?.content;
    if (!content) throw new Error('research brief executor: upstream returned no content');
    const brief = parseModelOutput(content);

    return {
      format: 'agent_research_brief_v1',
      jobId: job.id,
      topic,
      questions,
      model,
      generatedAt: new Date().toISOString(),
      brief,
    };
  };
}

export default createResearchBriefExecutor();
