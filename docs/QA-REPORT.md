> Base histórica do piloto local 0.2, preservada para referência técnica. Para instalar o AgendePost 0.3 na VPS, use HOSTINGER-DEPLOY.md, HOSTED-OPERATIONS.md e META-SETUP-HOSTED.md. As antigas restrições operacionais de perfil local não descrevem o opt-in hospedado; os controles de isolamento e publicação permanecem válidos.

# Relatório de QA do piloto multiusuário

Data: 14/10/2026. Escopo: somente `social_saas`, executado localmente em Linux com Node.js **24.19.0** e npm **11.9.0**.

## Resultado

O piloto tem autenticação, persistência, isolamento, colaboração editorial e controles comerciais efetivamente exercitados. Continua sendo um **piloto local para avaliação controlada**, sem autorização ou preparação para lançamento público.

- `npm run check`: aprovado
- `npm test`: **79 testes/subtestes aprovados, zero falhas** no projeto
- Instalação limpa e repetição na extração independente: **aprovadas**; 121 pacotes reinstalados pelo lockfile, syntax check aprovado, suíte completa 79/79, TCP 3/3 e DOM 3/3
- `npm run test:http`: 3 testes reais de rede TCP aprovados no projeto
- `npm run test:e2e`: 3 fluxos de integração DOM com jsdom aprovados no projeto
- Navegador real e revisão visual responsiva: **não concluídos**, conforme a limitação abaixo

O número 79 é a contagem emitida pelo runner `node:test`, incluindo subtestes. Destes, 38 estão nos arquivos independentes `qa-*.test.mjs` e `security-*.test.mjs`. As demais verificações foram adicionadas pelos responsáveis dos módulos e executadas novamente em conjunto. Nenhuma das 84 verificações do aplicativo local anterior foi renomeada ou contada como evidência deste SaaS.

## Evidência executada

### Identidade e acesso

- Cadastro real via API e interface; normalização de email; duplicata não altera o cadastro existente; senha ausente no estado pendente; nenhum tenant criado antes da verificação.
- Proteção CSRF na pré-sessão, login e mutações; Origin malicioso/null, Fetch Metadata cross-site e token de outra sessão recusados.
- Verificação concorrente de token tem um único vencedor. Recuperação diferencia finalidade, não enumera contas, não autentica automaticamente e invalida sessões anteriores.
- Scrypt real com salt aleatório, envelope versionado, N=131072/r=8/p=1 e memória máxima configurada em 256 MiB; fila limitada e comparação de hash malformado. Não foi feito benchmark de capacidade.
- Rotação no login, logout-all, bloqueio de usuário, expiração por inatividade e limite absoluto de sessão.
- Três organizações, múltiplas marcas e sessões reais de owner, admin, editor, reviewer, viewer e operador de plataforma. Um usuário tem papéis diferentes em duas organizações.
- Leitura/mutação fora de tenant ou marca recusada; mídia privada não vira URL pública; revogação de grant/membership vale na solicitação seguinte.
- Remoção simultânea entre owners preserva um owner ativo. Admin não convida nem promove owner/admin. Convites exigem conta correspondente, expiram, reservam assento, invalidam token anterior ao reenviar e têm consumo único.
- Operador de plataforma vê metadados operacionais, sem ganhar leitura editorial. Papéis restritos não recebem consumo agregado de marcas ocultas.

### Trabalho editorial e mídia

- Criação, edição, duplicação, arquivamento/restauração, comentários autenticados e histórico persistido.
- Edições simultâneas: uma vence; a outra recebe conflito sem sobrescrever o conteúdo. Aprovação vale para a revisão exata, não pode ser feita pelo autor quando a política independente está ativa e é invalidada por edição.
- Fluxo real editor → pedido de ajustes → nova versão → aprovação por reviewer → data planejada. O estado continua sendo planejamento; não há publicação social.
- Referências cruzadas de mídia/canal recusadas tanto por HTTP quanto por FKs compostas no SQLite.
- JPEG, PNG e WebP decodificados e regravados por sharp; EXIF/metadados e conteúdo anexado removidos. SVG/HTML, MIME falso, truncamento, animação, mais de 5 MiB, mais de 25 MP e dimensão superior a 10.000 px recusados.
- Quota usa bytes normalizados. Uploads concorrentes no último espaço disponível têm um único vencedor; falhas não deixam mídia ou blobs órfãos.
- Upload real por TCP sem Content-Length: limite total inclui preâmbulo multipart; revogação durante upload ainda incompleto impede o commit dos bytes.
- Download autenticado com cache privado/no-store e nosniff; remoção de mídia referenciada por versão histórica é bloqueada.
- Datas com offset explícito e fuso IANA; São Paulo, virada de dia, datas impossíveis, gaps de DST e duas escolhas válidas para horário ambíguo.

### Cobrança e operação

