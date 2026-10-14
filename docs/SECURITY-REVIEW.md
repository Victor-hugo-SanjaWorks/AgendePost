> Base histórica do piloto local 0.2, preservada para referência técnica. Para instalar o AgendePost 0.3 na VPS, use HOSTINGER-DEPLOY.md, HOSTED-OPERATIONS.md e META-SETUP-HOSTED.md. As antigas restrições operacionais de perfil local não descrevem o opt-in hospedado; os controles de isolamento e publicação permanecem válidos.

# Revisão independente de segurança

Data: 14/10/2026. Ambiente verificado: Linux, Node 24.19.0, aplicação local em loopback. Esta revisão examina a implementação e os testes; não certifica lançamento público ou integração com fornecedores externos.

## Resultado

Os bloqueios concretos encontrados nesta revisão foram corrigidos pelos responsáveis dos módulos e reavaliados de forma independente. Não permanece um bloqueio de segurança conhecido nas superfícies locais examinadas. A conclusão é limitada a **avaliação local controlada** e depende também do resultado da matriz funcional final em `QA-REPORT.md`.

O lançamento público/comercial continua bloqueado intencionalmente. `NODE_ENV=production` e endereços de escuta públicos são recusados. Não se deve remover esses controles para apresentar o piloto como produto pronto.

## Defeitos encontrados e correções verificadas

### SEC-01 — Consumo de marcas ocultas exposto a membros restritos

**Impacto:** violação do isolamento de metadados entre marcas, tratada como bloqueio da entrega local. Editor/reviewer/viewer podiam consultar contagens organizacionais de posts, marcas, membros/convites e bytes, mesmo sem acesso a essas marcas ou à lista de pessoas. Não foi encontrada leitura do texto ou dos bytes das marcas ocultas por esse caminho.

**Reprodução antes da correção:** usando cadastro, login, convite e aceite HTTP reais, um viewer recebeu grant para uma marca vazia. Um owner criou um post em outra marca. O relatório autorizado devolveu `totalPosts: 0` e uma marca; `/api/v1/tenants/:tid/entitlements` devolveu `usage: {workspaces: 2, members: 2, posts: 1, mediaBytes: 0}`. O serviço de quota também incluía a contagem organizacional em `QUOTA_EXCEEDED.fields.used`.

**Correção:** `src/commercial/index.mjs` permite consumo organizacional somente para owner/admin. Membros restritos recebem `usage: null`, `overLimit: []` e `usageScope: 'restricted'`, preservando as informações de acesso e os limites públicos do preset. `src/commercial/entitlements.mjs` não retorna mais `used` em erros de quota. A UI explica a restrição em vez de desenhar medidores ou acessar um objeto nulo.

**Reavaliação:** a mesma reprodução agora devolve `viewerUsage: null`, `viewerUsageScope: 'restricted'` e `viewerOverLimit: []`; o owner continua vendo as contagens reais. O novo teste de `tests/commercial-admin.test.mjs` cobre viewer, reviewer, editor e erro de quota causado por posts em marca oculta. Passou.

### SEC-02 — Backup temporariamente legível por outros usuários locais

**Impacto:** exposição operacional possível de todos os tenants, hashes e links sensíveis, caso o destino fosse uma pasta atravessável por outros usuários locais. O script antigo aguardava `backup()` e só depois executava `chmod(0600)`. A orientação para escolher pasta privada reduzia o risco, mas não o impedia tecnicamente.

**Reprodução antes da correção:** fixture SQLite descartável de 20 MB, umask `022`. Durante o backup, foi observado arquivo de destino com modo `0644`; a API terminou com esse modo até o `chmod` posterior. Um processo com acesso à pasta poderia abrir um descritor durante essa janela e mantê-lo depois da mudança de permissões.

**Correção:** `src/backup.mjs` reserva o arquivo com criação exclusiva, `O_NOFOLLOW` quando disponível e modo `0600` antes da primeira página. Exige pasta privada pertencente ao operador em Unix, recusa destino dentro do diretório estático, verifica identidade/permissões do arquivo e integridade/FKs. `scripts/backup.mjs` utiliza esse caminho único.

