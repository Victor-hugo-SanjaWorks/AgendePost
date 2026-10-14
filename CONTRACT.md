# Contrato técnico de implementação

**Planejado, não implementado. Versão do contrato: 0.1, 14/10/2026.**

Complementa `docs/ARCHITECTURE.md`. Toda capacidade aqui descrita é requisito a construir e testar. Nome de trabalho: Social Studio.

## A. Invariantes

1. Nenhum código, banco, pacote ou launcher do aplicativo local será sobrescrito. O novo banco será `social_saas/data/social-saas.sqlite`, nunca o arquivo legado.
2. Autenticação, associação ativa, autorização da ação e escopo de marca são verificados no servidor em toda requisição. Nenhuma rota aceita `tenantId`, `role`, `authorId`, `isAdmin`, preço ou status de pagamento do cliente como autoridade.
3. Todo objeto de negócio pertence a exatamente um tenant. Mídia, canal editorial e post pertencem também a exatamente uma marca. Não existem mídias globais compartilhadas por conveniência.
4. Negar por padrão; não revelar a existência de recurso fora do escopo. Recurso de outro tenant/marca retorna 404. Permissão insuficiente em recurso visível retorna 403.
5. `planned` significa somente planejamento interno. Não existe escrita de estado `published`, conexão falsa ou métrica social sem origem comprovada.
6. Todo update editorial usa revisão esperada. Aprovações referem-se à revisão exata, não apenas ao ID do post.
7. Quota, gravação, idempotência e auditoria relevante são atômicas. Um erro não deixa meia associação, convite consumido sem membro ou bytes sem quota.
8. Dados de exemplo são opt-in e identificados. Uma nova organização real começa vazia. Fixtures e adaptadores fake nunca se tornam fontes de dados comerciais reais.

## B. Modelo de dados mínimo

Usar IDs opacos gerados no servidor; datas UTC em representação consistente; timezone IANA por tenant e por intenção de agendamento. Colunas de autoridade e relacionamento normalizadas, não escondidas em blobs JSON. JSON é limitado a metadados não autoritativos com schema.

