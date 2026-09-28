import type { SpendPolicy } from './types.js';
export type SpendRequest = { amountAtomic: string | number | bigint; asset?: string; recipient?: string; spentTodayAtomic?: string | number | bigint };
export type SpendDecision = { approved: boolean; reason: string };
export function evaluateSpend(policy: SpendPolicy = {}, request: SpendRequest): SpendDecision {
  const amount = atomic(request.amountAtomic, 'amountAtomic');
  const daily = atomic(request.spentTodayAtomic ?? 0, 'spentTodayAtomic');
  if (policy.maxAtomicPerCall != null && amount > atomic(policy.maxAtomicPerCall, 'maxAtomicPerCall')) return { approved: false, reason: 'maxAtomicPerCall exceeded' };
  if (policy.dailyAtomic != null && daily + amount > atomic(policy.dailyAtomic, 'dailyAtomic')) return { approved: false, reason: 'dailyAtomic exceeded' };
  if (policy.allowedAssets?.length && !policy.allowedAssets.includes(request.asset ?? '')) return { approved: false, reason: 'asset is not allowed' };
  if (policy.allowedRecipients?.length && !policy.allowedRecipients.includes(request.recipient ?? '')) return { approved: false, reason: 'recipient is not allowed' };
  return { approved: true, reason: 'approved' };
}
function atomic(value: string | number | bigint, field: string): bigint { if (typeof value === 'number' && !Number.isSafeInteger(value)) throw new TypeError(`${field} must be an integer amount`); try { return BigInt(value); } catch { throw new TypeError(`${field} must be an integer amount`); } }