**Reavaliação:** `tests/foundation-migrations.test.mjs` observa `0600` nos callbacks de progresso, verifica o resultado e rejeita sobrescrita e destino público. Passou. As garantias de ACL do Windows não foram testadas; o código as deixa explicitamente sob responsabilidade operacional.

### SEC-03 — Configuração permitia banco dentro da raiz estática

**Impacto:** configuração insegura poderia expor o banco por HTTP sem sessão. O banco era criado antes de registrar os arquivos estáticos, e `dataDir` podia apontar para `public/` ou um alias. O diretório padrão era seguro; não era uma escolha controlável por um usuário da API.

**Evidência:** fluxo `buildConfig` → `openDatabase` → registro de `@fastify/static`, com falta de exclusão entre as duas raízes. Não foi colocado um banco com dados no diretório público para demonstrar a exposição.

**Correção:** `src/config.mjs` recusa a raiz pública e seus descendentes tanto lexicalmente quanto pelo caminho físico, resolvendo aliases e o ancestral existente de destinos ainda não criados. O backup também recusa destinos na raiz pública.

**Reavaliação:** regressões para caminho direto e alias por symlink retornam `PUBLIC_DATABASE_PATH_FORBIDDEN`. Os testes HTTP continuam negando arquivos de banco, código-fonte, pacote, outbox e travessia. Passaram.

## Controles efetivamente examinados

- Autenticação: senha definida somente após token de verificação; hash scrypt caro e fila limitada; digest de tokens de sessão; rotação no login; invalidação por logout-all, troca/reset de senha, estado de usuário e expiração ociosa/absoluta.
- CSRF e navegador: pré-sessão em cadastro/login, Origin exata, Host validado, Fetch Metadata, cookie HttpOnly/SameSite, ausência de CORS permissivo, CSP sem inline/eval, referrer-policy e respostas privadas sem cache compartilhado. Cabeçalhos de proxy não substituem a origem confiável.
- Autorização: membership ativa e grant de marca no servidor, 404 para objetos invisíveis, papéis editor/reviewer/viewer distintos, preservação do último owner, invalidação de convites ao mudar/revogar a autoridade do emissor e revalidação após processamento assíncrono de upload.
- Integridade editorial: chaves estrangeiras compostas entre tenant/marca/post/mídia, revisão esperada, aprovação independente da revisão exata, edição invalidando aprovação e proteção do histórico que referencia mídia.
- Mídia: nenhuma busca remota de URLs; JPEG/PNG/WebP decodificados e regravados, limite de tamanho/pixels/concorrência, remoção de metadados e conteúdo adicional, rejeição de SVG/animação, quota atômica de bytes normalizados e download autenticado com contexto atualizado.
- Dados e segredos: DTOs explícitos, token de verificação/reset/convite em fragmento removido pela UI, ausência de endpoint de outbox, logs sem corpo/URL/cookies e exportação editorial separada do backup operacional. A exportação omite identidades e tabelas de autenticação/cobrança; referências de mídia continuam privadas e não incluem bytes.
- Administração: privilégio da plataforma separado da associação editorial, somente metadados operacionais, concessões manuais com motivo/reautenticação/auditoria e sem impersonação ou acesso implícito a posts/mídia.
- Cobrança: checkout/portal retornam `503 BILLING_NOT_CONFIGURED`; webhook ausente no runtime padrão; adaptador offline somente por injeção em testes. Verificação Stripe usa bytes crus, assinatura e janela temporal; bindings do servidor prevalecem sobre metadata; ledger/job/auditoria são duráveis e atômicos; reconciliação, leases e retries não confiam na ordem dos eventos.
- Banco: FKs ativas, WAL, synchronous FULL, SQL parametrizado, migrações por checksum e falha fechada para versão desconhecida/alterada, rollback real e trilha append-only na aplicação.

