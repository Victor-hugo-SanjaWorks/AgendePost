> Base histórica do piloto local 0.2, preservada para referência técnica. Para instalar o AgendePost 0.3 na VPS, use HOSTINGER-DEPLOY.md, HOSTED-OPERATIONS.md e META-SETUP-HOSTED.md. As antigas restrições operacionais de perfil local não descrevem o opt-in hospedado; os controles de isolamento e publicação permanecem válidos.

# Conexão OAuth Meta: implementação e ativação segura

Revisão: 14 de outubro de 2026. Graph API fixada em **v26.0**. O fluxo descrito abaixo está implementado e testado com respostas HTTP sintéticas. Nenhuma conta, permissão, credencial ou publicação real foi criada pelos testes.

## O que está pronto e o que ainda depende de operação

O sistema implementa Facebook Login, troca do código no servidor, token de usuário de longa duração, inspeção de identidade/permissões/expiração, descoberta de Páginas e Instagram profissional, escolha explícita de destino, criptografia dos tokens, vínculo exato com canal e desconexão local. O adaptador de publicação consulta esse vínculo atual a cada envio.

A conexão continua **desativada por padrão**. A existência do código não fornece aplicativo Meta, autorização, revisão de permissões, hospedagem HTTPS, hospedagem de mídia ou serviço permanentemente ligado.

Este produto continua sendo um **piloto local, restrito a loopback**. O modo production e a exposição pública direta continuam bloqueados. Não exponha o servidor local à internet nem desative essas restrições como atalho. A ativação comercial exige uma implantação separadamente revisada, HTTPS, banco/worker duráveis e os demais requisitos de lançamento.

O backend de segredos desta implementação aceita somente arquivos privados em **POSIX/Linux**. No Windows ele falha fechado: as permissões POSIX não comprovam proteção equivalente por ACL NTFS. Portanto, o lançador Windows não ativa OAuth. Um backend Windows de segredos dependeria de implementação e revisão próprias.

Além disso, o callback deve ter HTTPS e a mesma origem canônica da aplicação, com cookies seguros. O piloto só aceita origem canônica loopback. Uma instalação de teste autorizada teria de fornecer HTTPS confiável nessa origem e uma URI aceita pelo Meta, sem afrouxar as restrições do produto. Essa infraestrutura não é fornecida pelo pacote. O código não afirma que o Meta aceitará um callback local específico ou que exista um site público pronto.

## Pré-requisitos externos

1. Aplicativo Meta pertencente ao operador, com Facebook Login e as capacidades e permissões apropriadas para Page publishing e/ou Instagram profissional.
2. Callback HTTPS exato: `/api/v1/social-connections/meta/callback`, na origem canônica aprovada. Sem parâmetros, fragmentos ou caminhos alternativos.
3. App ID e app secret provenientes do aplicativo real; chave AES-256 provisionada pelo operador em armazenamento privado. Nunca envie esses valores por chat, formulário da aplicação, issue, repositório ou screenshot.
4. Usuário com acesso válido à Página e tarefa `CREATE_CONTENT`; para Instagram, conta Business ou Creator vinculada à Página.
5. Consentimento explícito da pessoa para conceder acesso persistente. O botão da aplicação leva ao domínio oficial do Facebook; não cria ou aprova a permissão silenciosamente.
6. Política de privacidade, tratamento/exclusão de dados e requisitos de revisão aplicáveis. Advanced Access, App Review e Business Verification são necessários quando exigidos para atender clientes fora dos papéis permitidos no aplicativo.
7. Para publicar, ainda são necessários conteúdo aprovado, JPEG HTTPS autorizado com bytes idênticos aos aprovados, worker ligado e teste ao vivo expressamente autorizado em cada destino.

## Configuração exclusivamente no servidor

Variáveis suportadas:

- `SOCIAL_SAAS_META_OAUTH_ENABLED=true`
- `SOCIAL_SAAS_META_OAUTH_CONFIG_FILE=/caminho/absoluto/privado/meta-oauth.json`
- `SOCIAL_SAAS_META_ENCRYPTION_KEY_FILE=/caminho/absoluto/privado/meta-token-key`

