const TEMPLATES = {
  research: ({ description }) => [
    { key: 'mission', tags: ['system', 'mission'], content: `Mission: ${description}\n\nProduce grounded research briefs. State uncertainty explicitly; never fill gaps with invented facts.` },
    { key: 'operating-context', tags: ['system', 'context'], content: 'Operating context: Start from retained evidence, identify material risks, and keep a short list of unresolved questions.' },
    { key: 'first-task', tags: ['system', 'next-action'], content: 'First task: Write the first research brief. Save source-backed findings, risks, and open questions as separate memory records.' },
  ],
  operator: ({ description }) => [
    { key: 'mission', tags: ['system', 'mission'], content: `Mission: ${description}\n\nTurn goals into concrete milestones, blockers, decisions, and next actions.` },
    { key: 'operating-context', tags: ['system', 'context'], content: 'Operating context: Keep each update actionable. Distinguish evidence, decisions, blockers, and assumptions.' },
    { key: 'first-task', tags: ['system', 'next-action'], content: 'First task: Create an operating brief with the objective, three milestones, the current blocker, and one next action.' },
  ],
  market: ({ description }) => [
    { key: 'mission', tags: ['system', 'mission'], content: `Mission: ${description}\n\nEvaluate market context without treating speculation as fact.` },
    { key: 'operating-context', tags: ['system', 'context'], content: 'Operating context: Record thesis, catalysts, invalidation, risk limits, and the exact evidence behind each conclusion.' },
    { key: 'first-task', tags: ['system', 'next-action'], content: 'First task: Create a market brief: thesis, catalyst, invalidation condition, and risk limit.' },
  ],
  customer: ({ description }) => [
    { key: 'mission', tags: ['system', 'mission'], content: `Mission: ${description}\n\nTurn customer evidence into clear product decisions.` },
    { key: 'operating-context', tags: ['system', 'context'], content: 'Operating context: Separate direct customer quotes from interpretation. Track recurring objections and experiments.' },
    { key: 'first-task', tags: ['system', 'next-action'], content: 'First task: Define the target customer, their top problem, one objection, and a first experiment.' },
  ],
  blank: ({ description }) => [
    { key: 'mission', tags: ['system', 'mission'], content: `Mission: ${description}\n\nEdit this mission before the first run.` },
    { key: 'operating-context', tags: ['system', 'context'], content: 'Operating context: Add the facts, constraints, and working assumptions this agent should retain.' },
    { key: 'first-task', tags: ['system', 'next-action'], content: 'First task: Describe the first outcome you want, then run a grounded analysis against this retained context.' },
  ],
};

export const AGENT_TEMPLATE_IDS = Object.freeze(Object.keys(TEMPLATES));

export function templateCapabilities(template) {
  const capabilities = {
    research: ['context', 'analysis', 'research'],
    operator: ['context', 'analysis', 'planning'],
    market: ['context', 'analysis', 'market-research'],
    customer: ['context', 'analysis', 'customer-research'],
    blank: ['context', 'analysis'],
  }[template];
  if (!capabilities) throw new TypeError('invalid_agent_template');
  return capabilities;
}

export function starterVaultForTemplate(template, agent) {
  const factory = TEMPLATES[template];
  if (!factory) throw new TypeError('invalid_agent_template');
  return factory(agent);
}
