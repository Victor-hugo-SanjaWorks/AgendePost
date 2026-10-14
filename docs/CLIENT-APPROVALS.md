# AgendePost 0.4 — Aprovações do cliente

## O que está entregue

A aba **Aprovações** é separada do editor e dos dashboards. A equipe continua enviando a arte, escrevendo a legenda e vinculando os canais no editor existente. Esta versão oferece uma imagem por peça e publicação nos canais Instagram/Facebook já suportados pelo serviço de publicação. **Envio real Meta exige JPEG e URL HTTPS temporária dos bytes exatos aprovada/configurada pelo operador.** O aplicativo mantém a biblioteca privada e não cria hospedagem pública automática de imagens. Prévia PNG/WebP pode ser revisada, mas o adaptador de publicação exige JPEG; preparar o formato final antes de pedir a aprovação para evitar novo pedido. Ver META-SETUP-HOSTED.md, seção de mídia.

O fluxo inicial é:

1. Preparar e salvar o conteúdo no editor.
2. Solicitar e concluir a revisão interna da versão exata.
3. Em Aprovações, selecionar a peça, os canais, data, hora, fuso e validade do link.
4. Copiar o link privado para o cliente. O link é exibido apenas na criação; não é recuperável depois de fechar a janela. WhatsApp é opcional e depende de configuração do operador, modelo oficial aprovado e confirmação explícita de destinatário e consentimento.
5. O cliente abre o link e confere a imagem, legenda, canais e horário. Ele clica **Aprovar e autorizar agendamento** ou pede ajustes com uma observação.
6. Se aprovado e todas as condições ainda forem válidas, são criadas entradas na fila, uma por canal, para o horário exato. O worker existente executa o envio. A aba de publicações mostra o resultado real.

**Aprovação não significa publicação.** Se o servidor, a autorização, a mídia ou outro requisito estiver indisponível, a decisão fica registrada como **aprovado; agendamento pendente**, com o motivo. Nenhuma publicação fictícia é criada. Depois de corrigir uma indisponibilidade transitória, uma pessoa autorizada pode escolher **Tentar agendar**, mantendo a revisão, data e conexão originais. Mudanças de conteúdo, destino ou data exigem um novo link e nova aprovação; um horário passado nunca é transferido silenciosamente para outro.

## Política interna e primeiro dia

A aprovação externa é uma camada de consentimento separada. Ela **não escreve** na tabela de aprovações internas e **não se apresenta como um usuário autenticado**. A identidade registrada é “portador do link”. Não há prova de identidade de cliente nomeado.

A política da organização pode exigir que outra pessoa aprove internamente. Quando ativada, o autor da revisão não pode fazer essa aprovação. Quando desativada, o revisor pode coincidir com o autor se tiver papel interno de revisão. Um editor comum não ganha papel de revisor por enviar ou receber um link.

Somente o proprietário altera essa política em Configurações, com senha recente e motivo. A nova aba informa a política vigente; não desativa nem contorna a regra. Para uma organização nova com revisão independente ativa, é necessário convidar outra pessoa com papel de revisão antes do primeiro link. A aplicação nunca usa o cliente anônimo para substituir esse revisor.

## Condições verificadas

Na criação, a revisão precisa estar aprovada internamente e ser compatível com o compartilhamento de uma imagem. O pedido congela revisão, resumo de conteúdo, imagem/digest, canais escolhidos, versões de conexão, horário e fuso, solicitante e estado do planejamento editorial. Não inclui outras mídias da marca.

Na decisão e no agendamento são revalidados:

- Revisão atual e correspondência com o conteúdo salvo e seus relacionamentos.
- Aprovação interna vigente, papel/acesso do revisor e independência quando exigida.
- Acesso atual do solicitante à marca e à organização; organização e marca ativas.
- Direito de uso comercial e sua validade na data planejada.
- Canais e versões das autorizações/destinos originais.
- Imagem elegível, integridade e requisitos do adaptador de publicação.
- Horário futuro, máximo de 90 dias e offset consistente com o fuso IANA, incluindo ambiguidades de horário de verão.
- Worker ativo, ausência de publicação duplicada e ausência de envio anterior ambíguo.

Uma falha em qualquer canal desfaz toda a tentativa de enfileiramento, sem perder o consentimento recebido. Os checkpoints de envio existentes continuam revalidando autorização e mídia antes da etapa irreversível. A tolerância de atraso continua sendo de 15 minutos, sem envio tardio silencioso.

## Links, revogação e segurança