| Entidade | Campos/índices essenciais | Restrição importante |
|---|---|---|
| `users` | id, email_normalized UNIQUE, display_name, password_hash, email_verified_at, status, session_epoch, created_at | Hash nulo apenas enquanto cadastro pendente; sem role de tenant nesta tabela |
| `sessions` | token_hash UNIQUE, user_id, csrf_token, created_at, last_seen_at, expires_at, absolute_expires_at, revoked_at, auth_at, session_epoch | Sem identificador de sessão em claro; validar status/epoch em toda requisição; CSRF separado não autentica |
| `preauth_sessions` | token_hash, csrf_token, expires_at | Login/cadastro protegidos contra CSRF; TTL curto e limite global |
| `auth_tokens` | token_hash UNIQUE, user_id, purpose, expires_at, consumed_at | Propósito separado: email verification ou password reset |
| `tenants` | id, name, slug UNIQUE, timezone, status, require_independent_approval, created_at | Nome/slug não dão acesso |
| `memberships` | tenant_id, user_id, role, status, scope, version | UNIQUE(tenant_id,user_id); preservar ao menos um owner ativo |
| `workspace_grants` | tenant_id, workspace_id, user_id | FK composta para workspace e membership do mesmo tenant |
| `invitations` | id, tenant_id, email_normalized, role, scope, token_hash, expires_at, accepted_at, revoked_at, invited_by | Um convite ativo por tenant/email; grants específicos persistidos em tabela filha |
| `workspaces` | tenant_id, id, name, color, archived_at, version | UNIQUE(tenant_id,id) |
| `channels` | tenant_id, workspace_id, id, platform, label, connection_status | Na fase inicial `not_connected`; FK composta para workspace |
| `posts` | tenant_id, workspace_id, id, title, caption, format, status, revision, approved_revision, scheduled_at, scheduled_timezone, author_id, updated_by, timestamps | UNIQUE(tenant_id,workspace_id,id); índices tenant/workspace/status/date |
| `post_revisions` | tenant_id, workspace_id, post_id, revision, actor_id, content_snapshot, created_at | Snapshot editorial, sem segredos; UNIQUE para a revisão |
| `post_channels` / `post_media` | tenant_id, workspace_id, post_id, target_id, position | FKs compostas obrigam o mesmo tenant e a mesma marca |
| `post_revision_media` | tenant_id, workspace_id, post_id, revision, media_id | FKs compostas para revisão e mídia; impede exclusão que quebraria histórico |
| `comments` | tenant_id, workspace_id, id, post_id, author_id, body, created_at | Autor resolvido pela sessão, nunca texto livre como identidade |
| `approvals` | tenant_id, workspace_id, id, post_id, revision, reviewer_id, decision, reason, created_at | Uma decisão não altera outra revisão; histórico não editável |
| `media` / `media_blobs` | tenant_id, workspace_id, id, original_name, normalized_mime, size_bytes, width, height, digest, created_by; bytes na tabela filha | PK/FK composta; bytes regravados e quota em bytes de saída |
| `plans` | id, version, label, limits_json, flags_json, active | Versão imutável; alteração cria nova versão |
| `tenant_entitlements` | tenant_id, plan_id, plan_version, source, starts_at, ends_at, version | Fonte explícita: manual_trial ou provider; sem status falso de pagamento |
| `billing_customers` | tenant_id, provider, provider_account_scope, customer_id | Mapeamento único; não confiar apenas em metadata do webhook |
| `subscriptions` | tenant_id, provider, subscription_id, customer_id, provider_status, period_end, cancel_at_period_end, reconciled_at | Estados do fornecedor separados da política de acesso |
| `billing_events` | provider, account_scope, event_id, object_id, event_type, received_at, body_digest, state, attempts, processed_at | UNIQUE(provider,account_scope,event_id); corpo mínimo protegido e com retenção |
| `jobs` | id, tenant_id nullable, type, dedupe_key, payload_ref, run_at, state, lease_until, attempts, last_error_code | Entrega pelo menos uma vez; handler idempotente; nenhum job social ativo |
| `audit_events` | id, tenant_id nullable, actor_id, action, target_type/id, outcome, safe_changes, request_id, created_at | Append-only pela aplicação; evento global só para operação da plataforma |
| `idempotency_keys` | tenant_id, actor_id, method, route, key, request_hash, result_ref, expires_at | Repetição igual não duplica; mesma chave com payload diferente = 409 |
| `platform_admins` | user_id, status, created_at | Separado de membership; mutação apenas pela operação autorizada |
| `schema_migrations` | version UNIQUE, checksum, applied_at | Checksum divergente ou banco mais novo impede startup |

As FKs compostas precisam de índices UNIQUE correspondentes no lado referenciado. Não permitir `NULL` em tenant/workspace de dados editoriais. Testar falhas de FK diretamente no banco, além das validações HTTP.

## C. Permissões

| Papel | Leitura | Escrita editorial | Revisão | Pessoas/configuração | Cobrança |
|---|---|---|---|---|---|
| Owner | Toda a organização | Sim | Sim, sujeita à política de revisão | Sim; transfere propriedade com reautenticação | Sim |
| Admin | Toda a organização | Sim | Sim, sujeita à política de revisão | Gerencia editor/reviewer/viewer; não promove owner/admin | Não no primeiro corte |
| Editor | Apenas marcas concedidas | Cria, edita, comenta, solicita revisão, planeja aprovado | Não aprova | Não | Não |
| Reviewer | Apenas marcas concedidas | Comenta; não muda a peça | Aprova ou pede alterações | Não | Não |
| Viewer | Apenas marcas concedidas | Não | Não | Não | Não |

Owner/admin têm escopo organizacional explícito. Demais papéis exigem grants de marca; falta de grant não significa acesso a todas. Para simplicidade, um papel por membership no primeiro corte. Papéis diferentes por marca são uma evolução posterior.

Somente owner promove outro owner/admin. Ninguém elimina/rebaixa o último owner, nem consegue fazê-lo com duas requisições simultâneas. Convites não concedem papel maior do que o permitido ao ator. Alterar grants/revogar membership passa a valer na requisição seguinte, inclusive para downloads.

O administrador da plataforma pode consultar organizações, contagens operacionais, eventos de falha e grants comerciais manuais. Não é um superusuário editorial e não lê posts/mídia de clientes por esse papel. Mudanças de estado/entitlement exigem motivo e autenticação recente; toda operação é auditada. Não há ação de apagar tenant nem personificação no primeiro corte.