Os caminhos devem estar fora do repositório/web root, inclusive através de links simbólicos. O arquivo deve ser regular, não um link simbólico, pertencer ao usuário do servidor e não permitir acesso de grupo/outros. Use permissões `0600` e diretório privado `0700`. O guard de inicialização rejeita caminhos dentro do repositório mesmo quando a integração está desativada, para não deixar um segredo acessível como arquivo estático.

Formato de `meta-oauth.json`:

```json
{
  "enabled": true,
  "apiVersion": "v26.0",
  "appId": "ID_NUMERICO_DO_APLICATIVO_REAL",
  "appSecret": "SEGREDO_FORNECIDO_PELA_META_SOMENTE_NO_ARQUIVO_PRIVADO",
  "redirectUri": "https://ORIGEM_CANONICA_AUTORIZADA/api/v1/social-connections/meta/callback",
  "requestTimeoutMs": 15000
}
```

O arquivo da chave contém exatamente 32 bytes codificados em Base64 padrão. A aplicação não gera, persiste ou substitui uma chave automaticamente. Gere e proteja a chave por um procedimento autorizado do operador; preserve-a separadamente do banco e de seus backups. Uma chave diferente torna as credenciais existentes indisponíveis, e a aplicação bloqueia publicação em vez de usar texto plano ou uma chave improvisada. Rotação automatizada de chave não está implementada.

O arquivo JSON não contém tokens de contas: eles são obtidos apenas pelo callback OAuth e armazenados criptografados. Não existe endpoint HTTP para cadastrar app secret, chave de criptografia ou access token.

A publicação mantém sua configuração independente em `META-INTEGRATION.md`, incluindo flag de habilitação e mapa seguro de mídia HTTPS. Configure `connections: []` para utilizar somente os vínculos OAuth. Contas estáticas existentes continuam disponíveis exclusivamente quando aquele canal nunca teve um vínculo OAuth. Um vínculo OAuth expirado, desconectado, revogado ou ilegível é definitivo para o canal: jamais cai silenciosamente na credencial estática antiga.

## Experiência de conexão

Somente owner/admin da organização pode iniciar, escolher ou desconectar. As mutações exigem sessão válida, autenticação recente, origem correta e CSRF. Cada tentativa escolhe um canal existente da marca atual; a plataforma é derivada do canal no servidor.

Para Instagram, a pessoa indica se o acesso à Página foi concedido diretamente ou pelo Business Manager. Esse dado é uma **declaração explícita da pessoa**, não uma classificação que a API provou. No segundo caso, a tela solicita consentimento adicional de `ads_read`. O aplicativo não pede acesso amplo a anúncios de todos os usuários. Se o acesso foi declarado incorretamente ou a Meta exigir outra verificação, a publicação pode ser recusada; a pessoa deve corrigir o acesso e reconectar.

Escopos:

- Facebook: `pages_show_list`, `pages_read_engagement`, `pages_manage_posts`
- Instagram via Facebook Login: `pages_show_list`, `pages_read_engagement`, `instagram_basic`, `instagram_content_publish`
- Instagram com acesso pelo Business Manager: os anteriores mais `ads_read`

O callback **não** conecta automaticamente a primeira conta retornada. A tela mostra os destinos realmente descobertos, IDs e elegibilidade. A pessoa escolhe e confirma o destino para o canal exato. Antes de gravar, o servidor revalida identidade, permissões, acesso à Página, tarefa de conteúdo, token da Página e vínculo profissional Instagram.

Os tokens Page sem prazo próprio conhecido recebem um limite conservador baseado na autorização User validada e na validade de acesso a dados. Não são chamados de permanentes. Não existe refresh automático ou recuperação de uma autorização expirada: é necessário reconectar.

## Contrato HTTP

Base: `/api/v1/tenants/:tid/workspaces/:wid/social-connections`.

- `GET /meta`: configuração segura, conexões públicas, seleção pendente da sessão atual e último resultado sanitizado do callback. Sem credenciais.
- `POST /meta/start`: `{channelId, accessBasis: "direct" | "business_manager"}`. Retorna somente URL oficial de autorização e validade da tentativa.
- `GET /api/v1/social-connections/meta/callback`: valida `state`, sessão e escopo de autoridade, consome a tentativa antes de trocar o código. Redireciona para `/#/app/connections/<tenantId>/<workspaceId>`, sem código, token ou state no destino.
- `POST /meta/select`: `{pendingId, candidateId, channelId, expectedChannelVersion}`. Exige escolha explícita e versão do canal vista pelo usuário.
- `POST /:connectionId/disconnect`: `{expectedVersion}`. Remove a credencial local do canal, invalida seleções pendentes e bloqueia seus agendamentos ainda não enviados.

