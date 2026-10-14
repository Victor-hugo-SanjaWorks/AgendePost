# AgendePost: implantação do piloto fechado em VPS Hostinger

Revisado em 14/10/2026. Este roteiro é para o programador responsável pelo **VPS Linux confirmado pelo usuário**, com systemd, um processo Node e disco persistente local. O domínio canônico é **https://agendepost.com.br**. Nenhum comando deste roteiro foi executado em um VPS, nenhuma conta foi alterada e nenhum certificado, DNS ou publicação Meta real foi validado nesta entrega.

## 1. Escopo e arquitetura

Este pacote habilita um **piloto hospedado por convite**, com operação acompanhada. Não certifica lançamento comercial público, disponibilidade contínua, alta disponibilidade, isolamento PostgreSQL/RLS, MFA, entrega real de email ou faturamento. Os requisitos de lançamento independente permanecem pendentes.

Fluxo: navegador → nginx no VPS (HTTPS, porta 443) → `127.0.0.1:4180` → um processo Node → SQLite e mídia privada em `/var/lib/agendepost`.

- Node **24.19.0 ou superior dentro da série 24**. A versão 25 não está no intervalo aprovado. Conferir o binário efetivamente usado pelo systemd.
- Um único processo de aplicação. O dispatcher de publicação é embutido, não um segundo serviço, e começa **desativado**. Não usar cluster, múltiplas réplicas, PM2 junto com systemd ou segunda instância apontando para o mesmo banco.
- SQLite em disco local persistente; nunca no diretório de uma release, diretório público, volume efêmero, NFS ou pasta sincronizada.
- O banco contém também `media_blobs`; o backup consistente do SQLite inclui essas imagens privadas. Arquivos de configuração, chaves e o código não fazem parte desse backup.
- Nginx deve estar no **mesmo host** da aplicação. CDN, proxy adicional, balanceador e containers com rede separada exigem nova análise de confiança e não estão cobertos.
- Só nginx escuta publicamente. O aplicativo permanece em loopback. Não abrir 4180 no firewall.