## D. API HTTP

Prefixo `/api/v1`. Sucesso JSON: `{data,meta?}`. Erro: `{error:{code,message,fields?},requestId}`. Listas usam cursor opaco validado e `limit` máximo 100. Schemas rejeitam propriedades desconhecidas; respostas também usam allowlist. Não retornar hashes, tokens de autenticação/recuperação, secrets ou registros de outro tenant por serialização acidental. O token CSRF da própria sessão é a exceção explícita do bootstrap.

| Rotas | Contrato resumido |
|---|---|
| `GET /health/live`, `GET /health/ready` | Saúde mínima; sem detalhes de DB, configuração ou versões sensíveis |
| `GET /auth/session` | Cria pré-sessão quando preciso; retorna identidade sanitizada, CSRF e capacidades; `no-store` |
| `POST /auth/register` | Email e nome; cria pendente sem senha e mensagem no adaptador de email; resposta genérica; nenhum tenant antes da verificação |
| `POST /auth/email/verify`, `/auth/email/resend` | Verify recebe token e nova senha, estabelece conta verificada atomicamente; token não reutilizável; reenvio limitado; não cria sessão automaticamente |
| `POST /auth/login`, `/auth/logout`, `/auth/logout-all` | Login renova sessão; logout idempotente; logout-all revoga todas |
| `POST /auth/reauthenticate` | Confirma senha e atualiza `auth_at`; não altera permissões |
| `POST /auth/password/forgot`, `/auth/password/reset`, `/auth/password/change` | Respostas não enumeram contas; change exige senha atual; reset/change revogam sessões e tokens anteriores |
| `GET /me`, `GET /me/tenants` | Dados do próprio usuário e memberships ativas |
| `POST /tenants` | Usuário verificado cria organização e membership owner atomicamente; limite antiabuso do piloto |
| `GET/PATCH /tenants/:tid` | Contexto/configuração; alterações por owner/admin conforme allowlist |
| `GET /tenants/:tid/members` | Owner/admin; revisores não recebem lista completa de pessoas |
| `POST /tenants/:tid/invitations`, `GET /tenants/:tid/invitations` | Cria/lista convites autorizados; email via outbox; não revela token em listagem |
| `POST /tenants/:tid/invitations/:id/revoke`, `.../:id/resend` | Revoga/invalida token anterior; reenvio não reserva assento duplicado |
| `POST /invitations/accept` | Token + sessão verificada; email correspondente; uso único, quotas e grants transacionais |
| `PATCH /tenants/:tid/members/:uid`, `DELETE /tenants/:tid/members/:uid` | Atualiza papel/grants ou desativa associação, com proteção ao último owner |
| `GET/POST /tenants/:tid/workspaces`, `PATCH .../workspaces/:wid` | Marcas limitadas por plano e escopo; arquivamento explícito e reversível |
| `GET /tenants/:tid/workspaces/:wid/channels` | Alvos editoriais desconectados; não aceitar criação de OAuth fictício |
| `GET/POST /tenants/:tid/workspaces/:wid/posts` | Filtros por status/período/canal; draft criado com ator e revisão 1 |
| `GET/PATCH .../posts/:pid` | Conteúdo apenas; PATCH exige `expectedRevision`; sem escrever status arbitrariamente |
| `POST .../posts/:pid/transitions` | `{action,expectedRevision,reason?,scheduledAt?,scheduledTimezone?}`; política server-side |
| `POST .../posts/:pid/duplicate` | Nova peça draft, sem aprovação, sem envio; idempotência obrigatória |
| `GET .../posts/:pid/revisions`, `GET/POST .../posts/:pid/comments` | Histórico e comentários somente no escopo; autor real |
| `POST/GET /tenants/:tid/workspaces/:wid/media` | Upload multipart limitado; listagem de metadados sem bytes |
| `GET .../media/:mid/content`, `DELETE .../media/:mid` | Download autenticado; exclusão bloqueada se referenciada, inclusive por histórico retido |
| `GET /tenants/:tid/reports/editorial` | Somente marcas visíveis; origem `editorial-only`; nenhuma métrica social inventada |
| `GET /tenants/:tid/export/editorial` | Owner/admin; download sanitizado, auditado, sem auth/billing; limite explícito |
| `GET /plans`, `GET /tenants/:tid/entitlements` | Catálogo técnico e consumo real; não aceitar plano do navegador como autoridade |
| `POST /tenants/:tid/billing/checkout`, `/billing/portal` | Owner + reautenticação; 503 `BILLING_NOT_CONFIGURED` enquanto desabilitado; nunca URL falsa |
| `POST /webhooks/stripe` | Raw body, assinatura e limite próprios; sem sessão/CSRF; rota inexistente no runtime com billing desabilitado |
| `GET /admin/tenants`, `/admin/health-summary` | Somente plataforma; contagens operacionais sem conteúdo editorial |
| `POST /admin/tenants/:tid/entitlement-grants` | Grant manual com prazo/motivo e rótulo explícito; não marca fatura como paga |