- Token aleatório de 256 bits, apenas seu SHA-256 no banco. Não há token bruto no histórico, auditoria ou respostas de idempotência.
- Link em fragmento: `/approval.html#<token>`. O fragmento não vai ao servidor na navegação; a página o remove da barra e conserva o valor somente em memória durante essa visita. Recarregar exige reabrir o link original.
- APIs recebem o token no cabeçalho Authorization. Nenhum token é colocado em URL de imagem, query, localStorage ou sessionStorage.
- Imagem obtida por fetch autenticado, renderizada por URL blob. A rota não aceita um identificador arbitrário: só serve a imagem vinculada à revisão aprovada daquele pedido, com verificação de digest, MIME fixo, no-store, nosniff e sandbox.
- Respostas e página usam CSP/referrer-policy existentes. Texto é escapado; não há HTML de cliente executável. Sair/voltar pelo histórico ou recuperar a página do cache de navegação apaga token, imagem e prévia. Respostas atrasadas não restauram conteúdo. Reabrir exige o link original em nova aba; requisições têm prazo de 20 segundos. Resultado incerto de decisão não causa reenvio automático.
- GET/HEAD da página ou prévia nunca registra decisão. A mutação exige POST, Origin correto, CSRF da sessão/preauth e challenge aleatório curto, vinculado ao token, pedido e versão. Challenges só são persistidos como hashes e são consumidos na decisão.
- Decisão única, transação imediata e versão otimista. Repetição, troca de challenge entre links, link expirado ou revogado e conteúdo alterado são recusados.
- A validade é de até sete dias, limitada também ao horário escolhido. Uma edição ou mudança no planejamento invalida o pedido. Remover a autoridade de acesso do solicitante também bloqueia o link.
- Revogar bloqueia acesso e futuras decisões, cancela entradas associadas ainda não iniciadas e não apaga publicações já feitas. A aplicação recusa prometer revogação quando um envio já está em andamento. Envios já confirmados permanecem publicados; resultados incertos continuam exigindo reconciliação. Só envios realmente cancelados antes do início aparecem como cancelados.
- Proprietários, administradores e editores com acesso atual à marca podem criar/revogar/tentar agendar. Leitores e revisores internos podem consultar a aba, sem esses poderes de escrita.

A lista mostra os 200 pedidos mais recentes por marca. A geração repetida com a mesma chave de idempotência retorna o pedido existente sem revelar novamente o token. Se a resposta inicial se perdeu, revogue esse pedido e gere outro.

## WhatsApp opcional

O módulo de notificações é uma integração separada. A aba consulta sua prontidão e só oferece envio quando configurado. O número deve estar em formato internacional, e a equipe confirma que o cliente autorizou o contato e que deseja enviar o link àquele número. A solicitação usa uma chave de idempotência em memória; token e telefone não entram no mecanismo genérico de cache de mutações da interface.

A mensagem usa um modelo oficial. “Aceita pela API” não significa “entregue” nem “lida”. Falha ou resultado incerto não causa reenvio automático. Quando não configurado, a interface diz isso e permite copiar o link. Não existe botão que simule envio.

O seam `ctx.services.clientApprovals.assertNotification(req, rawToken)` valida pedido, token, estado pendente, validade, revisão, política interna e autoridade atual antes de autorizar a preparação da notificação.

## Integração técnica

- Inicializar `initializeClientApprovals(ctx)` após o serviço de publicação.
- Registrar `registerClientApprovals(app, ctx)` antes dos arquivos estáticos.
- Carregar `/approval.css` e `/approvals.js` no app, renderizar `window.ClientApprovals.render(...)` na rota interna `/app/approvals` e chamar cleanup nas trocas de contexto. O componente expõe isDirty para a navegação existente.
- Aplicar a migração `090-client-approvals.sql` pelo migrador normal, sem alterar checksums anteriores.
- Não é necessário abrir uma exceção no guard de autenticação/Origin/CSRF existente.

Rotas internas sob `/api/v1/tenants/:tid/workspaces/:wid`:

- GET `/client-approvals`: últimos pedidos e estados reais das publicações associadas.
- GET `/client-approvals/options`: peças elegíveis, canais/conexões e política vigente.
- POST `/client-approvals`: criar link, com idempotência obrigatória. Campos: postId, expectedRevision, channelIds, connectionVersions, scheduledAt com offset, scheduledTimezone e expiresInHours opcional.
- POST `/client-approvals/:aid/revoke`: expectedVersion e idempotência.
- POST `/client-approvals/:aid/retry-scheduling`: expectedVersion e idempotência; nunca altera o escopo aprovado.

Rotas públicas restritas ao bearer:

- GET `/api/v1/client-approval`: prévia e challenge; não aprova.
- GET `/api/v1/client-approval/media`: única imagem autorizada.
- POST `/api/v1/client-approval/decision`: expectedVersion, challenge, decision (approve/request_changes), feedback opcional, além de CSRF/Origin.

## Verificação

`node --test --test-concurrency=1 tests/client-approvals*.test.mjs`

Os testes usam somente dados, links de loopback e adaptadores offline. Cobrem consentimento e enfileiramento automático real no serviço local, execução offline pelo worker, bloqueios honestos, atomicidade multicanal, independência interna, escopo por organização/marca, revogação, expiração, CSRF/Origin/challenge, mídia e digest, revisões alteradas, instantes exatos em fuso não UTC e horário de verão. Testes DOM verificam escaping, remoção do fragmento, nenhuma decisão por GET, clique explícito, conteúdo pendente sem falso “agendado”, guarda de contexto, ausência de armazenamento persistente e caminho de criação separado.