Não armazene a URL de autorização ou o `state` em localStorage. Não copie URLs de callback para tickets ou analytics. Não trate a resposta do callback como prova de publicação ou concessão de acesso a qualquer outro canal.

## Controles e limites de segurança

- `state` criptograficamente aleatório de 256 bits, hash persistido, uso único e TTL de dez minutos. Vinculado a sessão, usuário, organização, marca, canal, plataforma e versão do canal.
- Tentativas inválidas, expiradas, repetidas ou vindas de outra sessão não trocam código. Nova tentativa e desconexão invalidam tentativas antigas; os commits após HTTP verificam se ainda possuem a tentativa/seleção.
- OAuth não muda a identidade da sessão local. A seleção não aceita IDs arbitrários: usa apenas candidatos descobertos para aquela tentativa e revalidados no servidor.
- Tokens criptografados com AES-256-GCM, IV aleatório e AAD contendo identificadores de escopo e versão. Alterar ciphertext ou transplantá-lo para outra organização/canal impede a autenticação criptográfica.
- Escopos, tarefas, identificadores, saúde, expiração e versão são separados da credencial criptografada. Tokens, códigos e payloads de erro bruto não entram em DTOs, auditoria, exports ou logs da aplicação.
- A troca e inspeção OAuth usam URLs **server-to-server** oficiais da Graph API que podem conter app secret, código ou token de inspeção. Essas URLs são sensíveis e nunca são devolvidas nem registradas. Logs de proxy de saída, APM e depuração HTTP também precisam remover query strings e credenciais. O callback de entrada contém código de curta duração conforme o protocolo: proxies/ingress devem desativar registro da query, e a resposta tem `no-store` e `no-referrer`.
- Paginação usa somente um cursor validado no endpoint fixo. Não segue a URL `next` do provedor, que pode conter token ou destino inesperado. Sem redirects HTTP, com timeout e tamanho de resposta limitado.
- Toda conexão recebe uma versão nova ao reconectar, mesmo para o mesmo destino. Jobs ficam vinculados à versão confirmada; a fila e cada etapa de publicação checam novamente o vínculo atual. Falhas de autenticação revogam somente a versão que falhou, nunca uma credencial recém-reconectada.
- Desconexão é **local a este canal**. Ela não remove a concessão inteira na conta Meta, que pode servir outras marcas/canais. A pessoa pode remover o aplicativo nas configurações da Meta; não há endpoint público de revogação geral ou webhook de desautorização neste corte.
- Jobs em `scheduled`, `retry_wait` ou `leased` são bloqueados imediatamente por desconexão/revinculação. Uma requisição já enviada à Meta pode terminar; uma publicação existente não é apagada. Outcomes incertos continuam exigindo reconciliação, sem repetição automática.
- Revogação remota e mudanças de permissões podem ocorrer após a conexão. São percebidas nas verificações de seleção e nos erros reais de publicação; não existe polling contínuo de saúde ou webhook que prometa detecção instantânea.

## Verificação offline

```sh
node --test tests/social-connections.test.mjs tests/social-connections-publishing.test.mjs tests/qa-publication-oauth.test.mjs
```

Os testes exercitam os handlers HTTP reais, criptografia real e SQLite, injetando apenas respostas de rede sintéticas. Incluem callback/sessão/replay, isolamento de marcas, seleção, criptografia/tampering, erros e expiração, desconexão, troca de versão e fluxo completo OAuth → agendamento → adaptador HTTP de publicação. Não provam que uma conta externa autorizou ou aceitou uma postagem.

Referências e verificação de requisitos oficiais: `META-PUBLISHING-RESEARCH.md`. Configuração de mídia, limitações de publicação e recuperação: `META-INTEGRATION.md` e `PUBLISHING-OPERATIONS.md`.
