export function evaluateSpend(policy = {}, request = {}) {
  const amount = toAtomic(request.amountAtomic, 'amountAtomic');
  const daily = toAtomic(request.spentTodayAtomic ?? '0', 'spentTodayAtomic');
  if (policy.maxAtomicPerCall != null && amount > toAtomic(policy.maxAtomicPerCall, 'maxAtomicPerCall')) return { approved: false, reason: 'maxAtomicPerCall exceeded' };
  if (policy.dailyAtomic != null && daily + amount > toAtomic(policy.dailyAtomic, 'dailyAtomic')) return { approved: false, reason: 'dailyAtomic exceeded' };
  if (policy.allowedAssets?.length && !policy.allowedAssets.includes(request.asset)) return { approved: false, reason: 'asset is not allowed' };
  if (policy.allowedRecipients?.length && !policy.allowedRecipients.includes(request.recipient)) return { approved: false, reason: 'recipient is not allowed' };
  return { approved: true, reason: 'approved' };
}
function toAtomic(value, field) {
  try { if (typeof value === 'number' && !Number.isSafeInteger(value)) throw new Error(); return BigInt(value); }
  catch { throw new TypeError(`${field} must be an integer amount`); }
}
