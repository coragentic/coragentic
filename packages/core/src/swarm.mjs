const errorMessage = (error) => error instanceof Error ? error.message : String(error);

export function createDeterministicFallbackAdapter() {
  return Object.freeze({
    choice(input = {}, options = {}) {
      const choices = Array.isArray(input?.choices) ? input.choices : [];
      return { kind: 'choice', choice: choices[0] ?? 'offline', confidence: 1, threshold: options.threshold ?? 0.5, accepted: true, provider: 'offline', metadata: { provider: 'offline' } };
    },
    score() { return { kind: 'score', score: 0.5, confidence: 1, threshold: 0.5, accepted: true, provider: 'offline', metadata: { provider: 'offline' } }; },
    noul() { return { kind: 'noul', allowed: false, confidence: 1, threshold: 0.5, accepted: false, provider: 'offline', metadata: { provider: 'offline' } }; },
    batchChoice(inputs, options) { return inputs.map((input) => this.choice(input, options)); },
    decide(choice, workers) {
      const key = typeof choice === 'string' ? choice : choice?.worker ?? choice?.workerId ?? choice?.id;
      return workers.find((worker) => worker.id === key) ?? [...workers].sort((a, b) => a.id.localeCompare(b.id))[0];
    },
  });
}

export function createSwarmRuntime({ plan, adapter, bounded = plan?.maxConcurrency ?? plan?.bounded ?? Infinity, score, gate, escalate, audit } = {}) {
  if (!plan || !Array.isArray(plan.workers) || plan.workers.length === 0) throw new TypeError('plan with at least one worker is required');
  const workers = plan.workers.map((worker) => typeof worker === 'function' ? { id: worker.name, run: worker } : worker);
  if (workers.some((worker) => !worker?.id || typeof worker.run !== 'function')) throw new TypeError('each swarm worker must provide id and run');
  const byId = new Map(workers.map((worker) => [worker.id, worker]));
  const decisionAdapter = adapter ?? plan.adapter ?? createDeterministicFallbackAdapter();
  const emit = typeof audit === 'function' ? audit : () => {};
  const state = { planId: plan.id, status: 'idle', results: [], decisions: [], audit: [] };
  const cache = new Map();
  const record = (event) => { state.audit.push(event); emit(event); };
  const choose = (choice) => {
    const selected = typeof decisionAdapter.decide === 'function' ? decisionAdapter.decide(choice, workers) : typeof decisionAdapter.route === 'function' ? decisionAdapter.route(choice, workers) : null;
    const worker = typeof selected === 'string' ? byId.get(selected) : selected;
    return worker && byId.has(worker.id) ? worker : createDeterministicFallbackAdapter().decide(choice, workers);
  };
  const route = (choice) => {
    if (typeof decisionAdapter.choice === 'function' && !decisionAdapter.decide && !decisionAdapter.route) {
      return Promise.resolve(decisionAdapter.choice(choice, { workers })).then((decision) => choose(decision?.choice ?? decision));
    }
    return choose(choice);
  };
  const scoreResult = (result) => typeof score === 'function' ? score(result) : typeof plan.score === 'function' ? plan.score(result) : (typeof result === 'number' ? result : result?.score ?? result?.value ?? 0);
  const gateAction = async (action) => {
    const gateAdapter = adapter?.noul ?? plan.adapter?.noul;
    const allowed = typeof gate === 'function' ? await gate(action, state) : typeof plan.gate === 'function' ? await plan.gate(action, state) : typeof gateAdapter === 'function' ? (await gateAdapter(action, state))?.allowed !== false : true;
    const ok = allowed === true || (allowed && allowed.allowed !== false);
    if (!ok) {
      const event = { swarmId: plan.id, type: 'gate', status: 'rejected', action, reason: allowed?.reason ?? 'action gated', at: new Date().toISOString() };
      record(event);
      if (typeof escalate === 'function') await escalate(event);
      if (typeof plan.escalate === 'function') await plan.escalate(event);
    }
    return ok;
  };
  async function runOne(task, index) {
    const descriptor = typeof task === 'function' ? { run: task } : task && typeof task === 'object' ? task : { input: task };
    const key = descriptor.idempotencyKey ?? descriptor.id ?? `${descriptor.worker ?? index}:${JSON.stringify(descriptor.input ?? task)}`;
    if (cache.has(key)) return { ...await cache.get(key), idempotent: true };
    const promise = (async () => {
      const action = descriptor.action ?? descriptor;
      if (!(await gateAction(action))) throw new Error(`action gated: ${key}`);
      const worker = descriptor.worker ? byId.get(descriptor.worker) : choose(descriptor.choice ?? descriptor);
      if (!worker) throw new Error(`worker not found: ${descriptor.worker}`);
      const started = { swarmId: plan.id, type: 'worker', workerId: worker.id, idempotencyKey: key, status: 'requested', at: new Date().toISOString() };
      record(started);
      try {
        const result = await worker.run(descriptor.input ?? (typeof task === 'object' ? task : task), { ...descriptor, worker: worker.id, state, plan });
        const item = { worker: worker.id, idempotencyKey: key, result, score: scoreResult(result) };
        state.results.push(item);
        record({ ...started, status: 'completed', score: item.score });
        return item;
      } catch (error) {
        record({ ...started, status: 'failed', error: errorMessage(error) });
        throw error;
      }
    })();
    cache.set(key, promise);
    return promise;
  }
  async function runParallel(input, options = {}) {
    const tasks = Array.isArray(input) ? input : workers.map((worker) => ({ worker: worker.id, input }));
    const limit = Math.max(1, Number(options.bounded ?? options.concurrency ?? (typeof options === 'number' ? options : bounded)) || 1);
    state.status = 'running';
    const output = new Array(tasks.length);
    let next = 0;
    async function consume() { while (next < tasks.length) { const index = next++; output[index] = await runOne(tasks[index], index); } }
    await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, consume));
    state.status = 'completed';
    return output;
  }
  return Object.freeze({ state, route, runParallel, score: scoreResult, gate: gateAction, adapter: decisionAdapter });
}