- Presets técnicos imutáveis, trial/concessão manual identificados como tais, quota transacional e idempotência por ator/tenant/rota/corpo. Downgrade preserva leitura/exportação e não apaga dados.
- Checkout/portal desativados retornam erro explícito; webhook não existe no runtime padrão; não há pagamento ou URL de checkout fabricado.
- Assinaturas Stripe verificadas com SDK oficial, segredo efêmero e fixtures locais: bytes crus, corpo alterado, segredo errado, timestamp antigo/futuro, modo live indevido, conta/API schema incorretos e compressão inesperada.
- Ledger e job persistidos atomicamente antes de confirmar recebimento; replay e duplicata concorrente não duplicam efeitos.
- Customer/subscription desconhecidos entram em quarentena; metadata não move o cliente de uma organização para outra.
- Eventos fora de ordem reconciliam o estado atual do adaptador offline; cancelamento não é desfeito por snapshot antigo. Retry limitado, falha visível, lease expirada e retomada após crash exercitados.
- Concessão manual exige privilégio de plataforma, autenticação recente, prazo/motivo e auditoria. Auditoria evita senha, token e conteúdo editorial completo e não é editável pela aplicação.

### Persistência, protocolo e frontend

- SQLite real com FKs, WAL e synchronous=FULL. Migração vazia/reaplicação, checksum alterado, versão futura e falha intermediária testados sem reset silencioso.
- Reinício mantém sessão válida, identidades, permissões, posts, histórico e bytes normalizados. Backup consistente restaurado em outra pasta, com comparação de contagens e mídia.
- Backup operacional criado com proteção de permissões desde o primeiro byte; diretório público e sobreposição de arquivo recusados. Banco configurado dentro de assets públicos, inclusive por alias/symlink, é recusado.
- Servidor TCP preso a loopback; Host incorreto e proxy spoofing recusados/ignorados; parsing inválido e corpo excessivo retornam erro controlado. Código-fonte, banco e outbox não são servidos como assets.
- CSP sem unsafe-inline/unsafe-eval, frame-ancestors none, nosniff e referrer-policy verificados por HTTP. Cookies dev e configuração de cookies HTTPS conferidos; isso não equivale a um teste de TLS real.
- Produção, bind público e injeção de adapters de teste fora de modo test falham ao iniciar.
- jsdom executa os arquivos HTML/JS reais contra a aplicação real, com cookies separados e APIs verdadeiras. Os fluxos cobrem verificação por fragmento, login, onboarding vazio, marcas, edição/revisão, comentários, planejamento, XSS inerte, clique repetido, conflito preservando texto, cancelamento, troca de tenant, revogação, logout, histórico e reload.

## Defeito encontrado e corrigido

**QA-UI-001 — resposta atrasada contaminava a organização ativa.** Uma listagem de posts da organização A, recebida depois de alternar para B, sobrescrevia o estado compartilhado da busca. Digitar na busca de B podia mostrar posts antigos de A. A autorização do servidor continuava válida, mas o contexto exibido estava errado.

Correção: aplicação de respostas condicionada ao contexto/generation capturado; atualização de tenant/marcas atômica após as respostas; proteção de paginação, filtro e navegação após salvar. O teste `delayed old-brand list response cannot contaminate the active tenant` reproduziu a falha antes da correção e passou depois.

## Limitações e gates ainda abertos

- Chromium foi tentado com configuração padrão de sandbox e diretório de perfil gravável, mas abortou ao criar um socket no ambiente. **Não foi usado `--no-sandbox` nem equivalente.** jsdom não renderiza layout como um navegador e não certifica CSP/XSS no motor do navegador, teclado real, screenshots, mobile ou acessibilidade visual.
- Windows/macOS e o launcher Windows não foram executados neste ambiente Linux.
- Nenhum SMTP, Meta, OAuth social, Stripe sandbox ou Stripe live foi usado. Email é outbox de desenvolvimento, não entregabilidade externa. Fixtures de assinatura não certificam integração financeira live.
- PostgreSQL/RLS, TLS/proxy de produção, MFA, armazenamento/backup criptografado operado, retenção, carga/capacidade, recuperação de desastre e revisão jurídica/LGPD continuam fora desta evidência.
- A suíte não substitui revisão independente de segurança para lançamento público nem prova exaustiva de todos os cenários da matriz planejada.

## Reprodutibilidade

As dependências de runtime e jsdom estão fixadas no `package.json` e no lockfile. Testes não importam código ou instalações do aplicativo legado. Os scripts previstos são `npm ci`, `npm run check`, `npm test`, `npm run test:http` e `npm run test:e2e`.

A rodada limpa terminou em 14/10/2026, aproximadamente 06:05 UTC. Foram comparados 57 arquivos de código/configuração/assets entre a extração testada e a árvore de entrega: nenhum conteúdo divergente. A instalação usou o cache npm dedicado com `npm ci --offline`; não depende de node_modules reaproveitado ou de outro projeto.

Fingerprint desta rodada:

- `public/app.js`: `3dc7ac445d2a1c81a85748a34bf8b342a6217e1b165a842ccd0c5e269451419b`
- `package-lock.json`: `c873a65912e96d560cd1140cf716a0e22bb0b6dc6b280f74fc779353b2664968`

O pacote distribuído deve excluir banco, outbox, credenciais, logs de execução, cache e node_modules. O manifesto do pacote deve ser conferido contra a árvore de código testada antes da entrega.
