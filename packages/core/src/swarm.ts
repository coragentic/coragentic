import type { AgentWorker, DecisionAdapter, SwarmAuditEvent, SwarmPlan, SwarmState } from './types.js';
export type SwarmTask<Input = unknown> = { id?: string; idempotencyKey?: string; worker?: string; choice?: unknown; input?: Input; action?: unknown };
export type SwarmRuntime<Input = unknown, Output = unknown> = {
  state: SwarmState;
  adapter: DecisionAdapter;
  route: (choice: unknown) => AgentWorker<Input, Output> | Promise<AgentWorker<Input, Output>>;
  runParallel: (input: Input | Array<SwarmTask<Input>>, options?: { bounded?: number; concurrency?: number }) => Promise<Array<{ worker: string; idempotencyKey: string; result: Output; score: number; idempotent?: boolean }>>;
  score: (result: Output) => number;
  gate: (action: unknown) => Promise<boolean>;
};
export declare function createDeterministicFallbackAdapter(): DecisionAdapter;
export declare function createSwarmRuntime<Input = unknown, Output = unknown>(options: { plan: SwarmPlan<Input, Output>; adapter?: DecisionAdapter; bounded?: number; score?: (result: Output) => number; gate?: SwarmPlan<Input, Output>['gate']; escalate?: (event: SwarmAuditEvent) => void | Promise<void>; audit?: (event: SwarmAuditEvent) => void }): SwarmRuntime<Input, Output>;
