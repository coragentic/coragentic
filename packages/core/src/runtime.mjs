import { evaluateSpend } from './policy.mjs';

const DEFAULT_TIMEOUT_MS = 30_000;
function errorMessage(error) { return error instanceof Error ? error.message : String(error); }

export function createAgentRuntime({ manifest, tools, policy, memory, audit } = {}) {
  if (!manifest || typeof manifest !== 'object') throw new TypeError('manifest is required');
  const toolMap = new Map(Object.entries(tools ?? {}));
  if (memory && ['retain', 'recall', 'forget'].some((method) => typeof memory[method] !== 'function')) throw new TypeError('memory adapter must provide retain, recall, and forget methods');
  const allowed = new Set((manifest.services ?? []).flatMap((service) => service.tools ?? []));
  const emit = typeof audit === 'function' ? audit : () => {};
  const spentByDay = new Map();
  const listTools = () => [...toolMap.keys()].filter((name) => allowed.size === 0 || allowed.has(name));
  async function executeTool(name, input = {}, ctx = {}) {
    const eventBase = { agentId: manifest.id, tool: name, input, at: new Date().toISOString() };
    emit({ ...eventBase, status: 'requested' });
    const tool = toolMap.get(name);
    if (!tool || (allowed.size > 0 && !allowed.has(name))) { emit({ ...eventBase, status: 'rejected', reason: 'tool is not allowlisted' }); throw new Error(`tool is not allowlisted: ${name}`); }
    try {
      if (typeof tool.inputSchema === 'function' && !(await tool.inputSchema(input))) throw new Error('input schema rejected input');
      const request = ctx.request;
      if (request?.type === 'spend') {
        const day = new Date().toISOString().slice(0, 10);
        const result = evaluateSpend(policy, { ...request, spentTodayAtomic: spentByDay.get(day) ?? '0' });
        if (!result.approved) { emit({ ...eventBase, status: 'rejected', reason: result.reason }); throw new Error(`spend policy rejected: ${result.reason}`); }
        spentByDay.set(day, (BigInt(spentByDay.get(day) ?? '0') + BigInt(request.amountAtomic)).toString());
        emit({ ...eventBase, status: 'approved', policy: result });
      }
      const timeoutMs = tool.timeoutMs ?? ctx.timeoutMs ?? DEFAULT_TIMEOUT_MS;
      let timer;
      const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`tool timed out after ${timeoutMs}ms`)), timeoutMs); });
      try { const value = await Promise.race([Promise.resolve().then(() => tool.execute(input, { ...ctx, manifest, tool: name })), timeout]); emit({ ...eventBase, status: 'completed' }); return value; }
      finally { clearTimeout(timer); }
    } catch (error) {
      const message = errorMessage(error);
      if (!message.startsWith('spend policy rejected') && !message.startsWith('input schema')) emit({ ...eventBase, status: 'failed', error: message });
      if (message.startsWith('input schema')) emit({ ...eventBase, status: 'rejected', reason: message });
      throw error;
    }
  }
  async function memoryOperation(operation, args) {
    const eventBase = { agentId: manifest.id, operation, input: args.length === 1 ? args[0] : args, at: new Date().toISOString() };
    emit({ ...eventBase, status: 'requested' });
    if (!memory) {
      const error = new Error('memory adapter is not configured');
      emit({ ...eventBase, status: 'failed', error: error.message });
      throw error;
    }
    try {
      const value = await memory[operation](...args);
      emit({ ...eventBase, status: 'completed' });
      return value;
    } catch (error) {
      const message = errorMessage(error);
      emit({ ...eventBase, status: 'failed', error: message });
      throw error;
    }
  }
  const retain = (...args) => memoryOperation('retain', args);
  const recall = (...args) => memoryOperation('recall', args);
  const forget = (...args) => memoryOperation('forget', args);
  return Object.freeze({ listTools, executeTool, retain, recall, forget });
}
