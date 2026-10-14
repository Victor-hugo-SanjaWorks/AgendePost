import { fail, string, object } from '../editorial/shared.mjs';
export { string, object };
export const quadrants = ['strength', 'weakness', 'opportunity', 'threat'];
export const nullable = schema => ({ anyOf: [schema, { type: 'null' }] });
export const urlInput = nullable(string(2000, 0));
export const dateInput = nullable({ type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' });
export function validDate(ctx, value, { required = false } = {}) {
  if (!value) { if (required) fail(ctx, 422, 'SOURCE_DATE_REQUIRED', 'Informe a data da observação.'); return null; }
  const date = new Date(`${value}T00:00:00.000Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value || value < '2000-01-01' || value > ctx.now().slice(0, 10)) fail(ctx, 422, 'INVALID_SOURCE_DATE', 'Use uma data válida entre 2000 e hoje para a observação.');
  return value;
}
export function safeURL(ctx, value) {
  if (value === null || value === undefined || value.trim() === '') return null;
  let url;
  try { url = new URL(value.trim()); } catch { fail(ctx, 422, 'INVALID_SOURCE_URL', 'Informe uma URL pública HTTP ou HTTPS válida.'); }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || /[\u0000-\u0020\u007f]/.test(value)) fail(ctx, 422, 'INVALID_SOURCE_URL', 'A URL deve usar HTTP ou HTTPS, sem credenciais.');
  // This is validation only. URLs are never requested by the server.
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (!host.includes('.') || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || /^(127|10|0)\./.test(host) || /^192\.168\./.test(host) || /^169\.254\./.test(host) || /^172\.(1[6-9]|2\d|3[01])\./.test(host) || /:/.test(host)) fail(ctx, 422, 'INVALID_SOURCE_URL', 'Use uma URL de site público, sem endereço de rede local.');
  return url.href;
}
export function entryDTO(row) {
  return { id: row.id, workspaceId: row.workspace_id, quadrant: row.quadrant, title: row.title, description: row.description,
    classification: row.classification, sourceType: row.source_type, sourceUrl: row.source_url, observedOn: row.observed_on,
    sourceNotes: row.source_notes, archivedAt: row.archived_at, version: row.version,
    createdBy: row.created_by, updatedBy: row.updated_by, createdAt: row.created_at, updatedAt: row.updated_at,
    verification: 'user_entered' };
}
export function competitorDTO(row) {
  return { id: row.id, workspaceId: row.workspace_id, name: row.name, websiteUrl: row.website_url, profileUrl: row.profile_url,
    platform: row.platform, positioning: row.positioning, audience: row.audience, formats: row.formats,
    followers: row.followers, postsObserved: row.posts_observed, observationDays: row.observation_days,
    postsPerWeek: row.posts_observed === null ? null : Math.round(row.posts_observed / row.observation_days * 700) / 100,
    sourceType: row.source_type, sourceUrl: row.source_url, observedOn: row.observed_on, sourceNotes: row.source_notes,
    archivedAt: row.archived_at, version: row.version, createdBy: row.created_by, updatedBy: row.updated_by,
    createdAt: row.created_at, updatedAt: row.updated_at, verification: 'user_entered' };
}
