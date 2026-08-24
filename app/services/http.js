// Small fetch helpers: a concurrency/spacing queue (be polite to public demo servers) and getJson.

export function createQueue({ maxConcurrent = 4, spacingMs = 120 } = {}) {
  let active = 0;
  let lastStart = 0;
  const waiting = [];
  const next = () => {
    if (active >= maxConcurrent || !waiting.length) return;
    const wait = lastStart + spacingMs - Date.now();
    if (wait > 0) { setTimeout(next, wait); return; }
    const { fn, resolve, reject } = waiting.shift();
    active++;
    lastStart = Date.now();
    Promise.resolve().then(fn).then(resolve, reject).finally(() => { active--; next(); });
  };
  return {
    run: fn => new Promise((resolve, reject) => { waiting.push({ fn, resolve, reject }); next(); }),
    get active() { return active; },
    get pending() { return waiting.length; },
  };
}

/**
 * GET a JSON document. Retries once on network errors / 5xx / 429. `okStatuses` lists extra
 * HTTP statuses whose JSON body should be returned instead of thrown (OSRM answers 400 with
 * {code:'NoRoute'}).
 */
export async function getJson(url, { fetchImpl = globalThis.fetch, retries = 1, timeoutMs = 30000, okStatuses = [], method = 'GET', body = null, headers = null } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timer = ctrl ? setTimeout(() => ctrl.abort(), timeoutMs) : null;
    try {
      const init = { method };
      if (body != null) init.body = body;
      if (headers) init.headers = headers;
      if (ctrl) init.signal = ctrl.signal;
      const r = await fetchImpl(url, init);
      if (r.ok || okStatuses.includes(r.status)) return await r.json();
      const text = await r.text().catch(() => '');
      const err = new Error(`HTTP ${r.status} from ${new URL(url).host}${text ? ': ' + text.slice(0, 120) : ''}`);
      err.status = r.status;
      if (r.status >= 400 && r.status < 500 && r.status !== 429) { err.noRetry = true; }
      throw err;
    } catch (e) {
      lastErr = e;
      if (e.noRetry || attempt >= retries) break;
      await new Promise(res => setTimeout(res, 400 * (attempt + 1)));
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
  throw lastErr;
}
