> Base histórica do piloto local 0.2, preservada para referência técnica. Para instalar o AgendePost 0.3 na VPS, use HOSTINGER-DEPLOY.md, HOSTED-OPERATIONS.md e META-SETUP-HOSTED.md. As antigas restrições operacionais de perfil local não descrevem o opt-in hospedado; os controles de isolamento e publicação permanecem válidos.

# Social Studio: arquitetura para um produto comercial

**Estado: plano de implementação, 14/10/2026. Nenhum SaaS foi implementado ou publicado nesta pasta.**

Social Studio é apenas o nome de trabalho. A marca final, os preços e a contratação de serviços continuam em aberto. Este projeto será independente de `social_studio` e `social_studio_bootstrap`; nenhum dos dois deve ser alterado para iniciar o SaaS.

## 1. Decisão e resultado esperado

Construir primeiro um **protótipo multiusuário funcional**, com backend, banco persistente, login, organizações isoladas, permissões, aprovação editorial, mídia privada, planos com limites reais e administração. Reaproveitar a experiência visual e os fluxos editoriais do aplicativo local, sem herdar sua ausência de autenticação nem seu armazenamento global.

Esse protótipo comprova o produto e sua fundação comercial. Não equivale a um serviço público pronto para cobrar, nem a uma integração funcional com redes sociais. A implementação começa após a liberação da frente prioritária Sanja V3. Não há compromisso de entrega do SaaS completo às 9h; a entrega local anterior é um marco separado.

### Stack escolhida

| Camada | Decisão para o protótipo | Motivo |
|---|---|---|
| Runtime | Node.js 24 LTS, ESM; versão exata fixada e testada | Continuidade com o aplicativo existente; runtime disponível: 24.19.0 |
| HTTP | Fastify 5, JSON Schema fechado e serialização explícita | Evitar reconstruir todo o tratamento HTTP; rotas testáveis por injeção e por rede real |
| UI | HTML, CSS e JavaScript modular, sem framework de frontend obrigatório | Reaproveitar calendário/compositor/biblioteca; investir primeiro nas garantias do backend |
| Persistência | SQLite normalizado, via `node:sqlite`, uma instância e disco local | Ambiente não apresentou `psql`/`postgres`; piloto reproduzível sem contratar infraestrutura |
| Autenticação | Senhas com `node:crypto.scrypt` assíncrono; sessões opacas no banco | Revogação imediata e nenhuma credencial de sessão em localStorage |
| Upload | `@fastify/multipart` e `sharp`, formatos raster restritos | Limites de streaming, decodificação real e regravação dos pixels |
| HTTP auxiliar | `@fastify/cookie`, `@fastify/helmet`, `@fastify/rate-limit` e `@fastify/static` | Cookies, cabeçalhos, contenção de abuso e arquivos públicos explicitamente separados |
| Cobrança | Interface própria; SDK oficial `stripe` para testes locais de assinatura | Testar o contrato sem conta, chave real, compra ou dependência de rede |
| Testes | `node:test` + Fastify inject + HTTP real; Playwright para navegador | Cobrir regras, persistência, segurança e experiência renderizada separadamente |

