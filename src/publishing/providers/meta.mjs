import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, openSync, readSync, realpathSync, statSync } from 'node:fs';
import { isIP } from 'node:net';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchPublicAsset, graphRequest, readBounded, SafeProviderError } from './transport.mjs';

// Official Graph API changelog, verified 2026-10-14. No unversioned requests.
export const META_API_VERSION = 'v26.0';
const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const inside = (root, candidate) => { const part = relative(root, candidate); return part === '' || (part !== '..' && !part.startsWith('..' + sep) && !isAbsolute(part)); };
const MAX_IMAGE_BYTES = 5 * 1024 * 1024; // Deliberately stricter than Meta's 8 MB; matches local upload limit.
const ASSET_VALIDITY_MS = 10 * 60 * 1000;
const ID = /^[1-9][0-9]{0,39}$/;
const LOCAL_ID = /^[A-Za-z0-9_-]{1,200}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const STAGES = new Set(['prepared', 'processing', 'ready', 'publishing']);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const moment = value => typeof value === 'string' && /(?:Z|[+-]\d{2}:\d{2})$/.test(value) ? Date.parse(value) : NaN;
const nowOf = input => typeof input?.now === 'number' ? input.now : Date.parse(input?.now);
const key = input => [input.tenantId, input.workspaceId, input.channelId, input.platform].join(':');
const assetKey = input => [input.tenantId, input.workspaceId, input.digest].join(':');
const message = code => ({
  META_NOT_CONFIGURED: 'Publicação real não configurada.', META_CONFIG_INVALID: 'Configuração segura da Meta inválida.',
  META_CONNECTION_MISSING: 'Conecte e verifique a conta social deste canal.', META_AUTH_EXPIRED: 'A autorização da Meta expirou. Reconecte a conta.',
  META_PERMISSION_DENIED: 'A conta não possui as permissões necessárias para publicar.', META_CONNECTION_CHANGED: 'A conexão social mudou. Revise o agendamento.',
  PUBLIC_ASSET_MISSING: 'Disponibilize o JPEG aprovado em hospedagem HTTPS e configure seu vínculo seguro.',
  PUBLIC_ASSET_EXPIRED: 'Renove a disponibilidade pública do JPEG antes da publicação.',
  IMAGE_JPEG_REQUIRED: 'Para publicar, envie e aprove uma única imagem JPEG.', IMAGE_INVALID: 'A imagem aprovada é inválida ou foi alterada.',
  IMAGE_DIMENSIONS: 'No Instagram, use JPEG entre 320 e 1440 pixels de largura, na proporção de 4:5 a 1,91:1.',
  CAPTION_INVALID: 'A legenda excede os limites do canal ou contém caracteres inválidos.', FORMAT_UNSUPPORTED: 'A publicação atual aceita uma única imagem JPEG.'
})[code] || 'A publicação requer revisão antes de continuar.';
const blocked = code => ({ ready: false, code, message: message(code) });
const validLocal = value => typeof value === 'string' && LOCAL_ID.test(value);
const validId = value => typeof value === 'string' && ID.test(value);

function validHost(host) {
  return typeof host === 'string' && host === host.toLowerCase() && host.length <= 253 && !isIP(host)
    && /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(host)
    && !/(?:^|\.)(?:localhost|local|internal|test|invalid|example|onion)$/.test(host);
}
function validatedAssetUrl(raw, hosts) {
  if (typeof raw !== 'string' || raw.length > 4096 || /[\u0000-\u0020\u007f\\]/u.test(raw)) return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== 'https:' || url.username || url.password || url.hash || url.port && url.port !== '443' || !hosts.has(url.hostname) || !validHost(url.hostname)) return null;
    return url.href;
  } catch { return null; }
}

