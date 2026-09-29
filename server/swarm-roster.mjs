// The standing swarm roster: 20 named workers, each with a distinct role.
// When a swarm run is created without an explicit worker set, this roster is
// what actually executes -- so the Swarm page shows 20 named specialists
// working, not one anonymous "context-worker".
export const WORKER_ROSTER = [
  { id: 'context-worker', role: 'Retrieval', capabilities: ['context'] },
  { id: 'analyst', role: 'Analysis', capabilities: ['analysis'] },
  { id: 'summarizer', role: 'Summarization', capabilities: ['analysis'] },
  { id: 'risk-sentinel', role: 'Risk review', capabilities: ['analysis'] },
  { id: 'fact-checker', role: 'Grounding audit', capabilities: ['analysis'] },
  { id: 'historian', role: 'Timeline & versions', capabilities: ['analysis'] },
  { id: 'strategist', role: 'Next-step planning', capabilities: ['analysis'] },
  { id: 'skeptic', role: 'Counter-argument', capabilities: ['analysis'] },
  { id: 'synthesist', role: 'Synthesis', capabilities: ['analysis'] },
  { id: 'data-steward', role: 'Context hygiene', capabilities: ['context'] },
  { id: 'gap-hunter', role: 'Missing-evidence scan', capabilities: ['context', 'analysis'] },
  { id: 'translator', role: 'Plain-language rewrite', capabilities: ['analysis'] },
  { id: 'prioritizer', role: 'Importance ranking', capabilities: ['analysis'] },
  { id: 'trend-watcher', role: 'Change over time', capabilities: ['analysis'] },
  { id: 'quality-lead', role: 'Answer quality gate', capabilities: ['analysis'] },
  { id: 'citation-auditor', role: 'Citation check', capabilities: ['analysis'] },
  { id: 'scenario-builder', role: 'What-if framing', capabilities: ['analysis'] },
  { id: 'compliance-eye', role: 'Policy & boundary check', capabilities: ['analysis'] },
  { id: 'meta-reviewer', role: 'Final review', capabilities: ['analysis'] },
  { id: 'report-writer', role: 'Final report', capabilities: ['analysis'] },
];
