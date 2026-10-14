# Operação do piloto hospedado

Leia primeiro `HOSTINGER-DEPLOY.md`. Todos os comandos abaixo são executados pelo programador no terminal privado da VPS, como o usuário de serviço `agendepost`, com o mesmo arquivo de ambiente. Não execute o servidor ou comandos administrativos como root. Nunca envie segredos ou links de acesso em grupos, tickets, gravações ou conversas de suporte compartilhadas.

## Contas e primeiro acesso

O modo hospedado não registra os endpoints públicos de cadastro, reenvio ou solicitação de recuperação. Até 50 contas podem ser emitidas pelo operador. Não há conta ou senha pré-instalada.

Antes de emitir um link, o operador confirma a identidade e o email exato da pessoa por um canal confiável. A flag abaixo registra que essa conferência foi feita; ela não verifica uma caixa de email automaticamente.

```sh
sudo -u agendepost /usr/local/bin/node --env-file=/etc/agendepost/agendepost.env \
  /opt/agendepost/current/scripts/operator-access.mjs \
  --purpose enroll --email EMAIL_VERIFICADO --name 'Nome da pessoa' \
  --confirm-verified-recipient
```

O comando exibe uma única URL HTTPS privada, com validade de uma hora. Apenas o hash do token é salvo. O responsável entrega a URL somente à pessoa verificada, que abre o link e define a própria senha de 15 a 128 caracteres. O operador não escolhe, lê ou recebe a senha. Se emitir novamente para uma conta ainda pendente, o link anterior é invalidado. Um link de cadastro não serve para recuperar conta ativa.

Após entrar, a pessoa cria organização e marca. Não recebe acesso a outras organizações. A revisão independente vem ativa por padrão; normalmente outra pessoa autorizada deve aprovar o conteúdo antes de agendar. A configuração existente permite ao proprietário alterar essa política com autenticação recente e justificativa; isso é uma decisão explícita da organização.

## Convites para equipe

1. Owner/admin cadastra o convite no painel, com email exato, papel e marcas autorizadas. A tela mostra a referência do convite.
2. Se a pessoa ainda não tem conta, o operador emite antes o acesso pessoal como acima.
3. Após verificar a pessoa e a referência, emite o link do convite:

```sh
sudo -u agendepost /usr/local/bin/node --env-file=/etc/agendepost/agendepost.env \
  /opt/agendepost/current/scripts/operator-access.mjs \
  --purpose invitation --email EMAIL_VERIFICADO --invitation-id REFERENCIA \
  --confirm-verified-recipient
```

A emissão confere email, validade, situação da organização e autoridade atual de quem convidou. Não concede um novo papel por conta própria. O token anterior é substituído e o novo expira em no máximo uma hora. O destinatário entra com a conta do mesmo email para aceitar. O convite reserva uma vaga enquanto válido. Revogar pelo painel invalida o link. “Invalidar link anterior” permite solicitar nova emissão ao operador, sem fingir envio de email.

## Recuperação

Depois de confirmar independentemente a identidade, o operador usa o mesmo comando com `--purpose reset --email EMAIL_VERIFICADO --confirm-verified-recipient`. A URL expira em 30 minutos, é de uso único e permite à própria pessoa escolher a nova senha. Concluir a recuperação revoga todas as sessões anteriores. Não entregue um link só porque alguém diz ser o dono da conta. O painel público nunca informa se um email existe.

`dev:mail` é recusado no perfil hospedado. Não reutilize o banco de desenvolvimento: o startup recusa um outbox local não vazio. Não importe usuários de teste ou tokens antigos para contornar isso.

## Operação da plataforma

`admin:grant` é opcional; não é necessário para o primeiro usuário criar sua organização. Ele concede acesso a metadados operacionais e controles de plano do piloto. Mantenha apenas operadores realmente autorizados. O comando abre somente o banco; não inicia worker ou chamadas Meta.

## Serviço, worker e limites

Um único processo atende HTTP e, quando explicitamente habilitado, executa a fila durável no banco. O systemd reinicia falhas; não é uma garantia de disponibilidade. `/health/ready` responde erro quando o worker esperado não está ativo/saudável. O processo hospedado verifica essa condição a cada dez segundos e sai com erro para permitir recuperação pelo supervisor. Monitorar readiness, logs sanitizados, disco e jobs `failed`, `blocked` ou `needs_attention` é responsabilidade do operador.

Sem configuração de publicação, mantenha `SOCIAL_SAAS_PUBLISHING_WORKER=false`. Durante instalação, restauração e diagnóstico mantenha as flags Meta e worker desligadas. Não inicie um segundo servidor para executar comandos operacionais.

O prazo de envio continua sendo quinze minutos após o horário agendado. Se ultrapassado, o job falha visivelmente. Antes de cada envio são verificadas revisão, aprovador, pessoa que agendou, permissão, marca, canal e versão da conexão. Um resultado remoto incerto não é reenviado automaticamente. Um processo parado depois do checkpoint `publishing` exige verificação manual na conta social; não edite o banco para forçar reenvio.

## Mídia

A biblioteca fica em blobs no banco privado. Não monte esse diretório em nginx e não use URLs privadas autenticadas como imagem pública da Meta. A publicação atual exige o operador disponibilizar somente os bytes JPEG da revisão aprovada em um serviço HTTPS autorizado, imutável e de acesso temporário, e cadastrar digest, escopo e prazo no arquivo de publicação. A configuração contém a URL assinada sensível, portanto fica privada.

A expiração no JSON só bloqueia novos envios; não remove um objeto do servidor externo. O serviço de mídia escolhido deve expirar/revogar o acesso de fato. É necessário testar que a URL retorna acesso negado após o prazo, que continua válida durante a recuperação da Meta, e que não há listagem pública de arquivos. Se isso não foi configurado, mantenha publicação desativada. Conectar OAuth é uma etapa separada e pode ser validada antes da mídia.

## Backup e restauração

O banco inclui usuários, organizações, mídia, auditoria e tokens OAuth criptografados. Crie snapshots consistentes com o comando de backup; não copie um arquivo SQLite aberto ignorando WAL. Execute o teste de restauração em nova pasta privada e mantenha a cópia isolada. O comando `restore:check` invalida sessões/links e conexões locais e congela os jobs que poderiam voltar a executar. Isso evita ressuscitar sessões revogadas ou publicar novamente a partir de um backup antigo.

Consulte o procedimento completo e os comandos de `HOSTINGER-DEPLOY.md`. Guarde a chave de criptografia fora do backup de dados, com recuperação privada controlada. Armazene backup criptografado fora da VPS, defina retenção e faça simulações periódicas de recuperação. Não existe rotação de chave nem retenção automática nesta versão. Atualizações de esquema exigem snapshot e teste de rollback antes de trocar o código.

## Critério para interromper o piloto

Suspenda novos convites/publicações se houver erro de isolamento, suspeita de vazamento, restore não validado, perda da chave, filas incertas sem revisão, certificado expirado, falta de disco ou worker instável. Nunca relaxe o guard de HTTPS/proxy/CSRF para resolver um erro de deploy. Capacidade, email real, MFA, políticas legais e segurança independente precisam de revisão antes de vender serviço ou abrir cadastro ao público.