Login/cadastro/reset usam limites de corpo menores; JSON comum até 64 KiB, upload 5 MiB mais overhead limitado. `401` sessão ausente/expirada, `403` CSRF/permissão, `404` objeto invisível, `409` revisão/quota/idempotência, `413` corpo excessivo, `422` validação semântica, `429` limite de abuso. Nunca retornar stacktrace ou query SQL.

Cada POST criador e transição comercial importante aceita `Idempotency-Key`; chave vinculada ao ator, tenant, rota e hash do corpo. A API responde à repetição autorizada com o mesmo resultado por 24 horas. Depois do prazo, o cliente deve consultar antes de repetir uma operação incerta.

Email é identificador case-insensitive neste produto: trim, domínio normalizado e comparação em caixa baixa; não remover pontos nem sufixos `+`. Cadastro existente não troca senha/nome nem verifica a conta. Hashing ocorre antes da transação de consumo do token; dentro dela, revalidar validade/estado e usar comparação atômica para apenas um vencedor.

## E. Fluxo editorial

Estados: `draft`, `in_review`, `changes_requested`, `approved`, `planned`, `archived`.

- Editor/owner/admin: draft ou changes_requested → in_review.
- Reviewer/owner/admin: in_review → approved ou changes_requested, vinculando a revisão atual.
- Editor/owner/admin: approved → planned, somente com aprovação válida para a revisão e data/fuso válidos.
- Alteração de conteúdo, mídia, canais ou data planejada invalida a aprovação e volta para draft. Nunca preservar aprovação de texto/imagem que mudou.
- Arquivar é reversível; restaurar volta a draft. Duplicar não copia aprovação nem intenção de publicação.
- Se `require_independent_approval=true`, autor da revisão não aprova essa revisão, inclusive owner/admin. O owner pode mudar a política com motivo auditado; a UI informa a configuração. Default do tenant: true.
- Campos: título até 180 caracteres, legenda até 10.000, 10 imagens, 20 tags e 6 alvos editoriais; validar vínculo e unicidade. Imagens de outra marca falham mesmo dentro do tenant.
- Datas precisam ter offset explícito e timezone IANA coerente. Rejeitar horários locais inexistentes; em horário ambíguo exigir escolha de offset. Armazenar instante UTC e intenção de fuso.

Futuro envio social usará `publication_targets`/`publication_attempts`, separado do estado editorial. Jobs guardarão IDs e revalidarão aprovação, vínculo, capacidade e credencial antes da execução. Somente confirmação do fornecedor com ID remoto poderá gerar estado publicado.

## F. Billing e webhooks sem dinheiro real

Interface `BillingProvider`: `createCheckout`, `createPortal`, `verifyWebhook(rawBody,headers)`, `fetchSubscription`, `fetchInvoice`, `normalizeEvent`. Default `DisabledBillingProvider`. O adapter fake só entra por injeção no processo de testes; nenhuma chave compartilhada ou botão de "pagamento simulado" habilita acesso pago.

