> Base histórica do piloto local 0.2, preservada para referência técnica. Para instalar o AgendePost 0.3 na VPS, use HOSTINGER-DEPLOY.md, HOSTED-OPERATIONS.md e META-SETUP-HOSTED.md. As antigas restrições operacionais de perfil local não descrevem o opt-in hospedado; os controles de isolamento e publicação permanecem válidos.

# Matriz de aceitação do protótipo SaaS

**Planejada. Nenhum destes testes foi executado contra um SaaS novo.**

Esta matriz não herda os 84 testes aprovados no produto local: casos podem ser reaproveitados, mas precisam rodar novamente no novo modelo multiusuário.

## Fixtures e ambientes

- Cada teste cria banco temporário real e roda migrations; testes de persistência fecham e reabrem a aplicação.
- Tenant A com marcas A1/A2 e tenant B com marca B1. Owner, admin, editor de A1, reviewer de A1, viewer de A1, editor de A2 e usuário removido. Um usuário participa de A e B para testar troca de contexto.
- Cookies independentes por identidade; nunca um superusuário genérico que contorne autorização. Uma sessão anônima e uma expirada.
- Relógio, gerador de IDs, mail adapter e billing adapter injetáveis. Testes criptográficos usam algoritmos reais; tempos/concorrência de carga são medidos separadamente.
- Processo de testes sem serviços reais e sem chaves reais; fornecedor fake não deve ser instanciável na configuração de produção.

## Gate 1: identidade, fronteiras e banco

| Área | Testes mínimos | Resultado exigido |
|---|---|---|
| Migrações | Banco vazio, reaplicação, checksum alterado, versão futura, falha intermediária | Schema consistente; sem reset; recusa segura de incompatibilidade |
| Persistência | Restart com contas, sessão válida, grants, posts, mídia e eventos | Dados e autorização preservados; revogações permanecem |
| Cadastro | Email duplicado/case, normalização, senha definida só com token válido, enumeração, pré-cadastro malicioso | Sem identidade duplicada nem senha escolhida por quem não controla o email |
| Hash | Salt distinto para senha igual, parâmetros serializados, comparação, entrada malformada | Sem plaintext; hash conhecido não autentica como senha; custo correto |
| Abuso | Rajadas por IP/email, hash concorrente e fila cheia, cooldown | 429 controlado; servidor não exaure memória nem bloqueia o event loop |
| Email/reset | Token errado, propósito trocado, expirado, usado duas vezes, duas aceitações concorrentes | Apenas uma mutação; resposta genérica; sessões antigas revogadas |
| Sessão | Fixação pré-login, cookie ausente/forjado, idle/absolute expiry, logout/restart, usuário bloqueado | IDs rotacionados; expiração e revogação efetivas |
| Cookies | HTTPS vs loopback, Path, Domain ausente, HttpOnly, Secure, SameSite | Produção nunca aceita modo de cookie inseguro |
| CSRF | Token ausente/errado/de outra sessão, Origin malicioso/null, login/logout CSRF | 403 sem mutação; webhook é exceção isolada e assinada |
| Isolamento | Cada rota com IDs de B em sessão A; B em query/body/relacionamento/export/download | 404 ou rejeição uniforme; nenhuma entidade, contagem ou byte vaza |
| Marcas | Reviewer A1 solicita A2, liga mídia/canal A2 a post A1 | Mesmo resultado de negação dentro do tenant |
| Banco | INSERT direto de relações cruzadas e tenant NULL | Constraint impede corrupção mesmo sem middleware |
| RBAC | Matriz papel × verbo × entidade × escopo | Apenas capacidades descritas no contrato passam |
| Mudança de acesso | Remover grant/membership com sessão aberta e download pendente futuro | Próxima autorização nega; UI limpa o contexto sem exibir dados antigos |
| Propriedade | Dois owners se removem/rebaixam simultaneamente; convite que promove acima do ator | Ao menos um owner permanece; sem elevação |

## Gate 2: trabalho editorial e experiência

