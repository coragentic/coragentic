import { evaluateSpend } from './policy.js';
import type { AgentManifest, AgentRuntime, AgentTool, AuditEvent, MemoryAdapter, SpendPolicy, ToolCallContext } from './types.js';

export function createAgentRuntime(options: { manifest: AgentManifest; tools: Record<string, AgentTool>; policy?: SpendPolicy; memory?: MemoryAdapter; audit?: (event: AuditEvent) => void }): AgentRuntime {
  const { manifest, tools, policy, memory, audit } = options;
  if (memory && ['retain', 'recall', 'forget'].some((method) => typeof memory[method] !== 'function')) throw new TypeError('memory adapter must provide retain, recall, and forget methods');
  const allowed = new Set(manifest.services.flatMap((service) => service.tools));
  const spentByDay = new Map<string, bigint>();
  const emit = audit ?? (() => {});
  const listTools = () => Object.keys(tools).filter((name) => allowed.size === 0 || allowed.has(name));
  async function executeTool(name: string, input: unknown = {}, ctx: ToolCallContext = {}) {
    const base = { agentId: manifest.id, tool: name, input, at: new Date().toISOString() };
    emit({ ...base, status: 'requested' });
    const tool = tools[name];
    if (!tool || (allowed.size > 0 && !allowed.has(name))) { emit({ ...base, status: 'rejected', reason: 'tool is not allowlisted' }); throw new Error(`tool is not allowlisted: ${name}`); }
    try {
      if (tool.inputSchema && !(await tool.inputSchema(input))) throw new Error('input schema rejected input');
      if (ctx.request?.type === 'spend') {
        const day = new Date().toISOString().slice(0, 10);
        const result = evaluateSpend(policy, { ...ctx.request, spentTodayAtomic: spentByDay.get(day) ?? 0 });
        if (!result.approved) { emit({ ...base, status: 'rejected', reason: result.reason }); throw new Error(`spend policy rejected: ${result.reason}`); }
        spentByDay.set(day, (spentByDay.get(day) ?? BigInt(0)) + BigInt(ctx.request.amountAtomic));
        emit({ ...base, status: 'approved', policy: result });
      }
      const timeoutMs = tool.timeoutMs ?? ctx.timeoutMs ?? 30_000;
      let timer: ReturnType<typeof setTimeout>;
      const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`tool timed out after ${timeoutMs}ms`)), timeoutMs); });
      try { const value = await Promise.race([Promise.resolve(tool.execute(input, { ...ctx, manifest, tool: name })), timeout]); emit({ ...base, status: 'completed' }); return value; } finally { clearTimeout(timer!); }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!message.startsWith('spend policy rejected') && !message.startsWith('input schema')) emit({ ...base, status: 'failed', error: message });
      if (message.startsWith('input schema')) emit({ ...base, status: 'rejected', reason: message });
      throw error;
    }
  }
  async function memoryOperation(operation: 'retain' | 'recall' | 'forget', args: unknown[]) {
    const base = { agentId: manifest.id, operation, input: args.length === 1 ? args[0] : args, at: new Date().toISOString() };
    emit({ ...base, status: 'requested' });
    if (!memory) {
      const error = new Error('memory adapter is not configured');
      emit({ ...base, status: 'failed', error: error.message });
      throw error;
    }
    try { const value = await memory[operation](...args); emit({ ...base, status: 'completed' }); return value; }
    catch (error) { const message = error instanceof Error ? error.message : String(error); emit({ ...base, status: 'failed', error: message }); throw error; }
  }
  return Object.freeze({ listTools, executeTool, retain: (...args: unknown[]) => memoryOperation('retain', args), recall: (...args: unknown[]) => memoryOperation('recall', args), forget: (...args: unknown[]) => memoryOperation('forget', args) });
}