Fastify recomenda schemas para validar e serializar; estes serão código versionado, nunca fornecidos pelo cliente. Seus plugins precisam ter compatibilidade confirmada com Fastify 5. Fixar versões exatas em lockfile e conferir licença, avisos de segurança e instalação limpa antes de implementar. Não instalar nem atualizar o projeto local existente. [Fastify: schemas](https://fastify.dev/docs/latest/Reference/Validation-and-Serialization/), [compatibilidade de cookies](https://github.com/fastify/fastify-cookie).

`node:sqlite` 24.19.0 ainda é **release candidate**, e `DatabaseSync` é síncrono. Aceitar isso no piloto, com consultas pequenas e indexadas, limites de resultado e transações curtas. Não apresentar o módulo como API estável nem executar decodificação, hashing, envio de email ou chamadas externas dentro de transações. [Node 24.19: SQLite](https://nodejs.org/download/release/v24.19.0/docs/api/sqlite.html).

## 2. Limite do piloto e caminho para produção

O piloto nasce ligado apenas a `127.0.0.1`, sem túnel, publicação ou acesso ao computador do usuário. Pode ter diversas identidades e contextos de navegador, com isolamento testado, mas não é autorizado a receber clientes pela internet.

SQLite permite leitores concorrentes, mas apenas um escritor por vez; WAL exige que os processos estejam na mesma máquina. Portanto: uma instância, disco persistente local, sem filesystem de rede, serverless efêmero ou múltiplas réplicas. [SQLite: escolha do banco](https://sqlite.org/whentouse.html), [WAL](https://sqlite.org/wal.html).

**Decisão de lançamento:** usar PostgreSQL antes de oferecer o serviço público pago. É uma escolha de risco/operabilidade deste produto, não uma alegação de que SQLite nunca pode atender produção. A migração terá schema, testes e execução próprios. Não prometer troca automática do driver.

No PostgreSQL, adicionar RLS como defesa complementar, mantendo filtros de tenant e autorização no aplicativo. A role da aplicação não será proprietária das tabelas, superuser ou `BYPASSRLS`. Usar `FORCE ROW LEVEL SECURITY`, contexto de tenant por transação e testes com a role real; contexto ausente deve negar acesso. [PostgreSQL: RLS](https://www.postgresql.org/docs/current/ddl-rowsecurity.html).

Produção também exige HTTPS, domínio, email transacional, mídia privada em armazenamento adequado, backups operados, observabilidade e controles listados adiante. O modo production deve falhar ao iniciar se estiver com SQLite-piloto, email de desenvolvimento ou configuração insegura.

## 3. Arquitetura e fronteiras

Um monólito modular inicialmente: HTTP → identidade → contexto de tenant → autorização → serviço → repositório. Módulos propostos: `auth`, `tenants`, `workspaces`, `editorial`, `media`, `entitlements`, `billing`, `audit`, `admin` e `mail`.

Separar duas hierarquias:

- **Tenant / organização:** agência ou empresa contratante; unidade de assinatura, membros, dados e auditoria.
- **Workspace / marca:** cliente ou marca administrada pela organização. Um revisor de uma marca não ganha acesso às demais.

Toda requisição autenticada resolve a sessão, o usuário ativo e a associação ativa ao tenant no servidor. O tenant da URL é somente um candidato a validar. IDs imprevisíveis, campos escondidos ou o seletor visual não são controles de acesso.

Todas as tabelas de negócio carregam `tenant_id`; dados de marcas carregam também `workspace_id`. Repositórios exigem contexto obrigatório e consultas com esses filtros. Chaves estrangeiras compostas impedem relações entre marcas/tenants. Leituras, contagens, relatórios, downloads, exportações e tarefas passam pelas mesmas regras. [OWASP: autorização](https://cheatsheetseries.owasp.org/cheatsheets/Authorization_Cheat_Sheet.html).

Não reutilizar o `/api/state` global nem o importador que substitui todo o banco. Uma futura importação do aplicativo local será explícita, validada, com IDs remapeados, dentro de um tenant de destino, sem importar identidades, privilégios ou estados de conexão.

## 4. Autenticação, convites e administração

- Hash de senha: scrypt `N=131072`, `r=8`, `p=1`, salt aleatório de 16 bytes, saída de 64 bytes e `maxmem=256 MiB`; envelope versionado no banco. Benchmark no ambiente-alvo; máximo inicial de dois hashes simultâneos e fila limitada. Sem redução silenciosa do custo. É uma opção suportada quando não se adota Argon2id; não é uma afirmação de superioridade. [OWASP: senhas](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html), [Node: crypto](https://nodejs.org/download/release/v24.19.0/docs/api/crypto.html).
- Senhas de 15 a 128 caracteres, espaços e Unicode permitidos, sem truncar nem normalizar silenciosamente; limite adicional de bytes e lista local de senhas comuns. Erros genéricos e hash de custo equivalente para usuário inexistente. Rate limit por IP e identificador normalizado, com cooldown limitado, sem bloqueio permanente provocado por terceiros. [OWASP: autenticação](https://cheatsheetseries.owasp.org/cheatsheets/Authentication_Cheat_Sheet.html).
- Identificador de sessão aleatório de 256 bits; persistir apenas seu digest e metadados. Em HTTPS, cookie `__Host-ss_session`, `Secure`, `HttpOnly`, `SameSite=Lax`, `Path=/`, sem `Domain`. No loopback, cookie diferente e explicitamente de desenvolvimento. Expiração sugerida: 30 minutos de inatividade e 12 horas absolutas. Renovar identificador no login; revogar no logout, reset de senha e bloqueio. Não guardar roles como autoridade no cookie. [OWASP: sessões](https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html).
- CSRF sincronizador por sessão/pré-sessão: token aleatório separado, persistido associado à sessão no servidor, devolvido somente no bootstrap da própria sessão e enviado em cabeçalho em toda mutação do navegador, inclusive login e logout. O token CSRF sozinho nunca autentica. Validar Origin/Host e Fetch Metadata; SameSite é defesa adicional. Webhook assinado é a única exceção específica à exigência de CSRF. [OWASP: CSRF](https://cheatsheetseries.owasp.org/cheatsheets/Cross-Site_Request_Forgery_Prevention_Cheat_Sheet.html).
- Convites: token de 256 bits, digest no banco, expiração de 72 horas, uso único, email e escopo fixos. Aceite exige login e email verificado correspondente; somente o fluxo de convite não verifica um email. Revogação, reenvio com invalidação do anterior e aceite simultâneo devem ser seguros.
- Verificação de email e recuperação de senha: tokens separados por finalidade, únicos, expirantes, sem revelar existência de conta. No cadastro, pedir inicialmente email/nome; definir a senha somente ao completar o link de verificação. Assim, alguém não consegue preparar uma senha para o email de outra pessoa e esperar que ela apenas confirme o endereço. Reset revoga sessões e outros tokens de recuperação; não faz login automático. [OWASP: recuperação](https://cheatsheetseries.owasp.org/cheatsheets/Forgot_Password_Cheat_Sheet.html).
- No piloto, emails entram em um **outbox de desenvolvimento**, acessível apenas ao operador pelo terminal, com permissões restritas e identificado como não enviado. Ele contém links de teste; não deve ser incluído em logs, exports ou pacote distribuído. Não há endpoint HTTP público para lê-lo nem envio externo. Testes podem consumir os tokens do adaptador fake. O produto público exige entregabilidade e verificação reais; nenhuma mensagem de sucesso pode afirmar envio quando só houve gravação local.
- Administrador da plataforma é um privilégio separado, nunca atribuível por cadastro, convite ou edição de perfil. Criá-lo por comando administrativo local, sem senha padrão. Painel recebe somente dados operacionais necessários; não ganha leitura automática do conteúdo editorial. Sem personificação de clientes. MFA para administradores é um bloqueio de lançamento público.

## 5. Produto e monetização honestos

O primeiro corte comercial é organização editorial colaborativa: várias marcas, calendário, aprovação, comentários internos, histórico, imagens e limites por plano. Cada ação visível deve executar trabalho real ou explicar objetivamente o requisito pendente.

Os planos são dados versionados no servidor. Para exercitar testes, usar apenas presets técnicos, sem preço público: `pilot_base` (2 marcas, 3 membros, 100 posts não arquivados, 20 MiB) e `pilot_team` (10 marcas, 10 membros, 1.000 posts não arquivados, 100 MiB). Esses números não são proposta comercial nem capacidade comprovada. Assentos incluem convites válidos ainda não aceitos. Limites são verificados atomicamente junto com a gravação; o frontend só informa o resultado.

Downgrade nunca apaga dados: organizações acima do limite mantêm leitura e exportação autorizada, mas não podem aumentar o recurso excedido. Cancelamento, inadimplência e suspensão têm estados próprios, sem misturar cobrança com exclusão. Trial/grant manual deve aparecer como tal; nunca como pagamento confirmado.

Implementar interface `BillingProvider`, ledger de eventos e testes offline. A página de planos e o painel podem funcionar com cobrança desabilitada. Abrir checkout/portal real, configurar assinatura, registrar conta de pagamento e ativar chaves são etapas futuras. Nenhum cartão passa pelo aplicativo. Valores, moeda, tributos, renovação, cancelamento e suporte precisam ser definidos antes de ativar vendas.

A página comercial será original, usando a marca provisória apenas no desenvolvimento. Deve dizer que o protótipo oferece planejamento e colaboração; não anunciar publicação automática, inbox social, IA, métricas ao vivo, integrações ou SLA inexistentes. Sem depoimentos, logotipos de clientes ou números de receita inventados.

## 6. Mídia, auditoria e operação

Aceitar inicialmente imagens JPEG, PNG e WebP estáticas, até 5 MiB por entrada, 25 megapixels e 10.000 pixels por dimensão. Streaming com limite total/partes; checar formato real, decodificar e regravar, remover metadados, recusar animações e conteúdo vetorial/HTML. Limitar também tamanho de saída e concorrência. A aplicação não busca URLs fornecidas pelo usuário. [OWASP: uploads](https://cheatsheetseries.owasp.org/cheatsheets/File_Upload_Cheat_Sheet.html), [Sharp: limites](https://sharp.pixelplumbing.com/api-constructor/), [Sharp: saída](https://sharp.pixelplumbing.com/api-output/).

No piloto, bytes normalizados em tabela separada com FK composta, fora da pasta pública. Essa escolha simplifica atomicidade, quota e backup; não é promessa de armazenamento ilimitado. Download passa por sessão, tenant e marca, com MIME fixo e cache privado. Publicar em rede social futuramente exigirá outro fluxo de entrega privada/autorizada; não tornar toda a biblioteca pública.

Auditoria registra ator, ação, tenant, alvo, resultado, request ID, horário UTC e mudança mínima relevante. Nunca registra senha, cookie, token, chave, bytes de mídia ou corpo editorial completo. A trilha é somente anexada pela aplicação; não é imutável contra o administrador do banco. Mudanças críticas e seus eventos são uma única transação.

Migrações numeradas com checksum, aplicadas uma vez, versionamento explícito e recusa de banco mais novo. Backup consistente, teste real de restauração e plano de rollback por restauração/forward-fix; não copiar um `.sqlite` aberto ignorando WAL. [SQLite: backup](https://sqlite.org/backup.html).

## 7. Fases e definição de pronto

| Fase | Entrega | Saída obrigatória |
|---|---|---|
| 0. Contrato | Estes documentos; nenhuma implementação | Fronteiras, escopo, schema, API e testes claros |
| 1. Fundação | Projeto separado, migrations, auth, tenants, roles, convites, auditoria | Testes de isolamento, sessão, recuperação e concorrência aprovados |
| 2. Editorial | UI conectada ao backend, marcas, posts/revisões/aprovação, mídia | Fluxos reais em dois tenants e usuários com permissões diferentes |
| 3. Comercial demonstrável | Planos, quotas, admin, página comercial, adapter de billing e webhooks offline | Zero falsa cobrança/conexão; testes de assinatura, replay e idempotência |
| 4. Preparação pública | PostgreSQL/RLS, TLS, email real, armazenamento, MFA, operação e revisão | Gates de produção satisfeitos e deploy expressamente autorizado |
| 5. Integrações reais | OAuth/revisão por plataforma, fila de publicação e métricas verificadas | Autorizações e testes reais por formato/plataforma; sem estimativa de aprovação garantida |

### Gates antes do primeiro cliente público/pago

1. Revisão independente de autenticação, autorização, tenant/marca, mídia e billing; matriz automatizada completa e navegador real. As 84 verificações do app local não certificam este projeto novo.
2. PostgreSQL/RLS e migração ensaiada; backup criptografado, restauração cronometrada, responsáveis, retenção e objetivos RPO/RTO definidos.
3. Infraestrutura e domínio aprovados; HTTPS, proxy confiável configurado, banco privado, secrets fora do repositório, logs redigidos, alertas de falhas/limites e atualização de dependências.
4. Email de verificação/recuperação testado, MFA para plataforma/administração, resposta a incidentes e gestão de acesso operacional.
5. Revisão jurídica e operacional de privacidade/LGPD, contratos/termos, exclusão/exportação, fornecedores, retenção, suporte e cancelamento. Este plano não é parecer jurídico.
6. Produtos, preço/moeda, termos de cobrança e fornecedor aprovados; sandbox real e reconciliação de webhooks testados antes de qualquer modo live.
7. Marca e domínio verificados, claims comerciais revisadas e testes de carga com orçamento/capacidade medidos; sem promessa de escala baseada apenas no framework.

Até esses gates, a descrição correta será: **protótipo SaaS multiusuário para avaliação controlada**, quando implementado e testado. Neste momento existe somente o plano. Ver o [contrato técnico](../CONTRACT.md) e a [matriz de aceitação](TEST-MATRIX.md).
