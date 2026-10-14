> Base histórica do piloto local 0.2, preservada para referência técnica. Para instalar o AgendePost 0.3 na VPS, use HOSTINGER-DEPLOY.md, HOSTED-OPERATIONS.md e META-SETUP-HOSTED.md. As antigas restrições operacionais de perfil local não descrevem o opt-in hospedado; os controles de isolamento e publicação permanecem válidos.

# Publicação real: operação local e limites

A revisão v0.2 implementa uma fila durável de envio por canal, separada do planejamento editorial. O aplicativo continua sendo um piloto local. Não há hospedagem pública, serviço contínuo contratado, conexão Meta configurada ou publicação real realizada na entrega.

## O que executa

- Imagem única JPEG para Instagram profissional ligado a uma Página e para Facebook Pages.
- Agendamento com data futura, offset explícito e fuso IANA compatível, até 90 dias.
- Revisão aprovada exata, conferida ao agendar, ao iniciar cada tentativa e imediatamente antes da etapa que efetivamente publica.
- Revalidação do usuário que agendou, seu vínculo/papel/acesso à marca, do aprovador, da situação da organização, do plano de acesso, da marca/canal e da versão da conexão.
- Mídia normalizada aprovada, com bytes, tamanho e SHA256 conferidos; a cópia HTTPS autorizada é verificada pelo adaptador antes de enviar à Meta.
- Resultado independente para cada canal. Publicado exige resposta confirmada contendo ID remoto. Preparar um contêiner não é publicar.

O suporte é deliberadamente limitado: vídeo, reels, carrosséis, stories, texto, PNG/WebP e outras redes não estão habilitados para envio. O editor ainda pode conter esses formatos para planejamento interno.

## Habilitação segura

Leia também `META-INTEGRATION.md`. A configuração só é feita pelo operador no servidor, em arquivo privado. Não existe formulário de token, senha, cookie ou credencial no aplicativo. Não envie segredos em conversas. Não copie configuração privada para pacote, controle de versão, pasta pública ou backup compartilhado.

Por padrão, toda publicação fica desativada. Os três controles precisam ser configurados explicitamente:

- `SOCIAL_SAAS_META_ENABLED=true`
- `SOCIAL_SAAS_META_CONFIG_FILE` apontando para o arquivo privado validado
- `SOCIAL_SAAS_PUBLISHING_WORKER=true`

Inicie o aplicativo normalmente. O processo interno registra batimentos de saúde e consulta a fila. Sem configuração válida, autorização atual, imagem apta e processo saudável, a API não cria um agendamento de publicação. Uma conexão editorial criada com um nome continua sendo somente um alvo editorial até existir configuração autorizada.

A integração atual usa a URL HTTPS verificada da imagem tanto no Instagram quanto no Facebook. Esse arquivo precisa estar hospedado e autorizado fora do aplicativo local. O aplicativo não transforma URLs privadas em públicas e não instala infraestrutura ou cria permissões por conta própria.

## Computador desligado, atrasos e falhas

O processo só trabalha enquanto o aplicativo está aberto e o computador está ligado e acordado. O banco persiste os trabalhos em reinicializações normais, mas isso não equivale a disponibilidade 24 horas. Um processo sem batimento recente não é apresentado como pronto. Os limites de produção de v0.1 permanecem: modo production e bind público são recusados.

Uma tentativa tem duração máxima de 120 segundos e lease de 150 segundos. No máximo cinco tentativas seguras são permitidas. O prazo de um trabalho é 15 minutos após o horário previsto; depois disso ele falha visivelmente e precisa ser reagendado. A retomada dentro desses 15 minutos pode publicar com atraso. O sistema não publica silenciosamente no dia seguinte. Mantenha o computador ativo e acompanhe a fila. Uma implantação contínua e política operacional revisada ainda são necessárias antes de oferecer serviço comercial.

Após parada/crash antes do envio, um lease vencido pode voltar à fila. Se houver um contêiner preparado, com estado persistido que comprova que a etapa de publicação não começou, ele pode ser retomado. Antes do POST irreversível, o adaptador precisa persistir o estado `publishing` e aguardar a confirmação da gravação. Se o processo parar depois desse ponto, o trabalho fica `needs_attention`. Não há repetição automática de um envio de resultado desconhecido, nem botão que apague essa proteção.

Confira manualmente a conta no caso de resultado incerto. Essa revisão não implementa uma resolução manual por API; não altere o banco para forçar tentativas. O processo de reconciliação precisa de desenvolvimento/revisão adicional antes de liberar reenvios incertos.

## Cancelar, reagendar e editar

Cancelar e reagendar exigem a versão atual do trabalho. Duas alterações concorrentes têm um único vencedor. Leases ainda não enviados são invalidados; o despachante antigo não pode prosseguir. Depois que uma tentativa começa, cancelar/reagendar é recusado porque o aplicativo não pode prometer desfazer a publicação remota.

Alterar o conteúdo invalida a aprovação e bloqueia trabalhos pendentes daquela revisão. Durante uma tentativa em andamento, alterações de conteúdo e transições editoriais são bloqueadas até haver resultado. Reagendar não altera a revisão aprovada, mas revalida toda a autorização e disponibilidade para a nova data.

## Evidência de teste

Testes usam adaptadores offline ou transporte HTTP explicitamente substituído; não contatam Meta e não comprovam aprovação de aplicativo, validade de credenciais ou acesso a contas reais. As suítes cobrem HTTP real no loopback, sessões/CSRF, persistência, estados por canal, corrida de versões, revogação de permissões, mídia exata, leases e fencing, checkpoints e tentativas limitadas. Leia o relatório independente de QA para a contagem final e limitações.