| Área | Testes mínimos | Resultado exigido |
|---|---|---|
| CRUD | Criar/editar/duplicar/arquivar/restaurar, IDs inexistentes e repetição de cliques | Persistência real; nenhuma duplicação acidental |
| Concorrência | Dois editores alteram a mesma revisão | Uma gravação; segunda recebe 409 e pode recuperar seu texto |
| Revisão | Editor tenta aprovar, reviewer muda legenda, autor aprova com independência ligada | Todas as mutações proibidas rejeitadas no servidor |
| Aprovação válida | Alterar texto, imagem, canal ou data após aprovação; replay de aprovação antiga | Aprovação invalidada; não planejar versão não aprovada |
| Comentários | Autor forjado, texto HTML, comentário em post invisível | Ator real; conteúdo inerte; isolamento mantido |
| Data/fuso | São Paulo, virada de dia, offset ausente, data impossível, DST inexistente/ambíguo | Instante e dia corretos; ambiguidade exige decisão explícita |
| Mídia | JPEG/PNG/WebP válidos; SVG/HTML, MIME mentiroso, polyglot, truncado, animação, imagem enorme | Apenas raster decodificado/regravado; limites pré/pós-decodificação |
| Upload | Content-Length falso/ausente, stream excedido, partes extras, concorrência, erro do decoder | Aborta controladamente; sem bytes/quota órfãos; processo saudável |
| Download | URL copiada para outro usuário/tenant; sessão revogada; nomes com traversal | Nenhum acesso por obscuridade; nomes nunca viram paths |
| Mídia referenciada | Excluir mídia em post atual ou revisão histórica | Rejeitar; preservação do histórico documentada |
| Quota | Limite exato, uma unidade além, duas escritas concorrentes, dois convites para último assento | Uma gravação ganha quando só há espaço para uma; contadores corretos |
| Downgrade | Organização acima do plano, grant expirado e cancelamento | Não apagar dados; permitir leitura/exportação autorizada e bloquear aumento |
| Auditoria | Mutação bem-sucedida/falha, rollback, admin grant, inspeção de logs | Ação vinculada ao ator; sem tokens/secret/payload privado indevido |
| UI | Login, troca de tenant/marca, filtros, calendário, aprovação, logout/back/reload | Nenhum dado antigo de outro contexto; estado sincronizado ao backend |
| Interrupção | Back/Forward, Escape, cancelar, sessão expirada durante edição, duplo clique | Recuperar trabalho quando seguro; nunca repetir operação sem controle |
| XSS | Payload persistido em título, legenda, nomes, comentários, filenames e erros | Texto inerte sob CSP real no navegador |

## Gate 3: cobrança e superfície comercial

| Área | Testes mínimos | Resultado exigido |
|---|---|---|
| Disabled billing | Botão/endpoint checkout e portal sem configuração | Explicação clara; nenhuma URL/assinatura/pagamento fabricado |
| Assinatura | Header real de teste do SDK, segredo errado, corpo alterado, header ausente, timestamp vencido | Apenas evento válido segue para persistência |
| Corpo cru | Mudança de whitespace/ordem após assinatura; parser JSON precoce | Verificação usa bytes originais; alteração falha |
| Replay/idempotência | Mesmo evento 2× e simultâneo, crash depois de enqueue/antes de processar | Um efeito lógico; retomada segura |
| Ordem | Cancelamento/ativação/invoice fora de ordem e com mesmo timestamp | Estado atual reconciliado; evento antigo não reativa indevidamente |
| Mapeamento | Customer de B com metadata A, subscription desconhecida, modo live num teste | Nenhuma mudança em A; quarentena/rejeição apropriada |
| Worker | API indisponível, lease vencida, falha persistente, reprocessamento | Retry limitado, fila de falha visível e sem perda silenciosa |
| Quota após billing | Dois eventos/grants competindo, atualização de entitlement | Versão/coerência transacional; entitlement não vem do browser |
| Plataforma | Owner de tenant tenta `/admin`; admin da plataforma tenta mídia editorial | Ambos bloqueados fora de sua competência |
| Comercial | Percorrer página e links; validar lista de capacidades | Nenhum claim de integração, envio, receita, prova social ou SLA inexistente |

## Evidência e comandos esperados da futura implementação

O projeto deverá fornecer `npm ci`, `npm run check`, `npm test`, `npm run test:http` e `npm run test:e2e`. O lockfile e a versão Node usados devem acompanhar o relatório. Não são comandos disponíveis agora: package.json e código ainda não existem nesta pasta.

Fastify inject cobre rotas, mas não substitui testes TCP nem navegador. O gate HTTP deve testar bind loopback, Host, proxy spoofing, parsing de corpo, estáticos, CSP e cookies. Playwright deve executar fluxos em Chromium com contextos independentes, capturar telas das páginas principais e testar layout estreito/teclado. Asserções web com espera automática reduzem fragilidade, sem substituir verificação do resultado de negócio. [Playwright: assertions](https://playwright.dev/docs/test-assertions).

Relatório final separa: aprovado, falhou, não executado e fora de escopo. Browser indisponível significa QA visual pendente. Email fake significa entregabilidade não verificada. Assinatura de fixture significa sandbox/live não verificado. SQLite aprovado não significa PostgreSQL/RLS aprovado.

## Gates exclusivos do lançamento público

- Repetir isolamento e matriz de permissões com PostgreSQL e a role RLS de produção, incluindo ausência/leak de contexto em pool de conexões.
- Restaurar backup em ambiente limpo; conferir contagens, hashes de mídia e escopos; medir perda máxima/tempo de recuperação.
- Testar HTTPS/proxy real, cookies, email externo, MFA admin, armazenamento privado e revogação de acesso a mídia.
- Exercitar Stripe sandbox de ponta a ponta, inclusive eventos duplicados/fora de ordem, cancelamento e recuperação de falhas, somente depois de autorizado/configurado.
- Fazer teste de carga com dataset e perfil definidos. Publicar apenas resultados medidos e capacidade compatível com custos autorizados.
- Revisão independente de segurança, texto comercial e processos de suporte/privacidade antes de receber clientes.