Usar o SDK oficial para assinatura Stripe, incluindo sua geração de headers de teste. Não depender de conta real: os testes usam payloads sintéticos e segredo efêmero gerado no próprio teste. Isso comprova o verificador local, não integração live. [SDK Stripe](https://github.com/stripe/stripe-node).

Processamento proposto:

1. Ler bytes crus com limite de 256 KiB; rejeitar encoding/compressão inesperados. Verificar assinatura antes de interpretar/usar dados. Aplicar tolerância temporal explícita de 300 segundos e teste de relógio, sem tolerância zero. [Stripe: verificação](https://docs.stripe.com/events/manage-webhook-endpoints).
2. Validar modo test/live, conta de origem esperada, tipo permitido e schema da versão de API fixada. Resolver o tenant pelo customer/subscription já vinculados no servidor; metadata recebida não muda esse vínculo.
3. Inserir evento e job de reconciliação numa transação. Duplicata conhecida retorna 2xx sem duplicar efeitos; falha de persistência retorna erro para retry. Só confirmar recebimento depois da gravação durável.
4. Worker idempotente consulta o estado atual da assinatura/fatura, aplica o estado e recalcula entitlement. Serializar reconciliação por assinatura para impedir aplicação tardia de snapshot antigo. Lease expirada permite reexecução após crash.
5. Não ordenar eventos apenas por `created`; webhooks podem chegar fora de ordem e compartilhar timestamp. Não revogar/conceder serviço exclusivamente por um redirect de checkout ou por evento antigo isolado. [Stripe: entrega, ordem e duplicatas](https://docs.stripe.com/webhooks).
6. IDs desconhecidos entram em quarentena operacional; jamais provisionam outra organização. Estado `past_due`, `unpaid`, `canceled` ou trial exige política de acesso explícita, com read-only/grace configurados sem apagar dados. [Stripe: assinaturas](https://docs.stripe.com/billing/subscriptions/webhooks).

Retries com backoff/jitter, máximo operacional configurado, fila de falhas e reprocessamento auditado. A desativação do billing não altera dados editoriais existentes nem inventa receita. Qualquer criação de checkout real, envio de dados ao fornecedor, conta, secret ou assinatura depende da fase autorizada.

## G. Migrações, backup e segurança operacional

- `PRAGMA foreign_keys=ON`, WAL, `synchronous=FULL`, timeout limitado e SQL parametrizado; extensões de SQLite desabilitadas. Escrever dentro de transação curta, sem `await`/rede.
- Migrações versionadas e com checksum; executar em exclusão mútua antes de servir tráfego. Recusar versões desconhecidas e não executar reset silencioso.
- Novo banco e banco legado nunca compartilham pathname. Importação legado será entrega separada, com dry-run, validação de mídia e referências, remapeamento e commit atômico; não implementá-la reutilizando a substituição global.
- Backup operacional não é exportação de tenant. O primeiro contém hashes e dados de todas as organizações; somente operador, criptografia e retenção própria. Exportação do usuário exclui segredos/identidades e inclui apenas escopo autorizado.
- Middleware da UI: CSP sem inline/eval, frame-ancestors none, nosniff, referrer-policy, escape contextual e nenhum HTML de usuário. Cookies/autenticação e downloads privados não são armazenados em cache compartilhado.
- Trusted proxy apenas por origem/rede configurada; não confiar em `X-Forwarded-For/Host/Proto` de qualquer origem. Origem canônica de links vem da configuração, nunca do Host recebido. Sem CORS wildcard com credenciais.
- Logs redigem Authorization, cookies, senhas, tokens e URLs sensíveis. Tokens de convite/verificação/reset chegam por fragmento, são removidos da barra de URL antes do POST e não aparecem em analytics/referrer.
- Não salvar credenciais de serviço em código, `.env` distribuído, fixture, frontend ou chat. O piloto não precisa de nenhuma chave real.

## H. Critério de aceite global

Implementação só pode ser chamada de protótipo multiusuário funcional quando existir evidência de persistência após restart, dois tenants isolados, RBAC por marca, conta verificada no fluxo de desenvolvimento, sessão/CSRF reais, colaboração editorial, quotas transacionais, mídia decodificada, auditoria e billing offline testado. A matriz completa está em `docs/TEST-MATRIX.md`.

Nenhum endpoint planejado, documento de arquitetura, número de testes antigo ou tela estática serve como evidência de implementação. Testes que não rodarem devem ser declarados como não executados, especialmente navegador, Windows/macOS, email externo, PostgreSQL/RLS e Stripe sandbox/live.
