import { fail, statuses, formats } from '../editorial/shared.mjs';
const day = 86400000;
export function dateRange(ctx, query) {
  const today = ctx.now().slice(0, 10);
  const from = query.from || new Date(Date.parse(`${today}T00:00:00Z`) - 29 * day).toISOString().slice(0, 10);
  const to = query.to || today;
  if (!!query.from !== !!query.to) fail(ctx, 422, 'INVALID_PERIOD', 'Informe início e fim do período.');
  for (const value of [from, to]) { const parsed = new Date(`${value}T00:00:00Z`); if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) fail(ctx, 422, 'INVALID_PERIOD', 'Use datas válidas para o período.'); }
  const days = Math.round((Date.parse(to) - Date.parse(from)) / day) + 1;
  if (days < 1 || days > 366 || from < '2000-01-01' || to > today) fail(ctx, 422, 'INVALID_PERIOD', 'Escolha até 366 dias, sem datas futuras, a partir de 2000.');
  return { from, to, days, start: `${from}T00:00:00.000Z`, end: new Date(Date.parse(`${to}T00:00:00Z`) + day).toISOString(), timezone: 'UTC', basis: 'created_at', statusBasis: 'current_state' };
}
export function editorialMetrics(ctx, tid, wid, query = {}) {
  const period = dateRange(ctx, query);
  const args = [tid, wid, period.start, period.end];
  const where = 'p.tenant_id=? AND p.workspace_id=? AND p.created_at>=? AND p.created_at<?';
  const countRows = ctx.db.prepare(`SELECT status,count(*) AS count FROM posts p WHERE ${where} GROUP BY status`).all(...args);
  const counts = Object.fromEntries(statuses.map(s => [s, 0]));
  for (const row of countRows) counts[row.status] = row.count;
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  const active = total - counts.archived;
  const ready = counts.approved + counts.planned;
  const quality = ctx.db.prepare(`SELECT count(*) AS count,sum(CASE WHEN trim(p.caption)='' THEN 1 ELSE 0 END) AS missingCaption,sum(CASE WHEN NOT EXISTS(SELECT 1 FROM post_channels pc WHERE pc.tenant_id=p.tenant_id AND pc.workspace_id=p.workspace_id AND pc.post_id=p.id) THEN 1 ELSE 0 END) AS missingChannels FROM posts p WHERE ${where} AND p.status!='archived'`).get(...args);
  const groupedDays = ctx.db.prepare(`SELECT substr(created_at,1,10) AS date,count(*) AS count FROM posts p WHERE ${where} GROUP BY substr(created_at,1,10)`).all(...args);
  const daily = new Map(groupedDays.map(r => [r.date, r.count]));
  const trend = Array.from({ length: period.days }, (_, index) => { const date = new Date(Date.parse(period.start) + index * day).toISOString().slice(0, 10); return { date, count: daily.get(date) || 0 }; });
  const formatRows = ctx.db.prepare(`SELECT format,count(*) AS count FROM posts p WHERE ${where} GROUP BY format`).all(...args);
  const formatCounts = Object.fromEntries(formatRows.map(r => [r.format, r.count]));
  const formatMix = formats.map(format => ({ format, count: formatCounts[format] || 0 }));
  const channelMix = ctx.db.prepare(`SELECT c.platform,count(DISTINCT p.id) AS count FROM posts p JOIN post_channels pc ON pc.tenant_id=p.tenant_id AND pc.workspace_id=p.workspace_id AND pc.post_id=p.id JOIN channels c ON c.tenant_id=pc.tenant_id AND c.workspace_id=pc.workspace_id AND c.id=pc.channel_id WHERE ${where} GROUP BY c.platform ORDER BY count DESC,c.platform`).all(...args);
  const metrics = { totalPosts: total, activePosts: active, readyPosts: ready, approvalRate: active ? Math.round(ready / active * 1000) / 10 : null,
    counts, missingCaption: quality.missingCaption || 0, missingChannels: quality.missingChannels || 0, trend, formatMix, channelMix };
  const source = { type: 'internal_editorial', generatedAt: ctx.now(), from: period.from, to: period.to, basis: period.basis, scope: 'brand', verification: 'computed_from_database' };
  const derived = [];
  const add = (key, quadrant, title, description, numerator, denominator = active) => derived.push({ id: `computed:${key}`, quadrant, title, description, classification: 'evidence', sourceType: 'internal_editorial', source, formula: key, numerator, denominator, readOnly: true });
  if (ready) add('approved_or_planned', 'strength', `${ready} conteúdo(s) com aprovação vigente`, 'Aprovados + planejados no estado atual. É um sinal do fluxo de revisão, sem medir resultado nas redes.', ready);
  if (channelMix.length >= 2) add('distinct_planned_platforms', 'strength', `Planejamento em ${channelMix.length} plataformas`, 'Plataformas distintas vinculadas aos conteúdos criados no período. Vínculo editorial não comprova publicação.', channelMix.length, null);
  if (metrics.missingCaption) add('active_without_caption', 'weakness', `${metrics.missingCaption} conteúdo(s) sem legenda`, 'Itens ativos com legenda vazia. Verifique se o formato precisa de texto antes de concluir a produção.', metrics.missingCaption);
  if (metrics.missingChannels) add('active_without_target', 'weakness', `${metrics.missingChannels} conteúdo(s) sem destino`, 'Itens ativos sem alvo editorial selecionado. A escolha do destino ajuda a preparar o formato correto.', metrics.missingChannels);
  if (counts.changes_requested) add('changes_requested', 'weakness', `${counts.changes_requested} conteúdo(s) aguardando ajustes`, 'A solicitação de ajustes ainda está aberta no fluxo editorial atual.', counts.changes_requested);
  return { period, metrics, derivedEntries: derived, source: 'editorial-only', socialMetrics: null,
    methodology: { automaticAnalysis: 'transparent_rules', externalDataFetched: false, scope: 'Produção e planejamento internos da marca. As contagens usam a data de criação e o estado atual de cada conteúdo.', note: 'Não mede alcance, engajamento, vendas, seguidores da marca ou publicações efetivamente realizadas. Canais podem somar mais que o total porque uma peça pode ter vários destinos.' } };
}
