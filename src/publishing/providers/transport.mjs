import https from 'node:https';
import { lookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';

export class SafeProviderError extends Error {
  constructor(code, { retryAfterMs, safeToRetry = false, ambiguous = false } = {}) {
    super(code); this.name = 'SafeProviderError'; this.code = code;
    this.retryAfterMs = retryAfterMs; this.safeToRetry = safeToRetry; this.ambiguous = ambiguous;
  }
}

const blocked = new BlockList();
for (const [address, prefix] of [['0.0.0.0',8],['10.0.0.0',8],['100.64.0.0',10],['127.0.0.0',8],['169.254.0.0',16],['172.16.0.0',12],['192.0.0.0',24],['192.0.2.0',24],['192.88.99.0',24],['192.168.0.0',16],['198.18.0.0',15],['198.51.100.0',24],['203.0.113.0',24],['224.0.0.0',4],['240.0.0.0',4]]) blocked.addSubnet(address,prefix,'ipv4');
for (const [address, prefix] of [['2001::',23],['2001:db8::',32],['2002::',16],['3fff::',20]]) blocked.addSubnet(address,prefix,'ipv6');
export function isPublicAddress(address) {
  const family = isIP(address);
  if (family === 4) return !blocked.check(address, 'ipv4');
  // Only ordinary global unicast IPv6. Mapped IPv4, local, multicast and transition ranges fail closed.
  return family === 6 && /^[23][0-9a-f]{3}:/i.test(address) && !blocked.check(address, 'ipv6');
}

/** HTTPS only, DNS verified and pinned to one validated address for this exact request.
 * No proxy, redirects, cookies, credentials or application authorization headers.
 */
export async function fetchPublicAsset(url, { signal, maxBytes = 5 * 1024 * 1024 } = {}) {
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.hash || parsed.port && parsed.port !== '443') throw new SafeProviderError('PUBLIC_ASSET_URL_INVALID');
  let addresses, abortListener;
  try {
    addresses = await Promise.race([
      lookup(parsed.hostname, { all: true, verbatim: true }),
      new Promise((_, reject) => {
        abortListener = () => reject(new SafeProviderError('PUBLIC_ASSET_TIMEOUT'));
        if (signal?.aborted) abortListener();
        else signal?.addEventListener('abort', abortListener, { once: true });
      })
    ]);
  } catch { throw new SafeProviderError('PUBLIC_ASSET_UNAVAILABLE', { safeToRetry: true }); }
  finally { if (abortListener) signal?.removeEventListener('abort', abortListener); }
  if (!addresses.length || addresses.some(({ address }) => !isPublicAddress(address))) throw new SafeProviderError('PUBLIC_ASSET_HOST_FORBIDDEN');
  const selected = addresses[0];
  return new Promise((resolve, reject) => {
    const req = https.request(parsed, {
      method: 'GET', signal, agent: false,
      headers: { Accept: 'image/jpeg', 'Accept-Encoding': 'identity' },
      lookup: (_hostname, options, callback) => options?.all ? callback(null, [selected]) : callback(null, selected.address, selected.family)
    }, res => {
      const advertised = Number(res.headers['content-length']);
      if (Number.isFinite(advertised) && advertised > maxBytes) { res.destroy(); reject(new SafeProviderError('PUBLIC_ASSET_TOO_LARGE')); return; }
      let size = 0; const chunks = [];
      res.on('data', chunk => {
        size += chunk.length;
        if (size > maxBytes) { res.destroy(); reject(new SafeProviderError('PUBLIC_ASSET_TOO_LARGE')); return; }
        chunks.push(chunk);
      });
      res.on('error', () => reject(new SafeProviderError('PUBLIC_ASSET_UNAVAILABLE', { safeToRetry: true })));
      res.on('end', () => {
        const headers = new Headers();
        for (const [key,value] of Object.entries(res.headers)) if (value !== undefined) headers.set(key, Array.isArray(value) ? value.join(',') : String(value));
        try { resolve(new Response(Buffer.concat(chunks), { status: res.statusCode, headers })); }
        catch { reject(new SafeProviderError('PUBLIC_ASSET_UNAVAILABLE', { safeToRetry: true })); }
      });
    });
    req.on('error', () => reject(new SafeProviderError('PUBLIC_ASSET_UNAVAILABLE', { safeToRetry: true })));
    req.end();
  });
}

