export type AgentService = {
  id: string;
  type: string;
  endpoint?: string;
  tools: string[];
};
export type AgentManifest = { id: string; name: string; description?: string; version: string; services: AgentService[]; registrations?: Record<string, unknown> };
export type AgentTool = { description?: string; inputSchema?: (input: unknown) => boolean | Promise<boolean>; execute: (input: unknown, ctx: ToolCallContext) => unknown | Promise<unknown>; timeoutMs?: number };
export type SpendPolicy = { maxAtomicPerCall?: string | number | bigint; dailyAtomic?: string | number | bigint; allowedAssets?: string[]; allowedRecipients?: string[] };
export type ToolCallContext = { request?: { type: 'spend'; amountAtomic: string | number | bigint; asset?: string; recipient?: string }; timeoutMs?: number; manifest?: AgentManifest; tool?: string; [key: string]: unknown };
export type AuditEvent = { agentId: string; tool?: string; operation?: 'retain' | 'recall' | 'forget'; input: unknown; at: string; status: 'requested' | 'approved' | 'rejected' | 'completed' | 'failed'; reason?: string; error?: string; policy?: { approved: boolean; reason: string } };
export type MemoryAdapter = { retain: (...args: unknown[]) => unknown | Promise<unknown>; recall: (...args: unknown[]) => unknown | Promise<unknown>; forget: (...args: unknown[]) => unknown | Promise<unknown> };
export type AgentRuntime = { listTools: () => string[]; executeTool: (name: string, input?: unknown, ctx?: ToolCallContext) => Promise<unknown>; retain: (...args: unknown[]) => Promise<unknown>; recall: (...args: unknown[]) => Promise<unknown>; forget: (...args: unknown[]) => Promise<unknown> };

export type AgentWorker<Input = unknown, Output = unknown> = { id: string; run: (input: Input, context: SwarmWorkerContext) => Output | Promise<Output> };
export type SwarmAuditEvent = { swarmId?: string; type: 'gate' | 'worker'; workerId?: string; idempotencyKey?: string; status: 'requested' | 'completed' | 'rejected' | 'failed'; action?: unknown; reason?: string; error?: string; score?: number; at: string };
export type SwarmState = { planId?: string; status: 'idle' | 'running' | 'completed'; results: Array<{ worker: string; idempotencyKey: string; result: unknown; score: number }>; decisions: unknown[]; audit: SwarmAuditEvent[] };
export type SwarmWorkerContext = { worker: string; state: SwarmState; plan: SwarmPlan; [key: string]: unknown };
export type DecisionAdapter = {
  decide?: (choice: unknown, workers: AgentWorker[]) => AgentWorker | string | undefined;
  route?: (choice: unknown, workers: AgentWorker[]) => AgentWorker | string | undefined;
  choice?: (input: unknown, options?: unknown) => unknown | Promise<unknown>;
  score?: (input: unknown, options?: unknown) => unknown | Promise<unknown>;
  noul?: (input: unknown, options?: unknown) => unknown | Promise<unknown>;
  batchChoice?: (inputs: unknown[], options?: unknown) => unknown[] | Promise<unknown[]>;
};
export type SwarmPlan<Input = unknown, Output = unknown> = { id?: string; workers: Array<AgentWorker<Input, Output>>; maxConcurrency?: number; bounded?: number; adapter?: DecisionAdapter; score?: (result: Output) => number; gate?: (action: unknown, state: SwarmState) => boolean | { allowed: boolean; reason?: string } | Promise<boolean | { allowed: boolean; reason?: string }>; escalate?: (event: SwarmAuditEvent) => void | Promise<void> };
