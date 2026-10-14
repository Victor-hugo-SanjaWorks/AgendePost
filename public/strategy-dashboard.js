(() => {
'use strict';
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const fmt = value => value === null || value === undefined ? 'Não informado' : new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 2 }).format(value);
const date = value => value ? new Date(value.length === 10 ? value + 'T12:00:00Z' : value).toLocaleDateString('pt-BR', { timeZone: 'UTC' }) : 'Sem data';
const quadrants = { strength: ['Forças', 'F', 'O que a marca já tem a seu favor', 'Ambiente interno'], weakness: ['Fraquezas', 'F', 'Onde o processo pede atenção', 'Ambiente interno'], opportunity: ['Oportunidades', 'O', 'Possibilidades a investigar', 'Ambiente externo'], threat: ['Ameaças', 'A', 'Riscos que merecem acompanhamento', 'Ambiente externo'] };
const statusLabels = { draft: 'Rascunhos', in_review: 'Em revisão', changes_requested: 'Em ajustes', approved: 'Aprovados', planned: 'Planejados', archived: 'Arquivados' };
const formatLabels = { image: 'Imagem', carousel: 'Carrossel', video: 'Vídeo', reel: 'Reel', story: 'Story', text: 'Texto' };
const platformLabels = { instagram: 'Instagram', facebook: 'Facebook', linkedin: 'LinkedIn', tiktok: 'TikTok', youtube: 'YouTube', pinterest: 'Pinterest', threads: 'Threads', x: 'X', other: 'Outro / geral' };
let active = null;
function cleanup() {
  if (!active) return;
  active.controller.abort();
  active.dialog?.remove();
  active = null;
}
function safeHref(value) { try { const u = new URL(value); return ['http:', 'https:'].includes(u.protocol) && !u.username && !u.password ? esc(u.href) : null; } catch { return null; } }
function sourceLink(url, label = 'Abrir fonte') { const href = safeHref(url); return href ? `<a href="${href}" target="_blank" rel="noopener noreferrer">${esc(label)} ↗</a>` : ''; }
function badge(text, type = '') { return `<span class="strategy-badge ${type}">${esc(text)}</span>`; }
function empty(text) { return `<div class="strategy-empty">${esc(text)}</div>`; }
function sectionHead(n, title, description, action = '') { return `<div class="strategy-section-head"><div><span class="strategy-overline">${esc(n)}</span><h2>${esc(title)}</h2><p>${esc(description)}</p></div>${action}</div>`; }
function trendChart(data) {
  const points = data.metrics.trend, max = Math.max(1, ...points.map(p => p.count)), w = 700, h = 190, left = 34, top = 15, baseline = 155;
  const xy = points.map((p, i) => [left + i * (w - left - 12) / Math.max(1, points.length - 1), baseline - p.count / max * (baseline - top)]);
  const path = xy.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
  const area = path + ` L${xy.at(-1)[0]},${baseline} L${left},${baseline} Z`;
  return `<div class="strategy-trend"><svg viewBox="0 0 ${w} ${h}" role="img" aria-label="Conteúdos criados por dia, em UTC, de ${esc(date(data.period.from))} a ${esc(date(data.period.to))}. Total: ${data.metrics.totalPosts}."><title>Produção interna por dia, não publicações</title>${[0, 0.5, 1].map(n => `<line x1="${left}" x2="${w - 12}" y1="${baseline - n * (baseline - top)}" y2="${baseline - n * (baseline - top)}" class="strategy-grid-line"/><text x="23" y="${baseline - n * (baseline - top) + 4}" text-anchor="end">${fmt(max * n)}</text>`).join('')}<path d="${area}" class="strategy-chart-area"/><path d="${path}" class="strategy-chart-line"/>${points.filter(p => p.count).length <= 30 ? points.map((p, i) => p.count ? `<circle cx="${xy[i][0]}" cy="${xy[i][1]}" r="3.5" class="strategy-chart-point"><title>${esc(date(p.date))}: ${p.count} criado(s)</title></circle>` : '').join('') : ''}<text x="${left}" y="180">${esc(date(data.period.from))}</text><text x="${w - 12}" y="180" text-anchor="end">${esc(date(data.period.to))}</text></svg></div><details class="strategy-chart-data"><summary>Ver os valores por dia</summary><div class="strategy-table-wrap"><table><caption>Conteúdos criados no período, incluindo arquivados. Datas em UTC.</caption><thead><tr><th>Data</th><th>Criados</th></tr></thead><tbody>${points.map(p => `<tr><td>${esc(date(p.date))}</td><td>${p.count}</td></tr>`).join('')}</tbody></table></div></details>`;
}
function bars(items, total, labels, type = '') {
  return `<div class="strategy-bars">${items.map(({ key, count }) => `<div class="strategy-bar-row"><div><span>${esc(labels[key] || key)}</span><strong>${fmt(count)}</strong></div><svg viewBox="0 0 300 7" preserveAspectRatio="none" aria-hidden="true"><rect width="300" height="7" rx="3.5" class="strategy-bar-bg"/><rect width="${total ? count / total * 300 : 0}" height="7" rx="3.5" class="strategy-bar-fill ${type}"/></svg></div>`).join('')}</div>`;
}
function evidenceCard(entry, ctx) {
  const computed = entry.readOnly;
  return `<article class="strategy-insight ${entry.archivedAt ? 'is-archived' : ''}"><div class="strategy-insight-top">${badge(computed ? 'Evidência interna' : entry.classification === 'hypothesis' ? 'Hipótese' : 'Evidência informada', computed ? 'verified' : entry.classification === 'hypothesis' ? 'hypothesis' : 'manual')}${entry.archivedAt ? badge('Arquivada') : ''}${!computed && ctx.canWrite ? `<button class="strategy-text-button" data-strategy-action="edit-entry" data-strategy-id="${esc(entry.id)}" aria-label="Editar ${esc(entry.title)}">Editar</button>` : ''}</div><h4>${esc(entry.title)}</h4>${entry.description ? `<p>${esc(entry.description)}</p>` : ''}<details><summary>${computed ? 'Como foi calculado' : 'Fonte e contexto'}</summary>${computed ? `<p>${esc(entry.source.from)} a ${esc(entry.source.to)} · UTC<br>Regra: ${esc(entry.formula)}<br>Valor: ${fmt(entry.numerator)}${entry.denominator !== null ? ' de ' + fmt(entry.denominator) + ' itens ativos' : ''}.</p><p>Calculado com os registros internos desta marca. Não é desempenho em redes sociais.</p>` : `<p>${entry.sourceType === 'public_source' ? 'Fonte pública registrada pela equipe' : 'Informação fornecida pela equipe'} · ${esc(date(entry.observedOn))}<br>${sourceLink(entry.sourceUrl)}</p><p>${esc(entry.sourceNotes || 'A equipe ainda não registrou uma fonte. Valide esta hipótese antes de usá-la como fato.')}</p><p>Versão ${entry.version} · atualização em ${esc(date(entry.updatedAt))}. Sem verificação independente.</p>${ctx.canWrite ? `<button class="strategy-text-button" data-strategy-action="archive-entry" data-strategy-id="${esc(entry.id)}">${entry.archivedAt ? 'Restaurar' : 'Arquivar'} registro</button>` : ''}`}</details></article>`;
}
function competitorTable(data, ctx) {
  if (!data.competitors.length) return empty('Nenhum concorrente cadastrado para esta marca. Adicione referências com fonte e data para começar a comparação.');
  return `<div class="strategy-table-wrap" tabindex="0" role="region" aria-label="Comparação de concorrentes, role para os lados"><table class="strategy-comparison"><caption>Observações manuais. Ausência de dado não significa zero; números de fontes ou períodos diferentes podem não ser comparáveis.</caption><thead><tr><th>Referência</th><th>Posicionamento / público</th><th>Formatos</th><th>Seguidores observados</th><th>Posts por semana</th><th>Fonte e data</th>${ctx.canWrite ? '<th>Ações</th>' : ''}</tr></thead><tbody>${data.competitors.map(c => `<tr class="${c.archivedAt ? 'is-archived' : ''}"><th scope="row"><strong>${esc(c.name)}</strong><small>${esc(platformLabels[c.platform])}</small>${c.archivedAt ? badge('Arquivado') : ''}<div class="strategy-source-links">${sourceLink(c.profileUrl, 'Perfil')}${sourceLink(c.websiteUrl, 'Site')}</div></th><td>${esc(c.positioning || 'Não informado')}<small>Público: ${esc(c.audience || 'não informado')}</small></td><td>${esc(c.formats || 'Não informado')}</td><td class="strategy-numeric">${fmt(c.followers)}</td><td class="strategy-numeric">${fmt(c.postsPerWeek)}${c.postsObserved !== null ? `<small>${fmt(c.postsObserved)} posts / ${c.observationDays} dias</small>` : '<small>Janela não informada</small>'}</td><td>${sourceLink(c.sourceUrl) || 'Informado pela equipe'}<small>${esc(date(c.observedOn))}</small><details><summary>Nota da fonte</summary><p>${esc(c.sourceNotes)}</p><p>Observação manual · versão ${c.version}. Sem verificação independente.</p></details></td>${ctx.canWrite ? `<td><button class="strategy-text-button" data-strategy-action="edit-competitor" data-strategy-id="${esc(c.id)}">Editar</button><button class="strategy-text-button" data-strategy-action="archive-competitor" data-strategy-id="${esc(c.id)}">${c.archivedAt ? 'Restaurar' : 'Arquivar'}</button></td>` : ''}</tr>`).join('')}</tbody></table></div>`;
}
function markup(ctx) {
  const d = ctx.data, m = d.metrics;
  const shown = [...d.derivedEntries, ...d.entries].filter(e => ctx.classification === 'all' || e.classification === ctx.classification);
  return `<div class="strategy-dashboard"><header class="strategy-hero"><div><span class="strategy-overline">INTELIGÊNCIA EDITORIAL · ${esc(d.workspace.name)}</span><h1>Clareza para o próximo passo.</h1><p>Produção, estratégia e referências da sua marca, no mesmo lugar.</p></div><div class="strategy-truth">${badge('Dados internos reais', 'verified')}<span>Atualizado em ${esc(date(d.generatedAt))}<br>Escopo exclusivo desta marca</span>${ctx.options.canExport?'<button class="btn small" data-action="export">Exportar organização</button>':''}</div></header><form id="strategy-period-form" class="strategy-filters" data-strategy-form="period"><div class="strategy-period-buttons" role="group" aria-label="Período de produção">${[30,90,365].map(days => `<button type="button" data-strategy-action="period" data-strategy-days="${days}" aria-pressed="${d.period.days === days}">${days === 365 ? '12 meses' : days + ' dias'}</button>`).join('')}</div><label>De<input type="date" name="from" value="${d.period.from}" max="${ctx.today}" required></label><label>Até<input type="date" name="to" value="${d.period.to}" max="${ctx.today}" required></label><button class="btn" type="submit">Aplicar período</button><p>Data de criação · UTC</p><div class="strategy-filter-error" role="alert"></div></form><div class="strategy-scope-note"><span aria-hidden="true">◈</span><p>Este dashboard mede a produção editorial interna. Alcance, engajamento e resultados das redes ainda não estão disponíveis. As observações de concorrentes são preenchidas pela equipe.</p></div><section aria-label="Indicadores editoriais" class="strategy-kpis">${[
    ['Conteúdos criados', m.totalPosts, 'Inclui itens arquivados', '01'],
    ['Prontos no fluxo', m.readyPosts, 'Aprovados + planejados', '02'],
    ['Aguardando revisão', m.counts.in_review, 'Estado atual dos itens', '03'],
    ['Aprovação vigente', m.approvalRate === null ? '—' : fmt(m.approvalRate) + '%', m.activePosts ? `${m.readyPosts} de ${m.activePosts} conteúdos ativos` : 'Sem conteúdos ativos na amostra', '04']
  ].map(([label, value, note, number]) => `<article class="strategy-kpi"><div><span>${label}</span><small>${number}</small></div><strong>${typeof value === 'number' ? fmt(value) : value}</strong><p>${note}</p></article>`).join('')}</section><div class="strategy-two-up"><section class="strategy-panel"><div class="strategy-panel-heading"><div><h2>Ritmo de produção</h2><p>Conteúdos criados por dia, incluindo arquivados</p></div>${badge(d.period.days + ' dias')}</div>${trendChart(d)}</section><section class="strategy-panel"><div class="strategy-panel-heading"><div><h2>Do rascunho ao planejado</h2><p>Estado atual dos conteúdos criados no período</p></div></div>${bars(Object.entries(m.counts).map(([key,count])=>({key,count})),m.totalPosts,statusLabels)}</section></div><div class="strategy-two-up strategy-mixes"><section class="strategy-panel"><div class="strategy-panel-heading"><div><h2>Mix de formatos</h2><p>Composição da produção, sem ranking de performance</p></div></div>${bars(m.formatMix.map(f=>({key:f.format,count:f.count})),m.totalPosts,formatLabels,'teal')}</section><section class="strategy-panel"><div class="strategy-panel-heading"><div><h2>Destinos editoriais</h2><p>Uma peça pode ter mais de um destino</p></div></div>${m.channelMix.length?bars(m.channelMix.map(c=>({key:c.platform,count:c.count})),Math.max(...m.channelMix.map(c=>c.count)),platformLabels,'gold'):empty('Nenhum destino vinculado aos conteúdos deste período.')}<p class="strategy-footnote">Vínculo editorial não comprova publicação na rede.</p></section></div><section class="strategy-fofa-section">${sectionHead('01 / DIREÇÃO ESTRATÉGICA','Matriz FOFA','Fatos do processo e hipóteses da equipe, com suas origens à vista.',ctx.canWrite?'<button class="btn primary" data-strategy-action="new-entry">+ Adicionar análise</button>':'')}<div class="strategy-toolbar"><label>Mostrar<select id="strategy-entry-filter"><option value="all" ${ctx.classification==='all'?'selected':''}>Todas as análises</option><option value="evidence" ${ctx.classification==='evidence'?'selected':''}>Evidências</option><option value="hypothesis" ${ctx.classification==='hypothesis'?'selected':''}>Hipóteses</option></select></label><label class="strategy-check"><input type="checkbox" id="strategy-archives" ${ctx.archived?'checked':''}> Incluir registros arquivados</label><p>FOFA = forças, oportunidades, fraquezas e ameaças</p></div><div class="strategy-fofa">${Object.entries(quadrants).map(([key,[name,letter,desc,environment]])=>`<section class="strategy-quadrant ${key}" aria-label="${name}"><div class="strategy-quadrant-heading"><div class="strategy-quadrant-letter" aria-hidden="true">${letter}</div><div><h3>${name}</h3><p>${desc}</p></div><span>${shown.filter(e=>e.quadrant===key).length}</span></div><div class="strategy-environment">${environment}</div><div class="strategy-insights">${shown.filter(e=>e.quadrant===key).map(e=>evidenceCard(e,ctx)).join('')||empty(key==='opportunity'||key==='threat'?'Nenhuma análise registrada. Adicione uma hipótese ou evidência com contexto.':'Sem sinal disponível para este filtro. As regras só usam registros reais da marca.')}</div></section>`).join('')}</div><p class="strategy-footnote">Os sinais automáticos são regras transparentes sobre o fluxo editorial. Não avaliam qualidade criativa nem posição de mercado. Análises manuais permanecem salvas e não são limitadas pelo filtro de produção.</p></section><section class="strategy-competitors">${sectionHead('02 / CONTEXTO DE MERCADO','Olhar para fora. Decidir com contexto.','Compare referências da marca com observações documentadas.',ctx.canWrite?'<button class="btn" data-strategy-action="new-competitor">+ Adicionar concorrente</button>':'')}<div class="strategy-panel strategy-comparison-panel">${competitorTable(d,ctx)}</div><p class="strategy-footnote">${esc(d.competitorMethodology)} O período no topo filtra apenas a produção interna; cada concorrente mantém sua própria data de observação.</p></section><details class="strategy-methodology"><summary>Origem dos dados e método de análise</summary><p>${esc(d.methodology.scope)}</p><p>${esc(d.methodology.note)}</p><p>Regras: itens com aprovação vigente → força editorial; múltiplas plataformas planejadas → diversidade de destinos; ausência de legenda, ausência de alvo e ajustes pendentes → pontos de atenção. Uma oportunidade ou ameaça externa precisa ser registrada pela equipe.</p><p>Nenhuma IA externa, coleta automática, pontuação estimada ou ranking é usado. Evidência informada é uma classificação feita pela equipe, sem verificação independente.</p></details></div>`;
}
function field(name, label, value = '', { type = 'text', max = 2000, required = false, placeholder = '', rows } = {}) {
  const id = 'strategy-' + name;
  return `<div class="field"><label for="${id}">${esc(label)}</label>${rows ? `<textarea id="${id}" name="${name}" rows="${rows}" maxlength="${max}" ${required?'required':''} placeholder="${esc(placeholder)}">${esc(value)}</textarea>` : `<input id="${id}" name="${name}" type="${type}" value="${esc(value)}" ${type==='number'?'min="0" step="1"':`maxlength="${max}"`} ${required?'required':''} placeholder="${esc(placeholder)}">`}</div>`;
}
function select(name,label,options,value) { return `<div class="field"><label for="strategy-${name}">${label}</label><select id="strategy-${name}" name="${name}">${Object.entries(options).map(([key,text])=>`<option value="${key}" ${value===key?'selected':''}>${text}</option>`).join('')}</select></div>`; }
function sourceFields(value = {}) { return `${select('sourceType','Origem da informação',{user_provided:'Informada pela equipe',public_source:'Fonte pública'},value.sourceType||'user_provided')}<div class="field-row">${field('sourceUrl','URL da fonte',value.sourceUrl,{type:'url',placeholder:'https://…'})}${field('observedOn','Data da observação',value.observedOn,{type:'date'})}</div>${field('sourceNotes','Nota sobre a fonte / contexto',value.sourceNotes,{rows:3,placeholder:'Quem observou, onde e como? Registre também limitações da informação.'})}`; }
function openDialog(ctx, content) {
  closeDialog(ctx,true);
  ctx.returnFocus = document.activeElement;
  const dialog = document.createElement('dialog');
  dialog.className = 'strategy-dialog'; dialog.setAttribute('aria-labelledby','strategy-dialog-title');
  dialog.innerHTML = content;ctx.root.append(dialog);ctx.dialog=dialog;ctx.dirty=false;
  dialog.addEventListener('cancel',event=>{event.preventDefault();closeDialog(ctx);},{signal:ctx.controller.signal});
  if(typeof dialog.showModal==='function')dialog.showModal();else dialog.setAttribute('open','');
  dialog.querySelector('input,select,textarea,button')?.focus();
}
function closeDialog(ctx,force=false) {
  if(ctx.saving&&!force)return;
  if(ctx.dirty&&!force&&ctx.dialog){let warning=ctx.dialog.querySelector('.strategy-discard');if(!warning){warning=document.createElement('div');warning.className='strategy-discard';warning.innerHTML='<p>Há alterações não salvas. Deseja descartá-las?</p><button type="button" class="btn" data-strategy-action="keep-editing">Continuar editando</button> <button type="button" class="btn danger" data-strategy-action="discard">Descartar alterações</button>';ctx.dialog.append(warning);}warning.querySelector('button')?.focus();return;}
  ctx.dialog?.remove();ctx.dialog=null;ctx.dirty=false;ctx.returnFocus?.isConnected&&ctx.returnFocus.focus();
}
function entryForm(ctx, entry) {
  const e=entry||{quadrant:'strength',classification:'hypothesis'};
  openDialog(ctx,`<h2 id="strategy-dialog-title">${entry?'Editar análise':'Adicionar à matriz FOFA'}</h2><p>Escolha o quadrante e diferencie uma hipótese de uma evidência informada.</p><form data-strategy-form="entry" data-strategy-id="${esc(entry?.id||'')}" data-version="${entry?.version||''}"><div class="field-row">${select('quadrant','Quadrante',Object.fromEntries(Object.entries(quadrants).map(([key,v])=>[key,v[0]])),e.quadrant)}${select('classification','Classificação',{hypothesis:'Hipótese a validar',evidence:'Evidência informada pela equipe'},e.classification)}</div>${field('title','Título da análise',e.title,{max:160,required:true})}${field('description','Contexto e implicação',e.description,{rows:3,max:2000})}<div class="strategy-form-note">Evidências precisam de data e fonte ou nota de origem. Fontes públicas precisam de URL. Marcar como evidência não significa validação independente.</div>${sourceFields(e)}<div class="form-error" role="alert"></div><div class="dialog-actions"><button type="button" class="btn" data-strategy-action="close">Cancelar</button><button class="btn primary" type="submit">Salvar análise</button></div></form>`);
}
function competitorForm(ctx,c) {
  openDialog(ctx,`<h2 id="strategy-dialog-title">${c?'Editar concorrente':'Adicionar concorrente'}</h2><p>Registre uma referência real. Deixe em branco os dados que você ainda não tem.</p><form data-strategy-form="competitor" data-strategy-id="${esc(c?.id||'')}" data-version="${c?.version||''}"><div class="field-row">${field('name','Nome da referência',c?.name,{max:120,required:true})}${select('platform','Plataforma observada',platformLabels,c?.platform||'other')}</div><div class="field-row">${field('websiteUrl','Site (opcional)',c?.websiteUrl,{type:'url'})}${field('profileUrl','Perfil público (opcional)',c?.profileUrl,{type:'url'})}</div>${field('positioning','Posicionamento observado',c?.positioning,{max:1000,rows:2})}${field('audience','Público observado',c?.audience,{max:1000,rows:2})}${field('formats','Formatos observados',c?.formats,{max:1000,placeholder:'Ex.: vídeos curtos, carrosséis explicativos'})}<div class="strategy-form-note">Números são opcionais e manuais. Zero é um valor observado; campo vazio significa dado não informado. Frequência = posts observados ÷ dias × 7.</div><div class="strategy-form-three">${field('followers','Seguidores observados',c?.followers,{type:'number'})}${field('postsObserved','Posts observados',c?.postsObserved,{type:'number'})}${field('observationDays','Dias de observação',c?.observationDays,{type:'number'})}</div>${sourceFields(c)}<div class="form-error" role="alert"></div><div class="dialog-actions"><button type="button" class="btn" data-strategy-action="close">Cancelar</button><button class="btn primary" type="submit">Salvar concorrente</button></div></form>`);
}
function archiveDialog(ctx,type,item) {
  openDialog(ctx,`<h2 id="strategy-dialog-title">${item.archivedAt?'Restaurar':'Arquivar'} ${type==='entry'?'análise':'concorrente'}?</h2><p>${esc(item.title||item.name)}</p><p>${item.archivedAt?'O registro voltará à visualização ativa desta marca.':'O registro e seu histórico serão preservados. Você poderá restaurá-lo em “Incluir registros arquivados”.'}</p><form data-strategy-form="archive" data-entity-type="${type}" data-strategy-id="${esc(item.id)}" data-version="${item.version}" data-archive="${!item.archivedAt}"><div class="form-error" role="alert"></div><div class="dialog-actions"><button type="button" class="btn" data-strategy-action="close">Cancelar</button><button class="btn primary" type="submit">${item.archivedAt?'Restaurar':'Arquivar'}</button></div></form>`);
}
async function load(ctx) {
  const seq=++ctx.sequence, params=new URLSearchParams();if(ctx.from){params.set('from',ctx.from);params.set('to',ctx.to);}if(ctx.archived)params.set('archived','all');
  const response=await ctx.api(ctx.basePath+'/strategy/dashboard'+(params.size?'?'+params:''));
  if(!ctx.alive()||seq!==ctx.sequence)return false;
  ctx.data=response.data;ctx.today=ctx.data.generatedAt.slice(0,10);ctx.canWrite=ctx.options.canWrite!==false&&ctx.data.permissions.write;ctx.from=ctx.data.period.from;ctx.to=ctx.data.period.to;
  ctx.root.innerHTML=markup(ctx);return true;
}
async function submit(ctx,form) {
  const kind=form.dataset.strategyForm;
  if(kind==='period'){
    const f=new FormData(form);ctx.from=String(f.get('from'));ctx.to=String(f.get('to'));const button=form.querySelector('button[type=submit]');button.disabled=true;
    try{await load(ctx);}catch(error){if(ctx.alive())form.querySelector('.strategy-filter-error').textContent=error.message;}finally{if(button.isConnected)button.disabled=false;}return;
  }
  if(ctx.saving||!ctx.canWrite)return;
  ctx.saving=true;const buttons=[...form.querySelectorAll('button')];buttons.forEach(b=>b.disabled=true);
  const f=new FormData(form),id=form.dataset.strategyId;let body={},type=kind;
  if(kind==='archive'){type=form.dataset.entityType;body={expectedVersion:Number(form.dataset.version),archived:form.dataset.archive==='true'};}
  else{
    for(const [key,value]of f)body[key]=String(value).trim();
    for(const key of ['sourceUrl','observedOn',...(kind==='competitor'?['websiteUrl','profileUrl']:[])])body[key]=body[key]||null;
    if(kind==='competitor')for(const key of ['followers','postsObserved','observationDays'])body[key]=body[key]===''?null:Number(body[key]);
    if(id)body.expectedVersion=Number(form.dataset.version);
  }
  const path=ctx.basePath+'/strategy/'+(type==='entry'?'entries':'competitors')+(id?'/'+encodeURIComponent(id):'');
  try{
    await ctx.api(path,{method:id?'PATCH':'POST',body,idempotent:true});
    if(!ctx.alive())return;ctx.saving=false;closeDialog(ctx,true);ctx.options.onToast?.(kind==='archive'?'Registro atualizado. Histórico preservado.':'Registro estratégico salvo.');await load(ctx);
  }catch(error){if(ctx.alive()&&form.isConnected)form.querySelector('.form-error').textContent=error.status===409&&error.code==='VERSION_CONFLICT'?'Outra pessoa alterou este registro. Seu texto foi preservado aqui. Copie suas mudanças e reabra a análise para editar a versão atual.':error.message;else if(ctx.alive())ctx.options.onError?.(error);}
  finally{ctx.saving=false;buttons.forEach(b=>{if(b.isConnected)b.disabled=false;});}
}
async function handleClick(ctx,event) {
  const button=event.target.closest('[data-strategy-action]');if(!button||button.disabled||!ctx.root.contains(button))return;
  event.preventDefault();event.stopPropagation();const action=button.dataset.strategyAction;
  if(action==='close'){closeDialog(ctx);return;}if(action==='discard'){closeDialog(ctx,true);return;}if(action==='keep-editing'){ctx.dialog.querySelector('.strategy-discard')?.remove();return;}
  if(action==='period'){
    const days=Number(button.dataset.strategyDays);ctx.to=ctx.today;ctx.from=new Date(Date.parse(ctx.today+'T00:00:00Z')-(days-1)*86400000).toISOString().slice(0,10);button.disabled=true;
    try{await load(ctx);}catch(error){if(ctx.alive())ctx.root.querySelector('.strategy-filter-error').textContent=error.message;}finally{if(button.isConnected)button.disabled=false;}return;
  }
  if(!ctx.canWrite)return;
  if(action==='new-entry'){entryForm(ctx);return;}if(action==='new-competitor'){competitorForm(ctx);return;}
  const type=action.endsWith('competitor')?'competitor':'entry',item=(type==='entry'?ctx.data.entries:ctx.data.competitors).find(e=>e.id===button.dataset.strategyId);if(!item)return;
  if(action.startsWith('edit-')||action.startsWith('archive-')){
    button.disabled=true;
    try{const fresh=await ctx.api(ctx.basePath+'/strategy/'+(type==='entry'?'entries':'competitors')+'/'+encodeURIComponent(item.id));if(!ctx.alive())return;if(action.startsWith('edit-')){type==='entry'?entryForm(ctx,fresh.data):competitorForm(ctx,fresh.data);}else archiveDialog(ctx,type,fresh.data);}
    finally{if(button.isConnected)button.disabled=false;}
  }
}
async function render(options) {
  cleanup();
  const ctx={ options,root:options.root,api:options.api,basePath:options.basePath,controller:new AbortController(),sequence:0,classification:'all',archived:false,saving:false,dirty:false,today:new Date().toISOString().slice(0,10) };
  active=ctx;ctx.alive=()=>active===ctx&&ctx.root.isConnected&&(!options.isCurrent||options.isCurrent(options.renderId));
  ctx.root.innerHTML='<div class="strategy-empty" role="status">Preparando o dashboard desta marca…</div>';
  const signal=ctx.controller.signal;
  ctx.root.addEventListener('submit',event=>{const form=event.target.closest('[data-strategy-form]');if(!form)return;event.preventDefault();event.stopImmediatePropagation();submit(ctx,form).catch(error=>{if(ctx.alive())options.onError?.(error);});},{signal});
  ctx.root.addEventListener('click',event=>handleClick(ctx,event).catch(error=>{if(ctx.alive())options.onError?.(error);}),{signal});
  ctx.root.addEventListener('input',event=>{if(event.target.closest('.strategy-dialog form'))ctx.dirty=true;},{signal});
  ctx.root.addEventListener('change',async event=>{if(event.target.closest('.strategy-dialog form'))ctx.dirty=true;if(event.target.id==='strategy-entry-filter'){ctx.classification=event.target.value;ctx.root.innerHTML=markup(ctx);}if(event.target.id==='strategy-archives'){ctx.archived=event.target.checked;try{await load(ctx);}catch(error){if(ctx.alive())options.onError?.(error);}}},{signal});
  await load(ctx);
}
window.SocialStrategy={render,cleanup,isDirty:()=>!!active?.dirty};
})();