## Evidências executadas pelo revisor

Não somar as linhas abaixo como testes únicos: alguns arquivos foram executados em mais de um conjunto.

| Comando/conjunto | Resultado |
|---|---|
| `node --test --test-concurrency=1 tests/security-auth.test.mjs tests/security-tenants-editorial.test.mjs tests/security-media.test.mjs tests/security-commercial.test.mjs tests/security-members-quotas.test.mjs` | 29 testes, 29 passaram, 0 falhas, 0 ignorados |
| `node --test tests/foundation-migrations.test.mjs` após os reparos | 7 testes, 7 passaram, incluindo backup durante progresso e caminhos públicos/aliases |
| `node --test tests/qa-http.test.mjs` após os reparos | 3 testes, 3 passaram, com listener TCP real e upload chunked/revogação antes do commit |
| `node --test --test-concurrency=1 tests/commercial-admin.test.mjs tests/commercial-core.test.mjs tests/security-commercial.test.mjs` após os reparos | 29 testes, 29 passaram, incluindo a regressão dos três papéis restritos |
| `node --test tests/qa-frontend.test.mjs` após os reparos | 3 testes DOM, 3 passaram, incluindo payloads XSS inertes, troca de tenant, logout/histórico e resposta atrasada de marca antiga |
| Reprodução HTTP independente de SEC-01 antes/depois | Vazamento reproduzido antes; consumo oculto ausente depois; consumo do owner preservado |
| Reprodução isolada do comportamento antigo de backup | Janela `0644` observada com umask `022`; fixtures descartadas |

## Limites e gates de lançamento

Estas são limitações declaradas do piloto, não defeitos ocultos que os testes locais teriam resolvido:

1. **Identidade e operação locais:** o outbox contém links de teste e depende do operador; não houve email externo, prova de entregabilidade ou MFA. Cookies HTTP de desenvolvimento e serviços no mesmo host local pressupõem um computador confiável. A avaliação não inclui malware local nem um operador malicioso com acesso ao disco.
2. **Armazenamento e recuperação:** SQLite e imagens no banco atendem ao corte local. Não há PostgreSQL/RLS, object storage de produção, backup criptografado automatizado, retenção implementada ou ensaio operacional cronometrado de desastre. Não distribuir banco, WAL, backups, outbox ou dados de teste junto com o código.
3. **Capacidade e retenção:** quotas contam posts/marcas ativos e bytes de mídia; não são um orçamento global de armazenamento para revisões, comentários, logs/auditoria e itens arquivados. Faltam carga, limites operacionais de disco, alertas, política de retenção e limpeza testada. Os limites de requisição/hash/imagem não equivalem a proteção validada contra abuso em exposição pública.
4. **Fornecedores e dinheiro real:** testes Stripe são criptográficos/offline com fixtures. Não validam uma conta sandbox/live, checkout, contrato, portal, credenciais ou faturamento real. Não houve OAuth ou publicação em rede social. `planned` permanece planejamento interno.
5. **Ambientes e navegador:** a revisão não executou Windows/macOS, ACLs nativas desses ambientes, TLS/proxy real, teste de carga ou revisão externa de infraestrutura. Testes DOM não equivalem a renderização/navegação em navegador real; o relatório geral de QA deve indicar separadamente essa evidência.
6. **Produto e obrigações:** políticas de privacidade, retenção/exclusão, termos, incidentes, suporte, preços e autorização de implantação continuam pendentes da fase pública. Esta revisão técnica não é parecer jurídico.

## Condição de uso desta conclusão

Válida para o código local revisado em 14/10/2026 e para o escopo descrito acima. Mudanças posteriores em autenticação, autorização, serializers, raízes de arquivo, exportação ou provider exigem nova avaliação dos testes afetados. A equipe deve rodar o conjunto agregado final depois de integrar todas as alterações paralelas; esta revisão não substitui esse resultado nem autoriza publicar o serviço.
