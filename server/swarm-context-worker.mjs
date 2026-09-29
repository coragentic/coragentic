// Real "context-worker" implementation for the built-in swarm demo route
// (POST /v1/swarm/runs with the default worker set). Previously this step
// just declared its capabilities and counted retrieved evidence without
// ever answering the query -- { status: 'declared_not_executed' } -- which
// gave the jev judge nothing substantive to score, so real runs came back
// rejected almost every time regardless of the actual context quality.
//
// This module grounds an answer in exactly the evidence the caller's own
// contextPack() retrieved (never fetches or invents anything outside that),
// and is explicit -- not silently empty -- when there's no evidence to
// ground an answer in.

const DEFAULT_MODEL = 'glm/glm-5.3-flash';
const DEFAULT_API_URL = 'https://api.vikey.ai/v1/chat/completions';
// Same reasoning-token headroom issue as deploy/executors/research-brief.mjs:
// this model spends part of its budget on internal reasoning before the
// final answer, so max_tokens must comfortably exceed the JSON payload size.
const DEFAULT_MAX_TOKENS = 2000;

function buildPrompt(query, text) {
  return `You are answering a query using ONLY the retrieved private context below. Do not use outside knowledge or invent anything not supported by this context. If the context does not actually answer the query, say so honestly in your answer rather than guessing.

Query: ${query}

Retrieved context:
${text}

Respond with ONLY a single JSON object (no prose outside it) with exactly this shape:
{
  "answer": "<direct answer grounded in the context above, or an honest statement that the context does not answer the query>",
  "confidence": <number 0-1, how well the retrieved context actually supports this answer>,
  "citedEvidenceIds": ["<id of each evidence item you actually used>"]
}`;
}

function parseModelOutput(raw) {
  const trimmed = String(raw ?? '').trim();
  const jsonText = trimmed.startsWith('{') ? trimmed : trimmed.slice(trimmed.indexOf('{'), trimmed.lastIndexOf('}') + 1);
  const parsed = JSON.parse(jsonText);
  if (typeof parsed.answer !== 'string' || !parsed.answer.trim()) throw new Error('model returned no answer');
  const confidence = Number(parsed.confidence);
  return {
    answer: parsed.answer.trim(),
    confidence: Number.isFinite(confidence) ? Math.min(1, Math.max(0, confidence)) : 0.5,
    citedEvidenceIds: Array.isArray(parsed.citedEvidenceIds) ? parsed.citedEvidenceIds.filter((id) => typeof id === 'string') : [],
  };
}

export async function runContextWorker(privateContext, { apiKey = process.env.VIKEY_API_KEY, apiUrl = DEFAULT_API_URL, model = DEFAULT_MODEL, maxTokens = DEFAULT_MAX_TOKENS, fetch: fetchImpl = globalThis.fetch } = {}) {
  const query = String(privateContext?.query ?? '').trim();
  const text = String(privateContext?.text ?? '').trim();
  const evidenceCount = Array.isArray(privateContext?.evidence) ? privateContext.evidence.length : 0;

  // Honest empty case: nothing retained yet for this agent to answer from.
  // Never fabricates a plausible-sounding answer with zero grounding.
  if (!evidenceCount || !text) {
    return { status: 'no_evidence', answer: 'This agent has no retained private context yet, so there is nothing grounded to answer from. Save private context in the Memory tab first.', confidence: 0, citedEvidenceIds: [] };
  }

  if (!apiKey) throw new Error('context_worker_no_api_key');

  const response = await fetchImpl(apiUrl, {
    method: 'POST',
    headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model, max_tokens: maxTokens, messages: [{ role: 'user', content: buildPrompt(query, text) }] }),
  });
  if (!response.ok) throw new Error(`context_worker_model_error_${response.status}`);
  const body = await response.json();
  const raw = body?.choices?.[0]?.message?.content;
  if (!raw) throw new Error('context_worker_empty_model_response');
  const parsed = parseModelOutput(raw);
  return { status: 'answered', ...parsed };
}
