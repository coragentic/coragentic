const DEFAULT_MODEL = 'glm/glm-5.3-flash';
const DEFAULT_API_URL = 'https://api.vikey.ai/v1/chat/completions';
const DEFAULT_MAX_TOKENS = 2600;

export function buildAgentBrainPrompt({ mission, request, context }) {
  return `You are the native operating brain for one private agent. Work only from the agent mission and retained context below. Never invent facts, sources, completed actions, external calls, wallet activity, or automation runs. If retained context is insufficient, say that clearly and propose the smallest next action needed to resolve it.

Agent mission:
${mission}

Operator request:
${request}

Retained private context:
${context || '(no retained context found)'}

Return ONLY JSON:
{
  "answer": "<direct grounded answer>",
  "confidence": <0-1>,
  "citedEvidenceIds": ["<only IDs actually used>"],
  "nextActions": ["<1-3 concrete next actions>"],
  "reportTitle": "<short report title>"
}`;
}

export function parseAgentBrainOutput(raw) {
  const text = String(raw ?? '').trim();
  const candidate = text.startsWith('{') ? text : text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1);
  const parsed = JSON.parse(candidate);
  if (typeof parsed.answer !== 'string' || !parsed.answer.trim()) throw new Error('agent brain returned no answer');
  const confidence = Number(parsed.confidence);
  return {
    answer: parsed.answer.trim(),
    confidence: Number.isFinite(confidence) ? Math.max(0, Math.min(1, confidence)) : 0.5,
    citedEvidenceIds: Array.isArray(parsed.citedEvidenceIds) ? parsed.citedEvidenceIds.filter((id) => typeof id === 'string').slice(0, 12) : [],
    nextActions: Array.isArray(parsed.nextActions) ? parsed.nextActions.filter((value) => typeof value === 'string' && value.trim()).map((value) => value.trim()).slice(0, 3) : [],
    reportTitle: typeof parsed.reportTitle === 'string' && parsed.reportTitle.trim() ? parsed.reportTitle.trim().slice(0, 160) : 'Agent brief',
  };
}

export async function runAgentBrain({ mission, request, context }, { apiKey = process.env.VIKEY_API_KEY, apiUrl = DEFAULT_API_URL, model = DEFAULT_MODEL, maxTokens = DEFAULT_MAX_TOKENS, fetch: fetchImpl = globalThis.fetch } = {}) {
  if (!apiKey) throw new Error('agent_brain_not_configured');
  const response = await fetchImpl(apiUrl, {
    method: 'POST',
    headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model, max_tokens: maxTokens, messages: [{ role: 'user', content: buildAgentBrainPrompt({ mission, request, context }) }] }),
  });
  if (!response.ok) throw new Error(`agent_brain_model_error_${response.status}`);
  const body = await response.json();
  const content = body?.choices?.[0]?.message?.content;
  if (!content) throw new Error('agent_brain_empty_model_response');
  return parseAgentBrainOutput(content);
}