A Hostinger atualmente documenta Node.js tanto em hospedagem gerenciada quanto em VPS; esta escolha de VPS decorre da decisão do usuário e do controle necessário nesta arquitetura. A adequação de worker contínuo e armazenamento SQLite persistente em planos gerenciados não foi validada. Fontes oficiais consultadas: [opções Node.js da Hostinger](https://www.hostinger.com/support/node-js-hosting-options-at-hostinger/) e [implantação de aplicações Node.js](https://www.hostinger.com/support/how-to-deploy-a-nodejs-website-in-hostinger/). O segundo guia alerta que diretórios gerenciados de build são substituídos em novas implantações; não transplantar este layout de dados para um build descartável.

## 2. Pré-requisitos do operador

Antes de mudar o VPS, confirmar:

1. Distribuição Linux suportada, acesso administrativo autorizado, cópia de segurança do estado existente e se já há outro nginx/painel ocupando 80/443. **Não reinstalar o sistema nem sobrescrever um site existente para seguir este exemplo.**
2. Capacidade de disco e memória, orçamento, monitoramento e responsável de plantão. Não há benchmark de capacidade nem SLA deste piloto.
3. DNS de `agendepost.com.br` apontando para o VPS. Publicar AAAA somente se o IPv6 estiver configurado e protegido. `www` não está incluído neste contrato canônico.
4. Certificado TLS para `agendepost.com.br`, cadeia completa, chave privada, renovação e alerta de expiração. O operador obtém o certificado por seu fluxo autorizado, revisa os termos da autoridade certificadora e valida renovação. O template não cadastra conta ACME nem aceita termos automaticamente. Se usar HTTP-01, configurar o desafio durante o provisionamento/renovação; o template final redireciona HTTP e não contém webroot ACME.
5. Política de firewall revisada: 443 público; 80 apenas para redirecionamento/desafio quando aplicável; SSH restrito conforme política do operador. Não executar alterações de firewall sem a autorização devida ou sem proteger o próprio acesso.
6. Um canal seguro de entrega individual dos links de acesso, com verificação de identidade. O piloto não envia emails reais.

## 3. Diretórios e permissões

Layout sugerido:

- `/opt/agendepost/releases/IDENTIFICADOR/`: código de cada release, protegido contra escrita pelo usuário da aplicação
- `/opt/agendepost/current`: symlink controlado pelo operador para a release aprovada
- `/etc/agendepost/agendepost.env`: configuração de processo, fora do repositório
- `/etc/agendepost/`: configurações privadas Meta somente se futuramente autorizadas
- `/var/lib/agendepost/`: dados ativos, proprietário `agendepost`, modo `0700`
- `/var/backups/agendepost/`: snapshots privados locais, proprietário `agendepost`, modo `0700`
- `/var/lib/agendepost-restores/`: diretório privado para ensaios, proprietário `agendepost`, modo `0700`

Criar um usuário de serviço dedicado sem login interativo e sem privilégios administrativos, se ainda não existir. Exemplo a revisar pelo administrador, sem execução nesta entrega:

```sh
sudo useradd --system --user-group --home-dir /var/lib/agendepost --shell /usr/sbin/nologin agendepost
sudo install -d -o root -g agendepost -m 0750 /opt/agendepost/releases /etc/agendepost
sudo install -d -o agendepost -g agendepost -m 0700 /var/lib/agendepost /var/backups/agendepost /var/lib/agendepost-restores
```

Não repetir `useradd` se o usuário já existir. Não dar propriedade do código ao processo de aplicação. Arquivos privados Meta, quando autorizados, devem ser arquivos regulares sem symlink/hardlink, pertencentes a `agendepost`, modo `0600`, em diretório privado `0700` fora do código. Nunca colocá-los no Git, frontend, `public/`, zip entregue, conversa ou logs.

## 4. Preparar a release sem ativar publicação

O programador copia o pacote revisado para uma **nova** pasta de release. Não transportar `node_modules`, dados reais, `.env`, snapshots ou arquivos de credenciais entre ambientes. Instalar dependências pelo lockfile usando um usuário de implantação autorizado, executar testes e só então proteger o código contra escrita pela aplicação.

```sh
node --version
npm ci
npm run check
npm test
npm run test:e2e
# Após os testes, se desejado para a release final:
npm prune --omit=dev
```

Conferir o resultado dos testes; não prosseguir em falha. Dependências nativas devem ser instaladas na arquitetura Linux do VPS. O template usa `/usr/local/bin/node`: conferir `command -v node` e ajustar **ExecStart e exemplos abaixo** ao caminho real. Não presumir que uma instalação interativa via nvm estará acessível ao systemd.

Copiar `deploy/agendepost.env.example` para `/etc/agendepost/agendepost.env`, revisar e proteger (`root:agendepost`, `0640`, sem acesso público). Ele define:

```dotenv
NODE_ENV=production
SOCIAL_SAAS_DEPLOYMENT=hosted-pilot
SOCIAL_SAAS_HOST=127.0.0.1
SOCIAL_SAAS_PORT=4180
SOCIAL_SAAS_ORIGIN=https://agendepost.com.br
SOCIAL_SAAS_TRUST_PROXY=loopback
SOCIAL_SAAS_DATA_DIR=/var/lib/agendepost
SOCIAL_SAAS_META_ENABLED=false
SOCIAL_SAAS_META_OAUTH_ENABLED=false
SOCIAL_SAAS_PUBLISHING_WORKER=false
SOCIAL_SAAS_METRICS_ENABLED=false
SOCIAL_SAAS_WHATSAPP_ENABLED=false
```

O diretório de dados deve existir antes da primeira inicialização e ter modo `0700`. As configurações são carregadas explicitamente pelo systemd ou por `node --env-file=...`; `npm start` não carrega `.env` sozinho. Não reutilizar um banco local com `mail_outbox` pendente: no modo hospedado isso bloqueia startup, pois links antigos de desenvolvimento não são um canal seguro de entrega. Planejar migração com ensaio e revisão, sem apagar dados silenciosamente.

## 5. Nginx, TLS e limite exato de confiança

Revisar `deploy/nginx-agendepost.conf`, adaptar aos includes da distribuição e aos caminhos reais do certificado. É configuração para o contexto `http {}`, requer nginx 1.19.4+ e não deve conflitar com outro `default_server`. Os hosts desconhecidos são recusados; HTTP canônico redireciona para HTTPS canônico. **Não expor a aplicação enquanto TLS não funcionar.**

O proxy sobrescreve estes valores, sem repassar valores fornecidos pelo cliente:

- `Host`: `agendepost.com.br`
- `X-Forwarded-Proto`: `https`
- `X-Forwarded-Port`: `443`
- `X-Forwarded-For` e `X-Real-IP`: `$remote_addr`, a conexão vista pelo nginx
- `X-Forwarded-Host`, `Forwarded`, `X-Original-URL`, `X-Rewrite-URL`: removidos. A aplicação recusa `X-Forwarded-Host`; o host canônico já é enviado diretamente em `Host`.

Não usar `$proxy_add_x_forwarded_for`, `trustProxy=true`, `0.0.0.0/0`, `::/0` ou cadeias arbitrárias. A aplicação só confia no salto local. Não configurar `real_ip_header`/`set_real_ip_from` amplos no nginx. Se houver proxy/CDN na frente, `$remote_addr` deixará de ser o IP do cliente; este template precisa ser revisto, não apenas ter a confiança ampliada.

O log de acesso está desativado porque a URL pode conter códigos OAuth e links de convite. O log de erros é restrito a `crit`, mas ainda requer revisão de conteúdo, permissões, retenção e acesso. Não habilitar logs de corpo, cookies, tokens, query string ou cabeçalhos de autorização. Upload máximo no nginx é 6 MiB, com o limite mais estrito de mídia aplicado pela aplicação.

Validação **a executar pelo programador**:

```sh
sudo nginx -t
# Somente após a validação, com autorização e sem interromper outros sites:
sudo systemctl reload nginx
```

O ambiente desta entrega não possuía nginx; o teste de sintaxe real e o handshake TLS ainda não foram executados.

## 6. Serviço único e inicialização

Revisar e instalar `deploy/agendepost.service` em `/etc/systemd/system/agendepost.service`. O serviço usa usuário dedicado, código somente leitura, `UMask=0077`, reinício em falha e escrita apenas em `/var/lib/agendepost` além do temporário privado. Ele não cria agendamentos de backup nem ativa worker separado.

```sh
sudo systemd-analyze verify /etc/systemd/system/agendepost.service
sudo systemctl daemon-reload
sudo systemctl enable --now agendepost
sudo systemctl status agendepost --no-pager
sudo journalctl -u agendepost -n 100 --no-pager
```

Conferir que existe exatamente uma instância e o socket está em `127.0.0.1:4180`, nunca em `0.0.0.0:4180` ou `[::]:4180`. A unidade reserva até 180 segundos para desligamento gracioso; não matar processos com trabalho em voo para “acelerar” uma atualização.

Quando o worker tiver sido autorizado e configurado como esperado, `/health/ready` exige que **o worker desta instância** esteja ativo e tenha heartbeat recente; heartbeat de processo antigo não mascara a falha. A prontidão retorna 503 se o adapter ou worker esperado estiver indisponível. O servidor também verifica essa condição a cada 10 segundos e encerra com erro para permitir reinício pelo systemd. Monitorar o código `PUBLISHING_WATCHDOG_FAILED`, reinícios e limites de partida; falha repetida exige investigação, não liberação automática de jobs ambíguos. Com publicação deliberadamente desativada, a prontidão não exige um worker e um 200 não significa que publicações estejam habilitadas.

A validação da unidade deve ocorrer no VPS. `systemd-analyze verify` foi tentado no ambiente de testes, mas não completou porque o runtime systemd local não é gravável; isso não constitui validação da unidade instalada nem de reinício após reboot.

## 7. Acesso somente por convite

Cadastro público não é o processo de onboarding do piloto. O operador usa a CLI, verifica o destinatário por canal independente e entrega o link individualmente em canal privado. A CLI abre apenas o banco; não inicia HTTP nem worker. Usar os dados exatos do destinatário aprovado.

```sh
cd /opt/agendepost/current
sudo -u agendepost /usr/local/bin/node --env-file=/etc/agendepost/agendepost.env scripts/operator-access.mjs \
  --purpose enroll --email 'DESTINATARIO_VERIFICADO' --name 'NOME_VERIFICADO' --confirm-verified-recipient
```

O comando equivalente de pacote é `npm run operator:access -- ...`, desde que o mesmo ambiente seja carregado explicitamente. Para redefinição autorizada, usar `--purpose reset --email ...`; para convite existente, `--purpose invitation --email ... --invitation-id ...`. O link é sensível e impresso uma única vez; só seu hash é persistido. Não capturar a saída em logs, tickets, gravações de terminal ou chats coletivos. Se expirar/perder, emitir novo link após verificar novamente o destinatário; não buscar tokens no banco nem restaurar outbox de desenvolvimento. Consultar a documentação do operador entregue com o pacote para duração e invalidação dos links.

## 8. Smoke test de aceitação após implantação

Executar com conta sintética autorizada antes de convidar pessoas reais:

1. `https://agendepost.com.br/health/live` e `/health/ready` retornam 200. HTTP redireciona para HTTPS; hosts desconhecidos são recusados. Falha no app produz indisponibilidade, não arquivo de banco ou página de diretório.
2. Login e sessão usam cookie `__Host-ss_session` com `Secure`, `HttpOnly`, `SameSite` e path `/`. CSRF, origem canônica e limites por cliente continuam funcionando. Enviar headers encaminhados falsos do cliente não muda a origem nem o IP usado pela aplicação.
3. Cadastro público está fechado; link de operador funciona apenas para o destinatário/uso autorizado. Não há token em logs nem email real involuntário.
4. Dois tenants sintéticos: nenhum consegue ler posts, marcas ou mídia privada do outro. URL sem sessão não expõe o blob.
5. Reiniciar o serviço e confirmar que sessões válidas, dados e mídia persistem. Restaurar uma cópia é um fluxo separado que invalida sessões.
6. Meta OAuth, publicações reais e worker permanecem desativados. Prontidão deve refletir essa condição; nenhum teste real é autorizado por este roteiro.
7. Fazer o backup e ensaio de restauração abaixo; registrar resultado. Confirmar monitoramento, espaço em disco, política de logs e responsável por falhas.

Um 200 de health check não comprova capacidade de publicação, TLS completo, entrega de email, segurança de backup nem prontidão comercial.

## 9. Backup consistente, privado e ensaio de restauração

### Snapshot

Executar como o usuário proprietário, com destino novo em pasta `0700`. A aplicação pode continuar ativa: a API de backup SQLite produz uma cópia consistente, incluindo transações confirmadas e blobs. O arquivo de saída é normalizado para journal `DELETE`, verificado e protegido em `0600`; o banco ativo permanece em WAL.

```sh
cd /opt/agendepost/current
sudo -u agendepost /usr/local/bin/node --env-file=/etc/agendepost/agendepost.env scripts/backup.mjs \
  --output /var/backups/agendepost/snapshot-AAAA-MM-DD-HHMMSS.sqlite --confirm-sensitive-backup
```

**Nunca copiar o arquivo ativo com `cp`, `rsync`, ZIP ou upload avulso enquanto o banco estiver aberto.** Copiar só o `.sqlite` ignora WAL e pode perder transações. Um snapshot de disco do provedor também não substitui o ensaio de recuperação da aplicação. Não reutilizar nome existente; a ferramenta recusa sobrescrita.

O backup contém todos os tenants, hashes de senha, dados privados e possivelmente credenciais OAuth cifradas. Arquivos antigos podem conter links de desenvolvimento. Não servir, enviar por chat ou armazenar sem proteção.

### Ensaio offline, sem alterar o serviço ativo

O destino deve ser um diretório que **ainda não existe**, com pai privado `0700`, proprietário `agendepost`, fora do repositório. O arquivo de origem deve vir do comando de backup, sem arquivos `-wal`, `-shm` ou `-journal` adjacentes. A ferramenta recusa o nome de banco ativo `social-saas.sqlite`, symlinks, permissões abertas, destinos existentes e cópias dentro do código. Ela não consegue atestar como um arquivo arbitrário foi criado: `--confirm-consistent-snapshot` é a declaração explícita do operador de que não usou cópia quente.

```sh
cd /opt/agendepost/current
sudo -u agendepost /usr/local/bin/node --env-file=/etc/agendepost/agendepost.env scripts/restore-check.mjs \
  --source /var/backups/agendepost/snapshot-AAAA-MM-DD-HHMMSS.sqlite \
  --target-dir /var/lib/agendepost-restores/ensaio-AAAA-MM-DD-HHMMSS \
  --confirm-consistent-snapshot
```

Também disponível como `npm run restore:check -- ...` com ambiente explicitamente carregado. A ferramenta:

- verifica integridade e chaves estrangeiras, cria uma nova cópia consistente e valida fingerprints das migrações; aplica migrações pendentes somente nessa cópia;
- recusa banco de versão futura ou migração alterada e verifica que o snapshot de origem não mudou;
- invalida sessões, pré-sessões, tokens de autenticação, convites pendentes e estados/payloads OAuth; remove outbox e respostas de idempotência antigas;
- revoga **localmente** conexões OAuth e apaga seus payloads cifrados da cópia. Não revoga permissões na Meta nem toca a origem;
- coloca jobs de publicação pendentes/em voo em `needs_attention`, com `RESTORE_REVIEW_REQUIRED`, remove leases e marca tentativas em voo como ambíguas;
- congela jobs de cobrança pendentes como falhos e eventos pendentes como quarentena, sem consultar ou cobrar provedor;
- preserva conteúdo, blobs, histórico publicado e tentativas anteriores; registra auditoria de recuperação;
- grava `RESTORE-CHECK.json` e `DO-NOT-START.txt` privados, com contagens e hash SHA-256 da origem. Não cria app, socket HTTP, processo de worker nem chamada externa.

Falhas após criar o destino deixam `RESTORE-FAILED.txt`. Não iniciar essa cópia nem repetir o comando sobre ela; investigar e escolher novo destino. O `buildConfig` do perfil hospedado **recusa iniciar** se encontrar `DO-NOT-START.txt` ou `RESTORE-FAILED.txt` no diretório de dados. Cópias que falharam nunca são promovidas: não remover nem renomear `RESTORE-FAILED.txt` para contornar a proteção.

### Recuperação de desastre / promoção da cópia

O ensaio não promove a cópia, e não existe CLI de promoção automática. Para recuperar o serviço, o operador precisa interromper tráfego/mutações, parar a instância antiga, preservar seus arquivos e confirmar que não há segundo processo. Revisar independentemente `RESTORE-CHECK.json` (resultado `verified_offline_only`, integridade, migrações, hash, contagens) e perdas desde o snapshot. Reconciliar manualmente os jobs com os destinos e confirmar Meta/OAuth/worker desativados antes de liberar a cópia. Nunca mesclar bancos, copiar sobre dados ativos ou fazer downgrade cego de migrações.

**Somente após todas essas verificações e aprovação explícita do operador**, registrar a revisão renomeando o marcador de uma restauração bem-sucedida. Substituir o diretório abaixo pelo ensaio efetivamente revisado; não executar em cópia com falha:

```sh
sudo -u agendepost test -f /var/lib/agendepost-restores/ensaio-AAAA-MM-DD-HHMMSS/RESTORE-CHECK.json && \
sudo -u agendepost test ! -e /var/lib/agendepost-restores/ensaio-AAAA-MM-DD-HHMMSS/RESTORE-FAILED.txt && \
sudo -u agendepost test ! -e /var/lib/agendepost-restores/ensaio-AAAA-MM-DD-HHMMSS/RECOVERY-REVIEWED.txt && \
sudo -u agendepost mv -n -- \
  /var/lib/agendepost-restores/ensaio-AAAA-MM-DD-HHMMSS/DO-NOT-START.txt \
  /var/lib/agendepost-restores/ensaio-AAAA-MM-DD-HHMMSS/RECOVERY-REVIEWED.txt
```

Confirmar que `RECOVERY-REVIEWED.txt` existe e `DO-NOT-START.txt` não existe. O comando registra a decisão humana; não valida o conteúdo do relatório nem consulta provedores. Só então apontar `SOCIAL_SAAS_DATA_DIR` **e** `ReadWritePaths` da unidade para esse diretório, mantendo a instância antiga desligada e Meta/OAuth/worker desativados. Reexecutar a validação da unidade, recarregar systemd e fazer os smoke tests antes de reabrir tráfego.

Todos precisam entrar de novo. Reemitir acesso e convites por identidade verificada; novas conexões Meta exigem nova autorização. Antes de qualquer republicação, reconciliar manualmente **todos os jobs pendentes no snapshot** com as contas de destino: um job “agendado” no backup pode ter sido publicado depois dele. Conferir estado real, IDs remotos e horários, inclusive jobs em `needs_attention`; não reenfileirar em massa. Autorizações estáticas de Meta ficam fora do banco e não são revogadas pelo ensaio: mantê-las desativadas e revisar separadamente. A restauração não garante publicação exatamente uma vez.

### Responsabilidades ainda não implementadas/validadas

O operador define e testa: frequência (RPO), tempo de recuperação (RTO), retenção, criptografia dos snapshots em repouso e em trânsito, cópia off-host, controle/recuperação das chaves, alertas de falha e falta de disco, exclusão segura e ensaios periódicos. Guardar as chaves em local independente dos backups. Nenhuma rotina, cron, bucket, upload, política de retenção ou monitor foi criado por este pacote. Um backup somente no mesmo VPS não protege contra perda completa desse VPS.

Na versão 0.4, a recuperação também revoga links de dashboard/aprovação, remove challenges, desativa configurações de coleta e marca tentativas WhatsApp em voo como desconhecidas. Credenciais WhatsApp ficam fora do banco e devem permanecer desligadas na recuperação.

## 10. Atualização e rollback

Para esta release, seguir primeiro o roteiro específico [UPGRADE-0.4.md](UPGRADE-0.4.md). Não substituir configuração nem dados existentes pelos exemplos do pacote.

Preparar e testar uma nova release; executar backup consistente e ensaio; agendar a janela. Parar o serviço antes de trocar a release ativa e permitir migrações somente com backup validado. Após subir, executar smoke tests e observar logs. Nunca colocar código antigo sobre banco migrado sem verificar compatibilidade: o sistema recusa migrações futuras/desconhecidas. Se for necessário restaurar banco, usar novo diretório e o fluxo completo acima, aceitando invalidação de sessões e reconciliação da fila.

## 11. Liberação futura de Meta

Hospedagem não autoriza conexão de conta, criação de credenciais, publicação, exposição de mídia a terceiros ou aceitação de termos. OAuth, `SOCIAL_SAAS_META_ENABLED` e `SOCIAL_SAAS_PUBLISHING_WORKER` continuam `false` até autorização específica, revisão independente e teste real controlado. Ler `META-OAUTH.md`, `META-INTEGRATION.md` e `PUBLISHING-OPERATIONS.md` em conjunto com o contrato hospedado desta entrega. Documentos antigos que descrevem o piloto somente local não substituem este roteiro para o VPS; tampouco comprovam uma integração pública aprovada.

Para ativar futuramente: validar app/permissões e contas Meta, callback HTTPS canônico, segredo/chave privada, versão da API, disponibilidade externa da mídia aprovada por mecanismo autorizado, consentimento do conteúdo e destino, idempotência operacional e plano de reversão. O endpoint privado de mídia do aplicativo não deve ser tornado público para contornar esse requisito.