export class DisabledMetaPublishingAdapter {
  enabled = false; kind = 'meta';
  constructor(code = 'META_NOT_CONFIGURED') { this.code = code; }
  readiness() { return blocked(this.code); }
  validate() { return blocked(this.code); }
  async publish() { return { outcome: 'failed', code: this.code }; }
  async reconcile() { return { outcome: 'ambiguous', code: this.code }; }
}

/** No credential fields or raw configuration are exposed on the returned object. */
export function createMetaPublishingAdapter(config = {}, { fetchImpl = globalThis.fetch, assetFetchImpl = fetchPublicAsset, clock = Date.now, resolveConnection, onConnectionRevoked } = {}) {
  if (config.enabled !== true) return new DisabledMetaPublishingAdapter();
  if (config.apiVersion !== META_API_VERSION || !Array.isArray(config.connections) || config.connections.length > 1000 || !Array.isArray(config.assets) || config.assets.length > 10000 || !Array.isArray(config.assetHosts) || !config.assetHosts.length || config.assetHosts.length > 100 || config.assetHosts.some(host => !validHost(host)) || typeof fetchImpl !== 'function' || typeof assetFetchImpl !== 'function' || resolveConnection !== undefined && typeof resolveConnection !== 'function' || onConnectionRevoked !== undefined && typeof onConnectionRevoked !== 'function') throw new SafeProviderError('META_CONFIG_INVALID');
  const timeoutMs = config.requestTimeoutMs ?? 15000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 30000) throw new SafeProviderError('META_CONFIG_INVALID');
  const connections = new Map(), assets = new Map(), hosts = new Set(config.assetHosts);
  function normalizeConnection(supplied, dynamic = false) {
    if (!supplied || typeof supplied !== 'object' || Array.isArray(supplied) || supplied.then) throw new SafeProviderError('META_CONFIG_INVALID');
    const c = structuredClone(supplied);
    if (![c.tenantId,c.workspaceId,c.channelId].every(validLocal) || !['instagram','facebook'].includes(c.platform) || !validId(c.accountId) || c.platform === 'instagram' && !validId(c.linkedPageId) || c.tokenType !== 'page' || c.appSecretProof !== undefined && (typeof c.appSecretProof !== 'string' || !SHA256.test(c.appSecretProof)) || c.destinationLabel !== undefined && (typeof c.destinationLabel !== 'string' || c.destinationLabel.length > 200 || /[\u0000-\u001f\u007f]/u.test(c.destinationLabel)) || typeof c.accessToken !== 'string' || c.accessToken.length < 20 || c.accessToken.length > 8192 || /[\s\u0000-\u001f\u007f]/u.test(c.accessToken) || !Number.isFinite(moment(c.expiresAt)) || !Number.isFinite(moment(c.verifiedAt)) || !Array.isArray(c.permissions) || c.permissions.length > 100 || c.permissions.some(p => typeof p !== 'string') || typeof c.businessManagerGrant !== 'boolean' || c.platform === 'facebook' && (!Array.isArray(c.pageTasks) || !c.pageTasks.includes('CREATE_CONTENT')) || dynamic && (typeof c.connectionVersion !== 'string' || !LOCAL_ID.test(c.connectionVersion))) throw new SafeProviderError('META_CONFIG_INVALID');
    // Canonical field order prevents incidental object ordering from changing the binding.
    const normalized = { tenantId:c.tenantId,workspaceId:c.workspaceId,channelId:c.channelId,platform:c.platform,accountId:c.accountId,linkedPageId:c.linkedPageId??null,destinationLabel:c.destinationLabel??null,tokenType:c.tokenType,accessToken:c.accessToken,appSecretProof:c.appSecretProof??null,expiresAt:c.expiresAt,verifiedAt:c.verifiedAt,businessManagerGrant:c.businessManagerGrant,permissions:[...c.permissions].sort(),pageTasks:Array.isArray(c.pageTasks)?[...c.pageTasks].sort():[],sourceAuthorizationVersion:dynamic?c.connectionVersion:null };
    return Object.freeze({ ...normalized,connectionVersion:hash(JSON.stringify(normalized)) });
  }
  for (const supplied of config.connections) {
    const c = normalizeConnection(supplied);
    if (connections.has(key(c))) throw new SafeProviderError('META_CONFIG_INVALID');
    connections.set(key(c), c);
  }
  function readConnection(input) {
    if (resolveConnection) {
      try {
        const resolved = resolveConnection({tenantId:input.tenantId,workspaceId:input.workspaceId,channelId:input.channelId,platform:input.platform});
        // Undefined means no OAuth row has ever existed. Null/throw is an authoritative tombstone.
        if (resolved !== undefined) {
          if (resolved === null) return null;
          const c = normalizeConnection(resolved,true);
          return key(c) === key(input) ? c : null;
        }
      } catch { return null; }
    }
    return connections.get(key(input)) ?? null;
  }
  for (const supplied of config.assets) {
    const a = structuredClone(supplied), url = validatedAssetUrl(a.url,hosts);
    if (![a.tenantId,a.workspaceId].every(validLocal) || !SHA256.test(a.digest) || !url || !Number.isFinite(moment(a.expiresAt)) || assets.has(assetKey(a))) throw new SafeProviderError('META_CONFIG_INVALID');
    assets.set(assetKey(a), Object.freeze({ ...a, url }));
  }
  function readiness(input) {
    if (![input?.tenantId,input?.workspaceId,input?.channelId].every(validLocal) || !['instagram','facebook'].includes(input?.platform)) return blocked('META_CONNECTION_MISSING');
    const c = readConnection(input);
    if (!c) return blocked('META_CONNECTION_MISSING');
    const now = nowOf(input);
    if (!Number.isFinite(now) || moment(c.expiresAt) <= now + 60000 || moment(c.verifiedAt) > now + 60000) return blocked('META_AUTH_EXPIRED');
    const required = c.platform === 'instagram'
      ? ['instagram_basic','instagram_content_publish','pages_read_engagement','pages_show_list']
      : ['pages_manage_posts','pages_read_engagement','pages_show_list'];
    if (required.some(permission => !c.permissions.includes(permission)) || c.platform === 'instagram' && c.businessManagerGrant && !c.permissions.some(p => ['ads_read','ads_management'].includes(p))) return blocked('META_PERMISSION_DENIED');
    return { ready: true, connectionVersion: c.connectionVersion, destinationId:c.accountId, ...(c.destinationLabel ? {destinationLabel:c.destinationLabel} : {}) };
  }
  function validate(input) {
    const ready = readiness(input); if (!ready.ready) return ready;
    if (input.connectionVersion && input.connectionVersion !== ready.connectionVersion) return blocked('META_CONNECTION_CHANGED');
    if (input.format !== 'image') return blocked('FORMAT_UNSUPPORTED');
    const { media, caption } = input;
    if (!media || media.mime !== 'image/jpeg') return blocked('IMAGE_JPEG_REQUIRED');
    if (!Buffer.isBuffer(media.bytes) || media.bytes.length < 4 || media.bytes.length > MAX_IMAGE_BYTES || media.sizeBytes !== media.bytes.length || !SHA256.test(media.digest) || hash(media.bytes) !== media.digest || !media.bytes.subarray(0,3).equals(Buffer.from([255,216,255])) || !Number.isInteger(media.width) || !Number.isInteger(media.height) || media.width < 1 || media.height < 1 || media.width > 10000 || media.height > 10000 || media.width * media.height > 25000000) return blocked('IMAGE_INVALID');
    if (input.platform === 'instagram' && (media.width < 320 || media.width > 1440 || media.width / media.height < 0.8 || media.width / media.height > 1.91)) return blocked('IMAGE_DIMENSIONS');
    if (typeof caption !== 'string' || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\ud800-\udfff]/u.test(caption) || [...caption].length > (input.platform === 'instagram' ? 2200 : 63206)) return blocked('CAPTION_INVALID');
    if (input.platform === 'instagram' && ((caption.match(/(?:^|\s)#[\p{L}\p{N}_]+/gu) || []).length > 30 || (caption.match(/(?:^|\s)@[A-Za-z0-9_.]+/g) || []).length > 20)) return blocked('CAPTION_INVALID');
    const asset = assets.get(assetKey({ ...input, digest: media.digest }));
    if (!asset) return blocked('PUBLIC_ASSET_MISSING');
    if (moment(asset.expiresAt) < nowOf(input) + ASSET_VALIDITY_MS) return blocked('PUBLIC_ASSET_EXPIRED');
    return ready;
  }
  async function verifyAsset(asset, media, signal) {
    const controller = new AbortController(); const timer = setTimeout(() => controller.abort(),timeoutMs);
    const combined = signal ? AbortSignal.any([signal,controller.signal]) : controller.signal;
    let listener;
    const aborted = new Promise((_,reject) => { listener = () => reject(new SafeProviderError('PUBLIC_ASSET_TIMEOUT', { safeToRetry: true })); if (combined.aborted) listener(); else combined.addEventListener('abort',listener,{ once:true }); });
    try {
      await Promise.race([(async () => {
        const response = await assetFetchImpl(asset.url,{ signal:combined,redirect:'error',maxBytes:MAX_IMAGE_BYTES });
        if (response.status !== 200) throw new SafeProviderError('PUBLIC_ASSET_UNAVAILABLE', { safeToRetry: response.status === 429 || response.status >= 500 });
        if (response.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'image/jpeg' || response.headers.get('content-encoding') && response.headers.get('content-encoding') !== 'identity') throw new SafeProviderError('PUBLIC_ASSET_TYPE_INVALID');
        const bytes = await readBounded(response, MAX_IMAGE_BYTES);
        if (bytes.length !== media.sizeBytes || hash(bytes) !== media.digest || !bytes.subarray(0,3).equals(Buffer.from([255,216,255]))) throw new SafeProviderError('PUBLIC_ASSET_DIGEST_MISMATCH');
      })(), aborted]);
    } catch (error) { throw error instanceof SafeProviderError ? error : new SafeProviderError('PUBLIC_ASSET_UNAVAILABLE', { safeToRetry:true }); }
    finally { clearTimeout(timer); combined.removeEventListener('abort',listener); }
  }
  const call = async (connection, input, path, method, parameters, effect = 'none') => {
    // Resolve again after every asynchronous wait. A disconnect/rebind must never use cached tokens.
    const checked = readiness({...input,now:clock()}), current = readConnection(input);
    if (!checked.ready) throw new SafeProviderError(checked.code);
    if (!current || checked.connectionVersion !== connection.connectionVersion || current.connectionVersion !== connection.connectionVersion || input.connectionVersion !== connection.connectionVersion) throw new SafeProviderError('META_CONNECTION_CHANGED');
    try {
      return await graphRequest({ fetchImpl,apiVersion:META_API_VERSION,token:current.accessToken,path,method,parameters:{...parameters,...(current.appSecretProof?{appsecret_proof:current.appSecretProof}:{})},effect,timeoutMs,signal:input.signal,now:clock() });
    } catch (error) {
      if (error instanceof SafeProviderError && error.code === 'META_AUTH_EXPIRED' && onConnectionRevoked && current.sourceAuthorizationVersion) {
        // Compare-and-revoke this exact authorization; never revoke a newer connection after a stale error.
        try { await onConnectionRevoked({tenantId:input.tenantId,workspaceId:input.workspaceId,channelId:input.channelId,platform:input.platform,connectionVersion:current.sourceAuthorizationVersion}); } catch { /* Keep provider failure redacted and fail closed. */ }
      }
      throw error;
    }
  };
  async function publish(input) {
    const ready = validate(input);
    if (!ready.ready) return { outcome:'failed', code:ready.code };
    if (!input.connectionVersion || input.connectionVersion !== ready.connectionVersion) return { outcome:'failed',code:'META_CONNECTION_CHANGED' };
    if (typeof input.saveProviderState !== 'function') return { outcome:'failed',code:'CHECKPOINT_UNAVAILABLE' };
    let state = input.providerState;
    if (state && (!validId(state.containerId) || !STAGES.has(state.stage))) return { outcome:'ambiguous',code:'PROVIDER_STATE_INVALID' };
    if (state?.stage === 'publishing') return { outcome:'ambiguous',code:'PUBLISH_RECONCILIATION_REQUIRED' };
    const c = readConnection(input), asset = assets.get(assetKey({ ...input,digest:input.media.digest }));
    if (!c || c.connectionVersion !== input.connectionVersion) return {outcome:'failed',code:'META_CONNECTION_CHANGED'};
    const save = async (containerId, stage) => {
      state = { containerId, stage };
      await input.saveProviderState(state);
    };
    try {
      // Check approved source bytes against the exact hosted object before any Meta mutation.
      await verifyAsset(asset,input.media,input.signal);
      if (input.signal?.aborted) return { outcome:'retry',code:'PUBLICATION_ABORTED_BEFORE_SEND',safeToRetry:true,retryAfterMs:60000 };
      if (!state) {
        const prepared = c.platform === 'instagram'
          ? await call(c,input,`${c.accountId}/media`,'POST',{ image_url:asset.url,caption:input.caption },'prepare')
          : await call(c,input,`${c.accountId}/photos`,'POST',{ url:asset.url,published:'false' },'prepare');
        if (!validId(prepared.id)) throw new SafeProviderError('PROVIDER_RESPONSE_INVALID',{ safeToRetry:true });
        await save(prepared.id,'prepared');
      }
      if (c.platform === 'instagram') {
        const result = await call(c,input,state.containerId,'GET',{ fields:'status_code,status' });
        if (result.status_code === 'PUBLISHED') return { outcome:'ambiguous',code:'META_PUBLISHED_ID_UNRESOLVED' };
        if (result.status_code === 'ERROR' || result.status_code === 'EXPIRED') return { outcome:'failed',code:`META_CONTAINER_${result.status_code}` };
        if (result.status_code === 'IN_PROGRESS') { await save(state.containerId,'processing'); return { outcome:'retry',code:'META_CONTAINER_PROCESSING',safeToRetry:true,retryAfterMs:60000 }; }
        if (result.status_code !== 'FINISHED') return { outcome:'retry',code:'META_CONTAINER_STATUS_UNKNOWN',safeToRetry:true,retryAfterMs:60000 };
      }
      await save(state.containerId,'ready');
      // A cancellation/lease failure must prevent the next POST. This callback is awaited.
      await save(state.containerId,'publishing');
      const result = c.platform === 'instagram'
        ? await call(c,input,`${c.accountId}/media_publish`,'POST',{ creation_id:state.containerId },'publish')
        : await call(c,input,`${c.accountId}/feed`,'POST',{ message:input.caption,attached_media:JSON.stringify([{ media_fbid:state.containerId }]),published:'true' },'publish');
      const validRemoteId = c.platform === 'instagram' ? validId(result.id) : typeof result.id === 'string' && new RegExp(`^${c.accountId}_[1-9][0-9]{0,39}$`).test(result.id);
      if (!validRemoteId) return { outcome:'ambiguous',code:'PUBLISH_RESPONSE_ID_MISSING' };
      return { outcome:'published',remoteId:result.id };
    } catch (error) {
      if (!(error instanceof SafeProviderError)) return { outcome:'ambiguous',code:'PUBLICATION_STATE_UNCERTAIN' };
      if (error.ambiguous) return { outcome:'ambiguous',code:error.code };
      if (error.safeToRetry) {
        // Only an explicit rate rejection proves this final mutation did not publish.
        // The worker atomically resets the fence while committing the safe-retry outcome.
        // A crash before that commit leaves 'publishing' ambiguous, never replayable here.
        if (state?.stage === 'publishing' && error.code !== 'META_RATE_LIMIT') return { outcome:'ambiguous',code:error.code };
        return { outcome:'retry',code:error.code,safeToRetry:true,retryAfterMs:error.retryAfterMs ?? 60000 };
      }
      return { outcome:'failed',code:error.code };
    }
  }
  /** Read-only diagnostic. No uncertain publish is replayed or automatically identified by caption/time. */
  async function reconcile(input) {
    const ready = readiness(input);
    if (!ready.ready) return { outcome:'ambiguous',code:ready.code };
    const c = readConnection(input);
    if (!c || c.connectionVersion !== ready.connectionVersion || input.connectionVersion !== ready.connectionVersion || !validId(input.providerState?.containerId)) return { outcome:'ambiguous',code:'PROVIDER_STATE_INVALID' };
    if (c.platform !== 'instagram') return { outcome:'ambiguous',code:'MANUAL_RECONCILIATION_REQUIRED' };
    try {
      const result = await call(c,input,input.providerState.containerId,'GET',{ fields:'status_code,status' });
      return { outcome:'ambiguous',code:result.status_code === 'PUBLISHED' ? 'META_PUBLISHED_ID_UNRESOLVED' : 'PUBLISH_RECONCILIATION_REQUIRED' };
    } catch { return { outcome:'ambiguous',code:'RECONCILIATION_UNAVAILABLE' }; }
  }
  return Object.freeze({ enabled:true,kind:'meta',readiness,validate,publish,reconcile });
}

/** Operator-only, never HTTP input. Missing or invalid settings are fail-closed and secret-redacted. */
export function createMetaPublishingAdapterFromEnv({ env = process.env, ...dependencies } = {}) {
  if (env.SOCIAL_SAAS_META_ENABLED !== 'true') return new DisabledMetaPublishingAdapter();
  const filename = env.SOCIAL_SAAS_META_CONFIG_FILE;
  if (process.platform === 'win32' || typeof filename !== 'string' || !isAbsolute(filename) || filename.length > 4096) return new DisabledMetaPublishingAdapter('META_CONFIG_INVALID');
  let fd;
  try {
    // Private mode bits cannot protect a file served or packaged by the same process.
    const canonical = realpathSync(filename), repository = realpathSync(REPOSITORY_ROOT);
    if (inside(REPOSITORY_ROOT, resolve(filename)) || inside(repository,canonical)) throw new SafeProviderError('META_CONFIG_INVALID');
    const expected = statSync(canonical);
    fd = openSync(filename, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
    const info = fstatSync(fd);
    if (info.dev !== expected.dev || info.ino !== expected.ino || realpathSync(filename) !== canonical) throw new SafeProviderError('META_CONFIG_INVALID');
    if (!info.isFile() || info.nlink !== 1 || info.size > 1024 * 1024 || info.size < 2 || process.platform !== 'win32' && (info.mode & 0o077 || typeof process.getuid === 'function' && info.uid !== process.getuid())) throw new SafeProviderError('META_CONFIG_INVALID');
    const buffer = Buffer.alloc(1024 * 1024 + 1);
    let length = 0, count;
    do { count = readSync(fd,buffer,length,buffer.length-length,null); length += count; } while (count > 0 && length < buffer.length);
    if (length > 1024 * 1024) throw new SafeProviderError('META_CONFIG_INVALID');
    const config = JSON.parse(buffer.subarray(0,length).toString('utf8'));
    return createMetaPublishingAdapter(config,dependencies);
  } catch { return new DisabledMetaPublishingAdapter('META_CONFIG_INVALID'); }
  finally { if (fd !== undefined) closeSync(fd); }
}
