> Base histórica do piloto local 0.2, preservada para referência técnica. Para instalar o AgendePost 0.3 na VPS, use HOSTINGER-DEPLOY.md, HOSTED-OPERATIONS.md e META-SETUP-HOSTED.md. As antigas restrições operacionais de perfil local não descrevem o opt-in hospedado; os controles de isolamento e publicação permanecem válidos.

# Identidade e operação do piloto

Implementado em 14/10/2026. Uso controlado em loopback; não é autorização para exposição pública.

## Executar

Node 24.19.0, npm 11.9.0; versões exatas no package-lock.json.

```sh
npm ci
npm run check
npm test
npm start
```

Abrir `http://127.0.0.1:4180`. A origem canônica é validada, inclusive porta. O servidor ignora os cabeçalhos de proxy encaminhados; configuração padrão não aceita endereço de escuta público. `NODE_ENV=production` recusa startup.

`SOCIAL_SAAS_DATA_DIR` escolhe outra pasta privada. O nome do banco é sempre `social-saas.sqlite`. Caminhos do aplicativo local anterior são rejeitados. O projeto não importa nem migra o produto local automaticamente.

## Cadastro sem envio externo

1. Na UI, informar email e nome; nenhuma senha é aceita nesse passo.
2. O operador lê `npm run dev:mail -- --email pessoa@example.test --latest` em seu terminal privado.
3. Abrir o link de desenvolvimento e definir senha única de 15–128 caracteres.
4. Entrar com email e senha. Verificar email não cria sessão automaticamente.

O outbox é local e contém links de teste sensíveis. Não existe endpoint para ler esses links. Nenhum email é enviado para terceiros. Nunca distribuir a pasta data, backups ou a saída desse comando. Registro duplicado não substitui o nome nem uma senha existente.

Senhas usam scrypt assíncrono fixo: N=131072, r=8, p=1, salt de 16 bytes, derivação de 64 bytes, maxmem de 256 MiB. O processo executa no máximo dois hashes simultâneos e mantém oito na fila; excesso recebe 429. Hashes não reduzem custo silenciosamente. Senhas preservam Unicode e espaços, com teto adicional de 512 bytes.

## Sessões e permissões

Cookies HttpOnly, SameSite=Lax e Path=/; no HTTP local o nome deixa claro o modo de desenvolvimento. Configuração HTTPS usa prefixo __Host- e Secure, mas um proxy TLS real ainda não foi aprovado/testado para lançamento. Tokens de sessão de 256 bits são armazenados apenas como digest; CSRF é um segredo separado entregue pelo bootstrap. Expiração por 30 minutos ociosos e 12 horas absolutas. Logout, logout-all, troca/reset de senha e verificação de estado/epoch são persistentes.

Cada alteração requer origem canônica e X-CSRF-Token. Pré-sessões protegem cadastro e login. As permissões da associação e grants de marcas são lidas novamente, não retiradas de um cookie. Owner/admin têm escopo organizacional; editor/reviewer/viewer exigem grants explícitos. Convites reservam assento, expiram em 72 horas e só podem ser aceitos pela conta verificada de mesmo email. O último owner ativo não pode ser removido/rebaixado. Ações que promovem/gerem owner/admin exigem autenticação de até 10 minutos.

O trial técnico dura 14 dias. Depois da expiração, alterações e aumento de uso são bloqueados. Remover associação e revogar convite continuam permitidos como redução de acesso. Nenhum dado é apagado por expirar um trial.

## Administração local

```sh
npm run admin:grant -- --email CONTA_VERIFICADA --confirm-local-operator
```

Concede acesso a metadados operacionais, separado do conteúdo de qualquer organização. Não cria senha padrão nem permite leitura editorial por privilégio da plataforma. O operador precisa de acesso ao filesystem privado; o comando é auditado. MFA de administração permanece bloqueio do lançamento público.

## Backup

```sh
npm run backup -- --output /PASTA_PRIVADA/backup.sqlite --confirm-sensitive-backup
```

Use uma pasta dedicada privada do operador: em Unix, permissões 0700. Em Windows, configure acesso exclusivo pela conta do operador usando ACLs. O comando cria o arquivo com modo 0600 antes de gravar a primeira página, usa a API consistente de backup SQLite, verifica integridade/FKs, recusa sobrescrever arquivos e proíbe destinos dentro de public/. Contém todas as organizações, hashes e links do outbox; não é exportação de cliente. Criptografia, retenção, destino privado e restauração operacional cronometrada continuam responsabilidades não implementadas. Não copie o banco aberto ignorando WAL.

## Migrações e logs

Migrações numéricas são aplicadas em uma transação exclusiva com checksums. Alterações em migrações aplicadas, versões futuras ou falha SQL impedem startup sem reset. FKs, WAL e synchronous=FULL ficam ativos; extensões SQLite desabilitadas. O módulo `node:sqlite` é release candidate nesta versão de Node e síncrono: não é promessa de escalabilidade pública.

Logs HTTP não guardam corpos, senhas, cookies, tokens ou query strings. Erros enviados ao navegador são sanitizados; auditoria usa ator, alvo e mudanças mínimas. Auditoria é append-only na aplicação/SQLite, não imutável contra um operador com acesso ao disco.

## Dependências verificadas

- Fastify 5.12.7; inclui correção posterior ao advisory de 13/10/2026, que afetava versões menores que 5.12.6.
- Plugins oficiais compatíveis com Fastify 5: cookie 11.1.3, helmet 13.2.0, multipart 10.1.3, rate-limit 11.2.1 e static 10.1.6.
- Sharp 0.35.5, Stripe 23.0.0, AJV 8.20.0; jsdom 30.1.2 apenas para testes DOM.
- `npm audit --json` em 14/10/2026: zero vulnerabilidades reportadas. Isso não substitui revisão independente ou acompanhamento futuro.

Fontes: [Fastify security advisory](https://github.com/fastify/fastify/security/advisories/GHSA-389g-gv7q-r4x8), [Fastify validação](https://fastify.dev/docs/latest/Reference/Validation-and-Serialization/), [Node crypto 24.19](https://nodejs.org/download/release/v24.19.0/docs/api/crypto.html), [Node SQLite 24.19](https://nodejs.org/download/release/v24.19.0/docs/api/sqlite.html).

## Ainda não é produção

Não implementados/configurados: PostgreSQL/RLS, email externo, entregabilidade, domínio/TLS real, MFA, armazenamento de objetos privado, backup criptografado automatizado, carga/observabilidade/SLA, termos e privacidade revisados, suporte e cobrança live. Não há publicação social, OAuth de redes, inbox social nem métricas externas. `docs/QA-REPORT.md` separa testes executados de pendências.
