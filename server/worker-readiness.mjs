const invalidUrl = { configured: true, ready: false, reason: 'executor_url_invalid' };

export async function getWorkerReadiness({ executorUrl = process.env.CORAGENTIC_JOB_EXECUTOR, importModule = (url) => import(url) } = {}) {
  if (typeof executorUrl !== 'string' || !executorUrl.trim()) {
    return { configured: false, ready: false, reason: 'executor_not_configured' };
  }

  let url;
  try {
    url = new URL(executorUrl);
    if (url.protocol !== 'file:') return invalidUrl;
  } catch {
    return invalidUrl;
  }

  try {
    const executorModule = await importModule(url.href);
    const fn = executorModule?.default;
    if (typeof fn !== 'function') return { configured: true, ready: false, reason: 'executor_export_invalid' };
    // Require async: sync functions lack Promise-return contract
    const isAsync = fn.constructor?.name === 'AsyncFunction';
    if (!isAsync) return { configured: true, ready: false, reason: 'executor_must_be_async' };
    return { configured: true, ready: true, reason: null };
  } catch {
    return { configured: true, ready: false, reason: 'executor_import_failed' };
  }
}