export async function readBounded(response, maxBytes) {
  if (Number(response.headers?.get('content-length')) > maxBytes) throw new SafeProviderError('PROVIDER_RESPONSE_TOO_LARGE');
  if (!response.body?.getReader) throw new SafeProviderError('PROVIDER_RESPONSE_INVALID');
  const reader = response.body.getReader(); const chunks = []; let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) throw new SafeProviderError('PROVIDER_RESPONSE_TOO_LARGE');
      chunks.push(Buffer.from(value));
    }
  } finally { try { await reader.cancel(); } catch { /* Never expose transport details. */ } }
  return Buffer.concat(chunks);
}

function backoff(response, now) {
  const header = response.headers?.get('retry-after');
  const delay = /^\d+$/.test(header || '') ? Number(header) * 1000 : Date.parse(header) - now;
  return Number.isFinite(delay) && delay > 0 ? Math.min(delay, 24 * 60 * 60 * 1000) : 60000;
}

/** One HTTP attempt, no internal retry. Auth stays in a header, never a URL or thrown error. */
export async function graphRequest({ fetchImpl, apiVersion, token, path, method = 'GET', parameters = {}, signal, timeoutMs, effect = 'none', now = Date.now() }) {
  const controller = new AbortController();
  const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  // A real transport honors AbortSignal; the race also bounds an unresponsive injected transport/body.
  let abortListener;
  const aborted = new Promise((_, reject) => {
    abortListener = () => reject(new SafeProviderError('PROVIDER_TIMEOUT'));
    if (combined.aborted) abortListener(); else combined.addEventListener('abort', abortListener, { once: true });
  });
  const operation = async () => {
    const url = new URL(`https://graph.facebook.com/${apiVersion}/${path}`);
    const headers = { Authorization: `Bearer ${token}`, Accept: 'application/json' };
    let body;
    if (method === 'GET') for (const [key, value] of Object.entries(parameters)) url.searchParams.set(key, value);
    else { body = new URLSearchParams(parameters); headers['Content-Type'] = 'application/x-www-form-urlencoded'; }
    const response = await fetchImpl(url.href, { method, headers, body, signal: combined, redirect: 'error' });
    const raw = await readBounded(response, 128 * 1024);
    let data;
    try { data = JSON.parse(raw.toString('utf8')); } catch { throw new SafeProviderError('PROVIDER_RESPONSE_INVALID'); }
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new SafeProviderError('PROVIDER_RESPONSE_INVALID');
    if (response.status >= 300 && response.status < 400) throw new SafeProviderError('PROVIDER_REDIRECT_FORBIDDEN');
    if (data.error || !response.ok) {
      const code = Number.isInteger(data.error?.code) ? data.error.code : 0;
      if (code === 190 || code === 102) throw new SafeProviderError('META_AUTH_EXPIRED');
      if (code === 10 || code === 200) throw new SafeProviderError('META_PERMISSION_DENIED');
      if ([4,17,32,613].includes(code) || code >= 80000 && code <= 80014) throw new SafeProviderError('META_RATE_LIMIT', { safeToRetry: true, retryAfterMs: backoff(response, now) });
      if (response.status >= 500 || [1,2].includes(code)) throw new SafeProviderError('META_UNAVAILABLE', { safeToRetry: effect !== 'publish', ambiguous: effect === 'publish', retryAfterMs: 60000 });
      if (code === 100 || code === 368 || code === 36003) throw new SafeProviderError('META_REQUEST_REJECTED');
      throw new SafeProviderError('META_REQUEST_FAILED', { safeToRetry: effect !== 'publish' && response.status === 429, ambiguous: effect === 'publish' });
    }
    return data;
  };
  try { return await Promise.race([operation(), aborted]); }
  catch (error) {
    // No raw provider message, URL, header, exception, body, stack cause or token escapes.
    if (error instanceof SafeProviderError && (error.code.startsWith('META_'))) throw error;
    throw new SafeProviderError(error instanceof SafeProviderError ? error.code : 'PROVIDER_NETWORK_ERROR', { safeToRetry: effect !== 'publish', ambiguous: effect === 'publish', retryAfterMs: 60000 });
  } finally { clearTimeout(timeout); combined.removeEventListener('abort', abortListener); }
}
