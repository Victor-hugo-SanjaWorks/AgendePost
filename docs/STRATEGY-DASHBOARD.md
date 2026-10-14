> Base histórica do piloto local 0.2, preservada para referência técnica. Para instalar o AgendePost 0.3 na VPS, use HOSTINGER-DEPLOY.md, HOSTED-OPERATIONS.md e META-SETUP-HOSTED.md. As antigas restrições operacionais de perfil local não descrevem o opt-in hospedado; os controles de isolamento e publicação permanecem válidos.

# Dashboard de estratégia por marca

O menu **Dashboard** substitui a antiga tela de relatórios. A rota da interface continua `#/app/reports`, preservando links existentes; **Visão geral** continua em `#/app/dashboard`. A API `/api/v1/tenants/:tid/reports/editorial` permanece disponível por compatibilidade.

## O que está implementado

- Indicadores, série diária e distribuições por estado, formato e destino, calculados a partir do banco editorial da marca selecionada.
- Filtro de produção por data de criação em UTC, de 1 a 366 dias, sem datas futuras. Padrão: últimos 30 dias. O estado de cada conteúdo é o estado atual, não uma reconstrução do estado histórico no dia escolhido.
- Matriz FOFA de quatro quadrantes, com sinais internos calculados por regras e análises manuais persistidas.
- Cadastro e comparação de concorrentes, com dados informados pela equipe, fonte, data, notas e janela de observação.
- Criação, edição, arquivamento reversível, restauração, versões esperadas e histórico de snapshots. Conflitos não sobrescrevem a edição de outra pessoa.
- Separação por organização e marca, com as mesmas permissões da edição editorial; revisor e leitor apenas consultam. O administrador da plataforma não ganha acesso ao conteúdo por esse papel.
- HTML fornecido pela equipe aparece como texto, nunca como marcação executável. Todos os gráficos e recursos da tela são locais.

## Origem e significado das métricas

| Indicador | Cálculo | Limitação |
|---|---|---|
| Conteúdos criados | Todos os posts criados na marca e no intervalo escolhido, incluindo arquivados | Não é número de publicações na rede |
| Prontos no fluxo | Estado atual `approved` + `planned` | Não atesta envio ou resultado externo |
| Aguardando revisão | Estado atual `in_review` | Não é tempo médio de aprovação |
| Aprovação vigente | (`approved` + `planned`) / posts não arquivados × 100, arredondado para uma casa | Sem amostra ativa, retorna `null` e a tela mostra `—` |
| Ritmo de produção | Contagem por dia de `created_at`, em UTC | Dias sem criação aparecem como zero real |
| Mix de formatos | Contagem de posts por formato | Não ordena formatos por performance |
| Destinos editoriais | Posts distintos vinculados a cada plataforma | Uma peça com múltiplos destinos participa de múltiplas contagens |

O dashboard retorna `source: "editorial-only"`, `socialMetrics: null` e `methodology.externalDataFetched: false`. Não apresenta alcance, engajamento, vendas, crescimento de seguidores da marca, escore de saúde ou benchmarking inventado. Dados operacionais do agendador não são reclassificados como resultado de marketing.

## FOFA

Forças e fraquezas automáticas são sinais de **produção interna**, com período, fórmula, numerador e denominador visíveis em “Como foi calculado”. Regras:

- Uma ou mais peças aprovadas/planejadas: força do fluxo de aprovação.
- Duas ou mais plataformas vinculadas: diversidade de destinos planejados.
- Peças ativas com legenda vazia: ponto de atenção; a necessidade de texto depende do formato.
- Peças ativas sem alvo editorial: ponto de atenção.
- Peças em `changes_requested`: ajustes pendentes.

Esses sinais são calculados em cada leitura, não gravados como opiniões permanentes. Uma organização vazia começa sem sinais, análises manuais ou concorrentes. Oportunidades e ameaças externas não são deduzidas sem dados: a equipe registra hipóteses ou evidências.

Entradas manuais têm:

- Quadrante: `strength`, `weakness`, `opportunity`, `threat`.
- Classificação: `hypothesis` ou `evidence`.
- Origem: `user_provided` ou `public_source`.
- Título, descrição, URL da fonte, data da observação e nota de origem.

Uma evidência exige data válida e URL ou nota de origem. Uma fonte pública exige URL. O rótulo **Evidência informada** identifica uma classificação da equipe: não significa verificação independente. Hipóteses sem fonte são explicitamente apresentadas como pendentes de validação.

O filtro de produção não oculta a estratégia manual: cada análise retém sua própria data. Há filtros para hipóteses/evidências e para incluir registros arquivados.

## Concorrentes e comparação

