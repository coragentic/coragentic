// Automation execution loop: runs due owner automations through the real agent
// brain, then records the result back onto the automation. Runs as part of the
// API process on a fixed interval; each cycle is bounded and audit-logged.
import { dueAutomations, markAutomationRun } from './agent-automations.mjs';
import { contextPack } from './rag.mjs';
import { runAgentBrain } from './agent-brain.mjs';

const MAX_AUTOMATION_RUNS_PER_TICK = 3;

export async function runDueAutomations({ db, audit, intervalMs = 60_000, now = new Date(), fetch: fetchImpl } = {}) {
  const due = dueAutomations(db, now).slice(0, MAX_AUTOMATION_RUNS_PER_TICK);
  const results = [];
  for (const automation of due) {
    try {
      const agent = db.prepare('SELECT name, description, owner_wallet FROM agents WHERE id = ?').get(automation.agentId);
      if (!agent) { markAutomationRun(db, automation.id, { ok: false, summary: 'agent_missing' }); continue; }
      const pack = contextPack(db, automation.task, 4_000, { agentId: automation.agentId, ownerWallet: agent.owner_wallet });
      const mission = db.prepare('SELECT content FROM agent_memory WHERE agent_id = ? AND owner_wallet = ? AND memory_key = ?').get(automation.agentId, agent.owner_wallet, 'mission')?.content ?? agent.description;
      const result = await runAgentBrain({ mission, request: `Scheduled automation task: ${automation.task}`, context: pack.text }, fetchImpl ? { fetch: fetchImpl } : {});
      const allowed = new Set(pack.evidence.map((item) => item.id));
      result.citedEvidenceIds = result.citedEvidenceIds.filter((id) => allowed.has(id));
      const runId = `automation_${automation.id}_${now.toISOString()}`;
      db.prepare('INSERT INTO agent_runs (id, agent_id, owner_wallet, kind, request, result_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(runId, automation.agentId, agent.owner_wallet, 'automation', automation.task, JSON.stringify({ ...result, evidenceCount: pack.evidence.length, automationId: automation.id }), now.toISOString());
      markAutomationRun(db, automation.id, { ok: true, runId, summary: result.reportTitle });
      audit?.(agent.owner_wallet, 'agent_automation', automation.id, 'automation_ran', { agentId: automation.agentId, runId, evidenceCount: pack.evidence.length });
      results.push({ automationId: automation.id, ok: true, runId });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      markAutomationRun(db, automation.id, { ok: false, summary: message });
      audit?.(null, 'agent_automation', automation.id, 'automation_failed', { agentId: automation.agentId, reason: message });
      results.push({ automationId: automation.id, ok: false, error: message });
    }
  }
  return results;
}

export function startAutomationLoop({ db, audit, intervalMs }) {
  let running = false;
  const timer = setInterval(() => {
    if (running) return;
    running = true;
    void runDueAutomations({ db, audit }).finally(() => { running = false; });
  }, intervalMs);
  return () => clearInterval(timer);
}