Cada registro representa uma referência observada em uma plataforma. A equipe pode cadastrar site, perfil, posicionamento, público, formatos, seguidores observados, posts observados e dias de observação. Todos os números são opcionais.

- Valor vazio → `null` → **Não informado**.
- Zero → observação explícita de zero, preservada como zero.
- Frequência semanal = posts observados ÷ dias observados × 7, com duas casas decimais.
- Contagem de posts e janela precisam ser preenchidas juntas. A janela vai de 1 a 365 dias.
- Fonte, data e nota são preservadas em todas as versões. Fonte pública exige URL; informação da equipe exige nota e data.
- A comparação não gera ranking ou conclusão de superioridade. Fontes, plataformas e janelas diferentes podem não ser comparáveis.

O backend nunca acessa as URLs. Somente HTTP/HTTPS sem credenciais é aceito; protocolos executáveis, rede local, loopback e endereços IPv6 são rejeitados. Os links são abertos pelo usuário em nova aba com `noopener noreferrer`.

## Contrato da API

Prefixo: `/api/v1/tenants/:tid/workspaces/:wid/strategy`

| Método | Caminho | Função |
|---|---|---|
| GET | `/dashboard` | Métricas, sinais calculados, entradas e concorrentes da marca |
| GET | `/entries` ou `/competitors` | Listagem paginada |
| POST | `/entries` ou `/competitors` | Criação com `Idempotency-Key` obrigatório |
| GET | `/entries/:id` ou `/competitors/:id` | Leitura exata no escopo da marca |
| PATCH | `/entries/:id` ou `/competitors/:id` | Edição com `expectedVersion` obrigatório |
| GET | `/entries/:id/revisions` ou `/competitors/:id/revisions` | Histórico paginado por versão |

Dashboard: `from=YYYY-MM-DD&to=YYYY-MM-DD` são opcionais, mas devem aparecer juntos. `archived=false|true|all` filtra registros manuais, sem alterar as métricas editoriais.

Listagens: `limit` até 100, `cursor` opaco e `archived=false|true|all`. Arquivar/restaurar é PATCH com `{ "expectedVersion": N, "archived": true|false }`. Não há exclusão permanente nesse módulo. Limites por marca: 200 análises e 100 concorrentes, incluindo arquivados.

Todos os corpos usam allowlists estritas. Tenant, marca, autor, status de verificação e autoridade nunca vêm do corpo. IDs alheios retornam 404; ações sem permissão em registros visíveis retornam 403; conflitos de versão retornam 409. Datas de observação devem ser reais, entre 2000 e a data atual do servidor. As mutações, o histórico e a auditoria são gravados atomicamente, com conferência de associação e permissão atualizada.

Auditoria: ações `strategy.entry.*` e `strategy.competitor.*`, com versão e classificação/arquivamento, sem copiar o texto livre para o log. Snapshots completos ficam na tabela privada `strategy_revisions`, no mesmo escopo de organização/marca. O consumo de entitlement é verificado dentro da transação.

## Integração da interface

- `public/strategy-dashboard.js`: `window.SocialStrategy.render(options)`, `cleanup()` e `isDirty()`.
- `public/strategy-dashboard.css`: estilos responsivos e escopados, sem dependências externas.
- O app injeta o cliente HTTP autenticado/CSRF, o caminho da marca e o guard de renderização atual.
- Cada resposta assíncrona verifica contexto e sequência; uma resposta antiga de outra marca não substitui o dashboard atual.
- Abrir edição ou arquivamento consulta novamente a versão atual do registro.
- Envios repetidos são bloqueados pela interface e criação também é idempotente no servidor.
- Cancelar alterações pede descarte explícito. Navegação, troca de marca/organização e saída respeitam alterações não salvas.
- A exportação editorial da organização continua no cabeçalho para os papéis autorizados, com escopo explícito no rótulo.

## Verificação

Execute:

```sh
npm run check
node --test tests/strategy-http.test.mjs tests/strategy-frontend.test.mjs tests/security-strategy.test.mjs tests/security-strategy-dom.test.mjs
npm test
```

Os testes HTTP usam autenticação, SQLite, auditoria e rotas reais. Os testes de interface usam jsdom contra o app real, cobrindo persistência, campos de origem, conflitos, HTML inerte, duplo envio, arquivamento/restauração, período inválido, descarte e troca de contexto. Fixtures ficam em bancos temporários; não são dados de exemplo incluídos em organizações reais.

A execução visual em Chromium foi tentada, mas a criação de sockets do navegador foi bloqueada pelo ambiente. A tentativa pelo mecanismo de execução ampliada também falhou na preparação do sandbox. Portanto, a verificação DOM não deve ser apresentada como certificação de layout visual em navegador real.
