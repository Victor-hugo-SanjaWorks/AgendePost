# WhatsApp opcional para pedidos de aprovação · AgendePost 0.4

O pacote inclui um adaptador da **WhatsApp Cloud API oficial**, desativado por padrão. Sem configuração, a equipe pode copiar o link de aprovação e compartilhá-lo manualmente no canal combinado. Não há conexão por QR Code, automação de WhatsApp Web, criação automática de conta, envio em massa ou mensagem real executada nesta entrega.

## O que o programador configura, com autorização do responsável

1. WhatsApp Business Account e número remetente habilitado para Cloud API, sob controle da organização correta. O App ID de Facebook/Instagram não é um Phone Number ID do WhatsApp.
2. Credencial válida com a permissão `whatsapp_business_messaging` e acesso ao número. Criação/atribuição/rotação da credencial é uma operação separada do operador; não enviar segredos por conversa nem colocá-los no código.
3. Template aprovado no idioma configurado, com **um parâmetro de texto no corpo**, contendo o URL completo de aprovação. O adaptador não cria nem aprova templates. Exemplo de texto para submeter e revisar: “Há uma peça para sua aprovação. Confira a arte, a legenda, as redes e o horário neste link privado: {{1}}. Se precisar de ajuda, responda à nossa equipe.” O operador deve verificar categoria, conteúdo, aprovação e política atuais; esse exemplo não é garantia de aprovação.
4. Confirmar que o link com fragmento `#...` abre integralmente nos aparelhos usados pelo cliente. Não usar encurtador público nem analytics de terceiros no link; ambos podem expor a capacidade de aprovação.
5. Número informado pelo destinatário, opt-in adequado e processo para respeitar opt-out. A caixa de confirmação no aplicativo registra a declaração do remetente, não substitui comprovação de consentimento. O aplicativo não importa agenda nem guarda um catálogo de contatos.
6. Conferir cobrança e condições atuais da Meta antes do primeiro envio. Nenhum preço, plano pago ou contrato foi contratado aqui.

A política oficial exige permissão do destinatário e templates aprovados para conversas iniciadas pela empresa. A janela de atendimento de 24 horas é relevante para mensagens livres; este adaptador usa template mesmo dentro dessa janela. Custos e disponibilidade dependem da Meta. Fonte: [WhatsApp Business Messaging Policy](https://business.whatsapp.com/policy), consultada em 14/10/2026.

## Arquivo privado

Criar manualmente fora do código, por exemplo `/etc/agendepost/whatsapp/cloud-api.json`, arquivo regular sem symlink/hardlink, proprietário do usuário `agendepost`, modo `0600`, diretório privado. Não tornar esse arquivo acessível por nginx. O ID interno da organização aparece no contexto autenticado/API; não usar nome comercial como ID.

```json
{
  "enabled": true,
  "apiVersion": "v26.0",
  "connections": [{
    "tenantId": "ID_INTERNO_DA_ORGANIZACAO",
    "phoneNumberId": "PHONE_NUMBER_ID_NUMERICO",
    "accessToken": "PREENCHER_SOMENTE_NO_ARQUIVO_PRIVADO",
    "templateName": "nome_do_template_aprovado",
    "languageCode": "pt_BR",
    "bodyFormat": "approval_url_only",
    "senderLabel": "Nome reconhecido pelo cliente"
  }]
}
```

O exemplo é propositalmente incompleto e não deve ser ativado sem substituir os placeholders pelo operador. Uma única configuração por tenant impede usar o remetente de outra organização. Não há editor de credenciais no frontend.

Após validação e autorização, ajustar somente no arquivo de ambiente privado:

```dotenv
SOCIAL_SAAS_WHATSAPP_ENABLED=true
SOCIAL_SAAS_WHATSAPP_CONFIG_FILE=/etc/agendepost/whatsapp/cloud-api.json
```

Reiniciar de forma controlada. Configuração inválida mantém a integração indisponível, sem envio alternativo. O estado pode ser lido em `GET /api/v1/tenants/:tid/workspaces/:wid/whatsapp-notification-status`, com usuário autorizado a editar a marca; ele não retorna a credencial nem o Phone Number ID. O serviço não recebe mensagens: monitorar respostas/opt-out no canal operacional apropriado.

## Fluxo de uso

1. Preparar a peça e concluir aprovação interna conforme a política da organização.
2. Em **Aprovações**, confirmar redes, data e horário e gerar o link. O link só é exibido nessa criação; o banco guarda seu hash.
3. Com o adaptador configurado, informar telefone internacional com `+`, confirmar consentimento e clicar **Enviar link pelo WhatsApp**. Essa ação transmite à Meta o telefone e o URL com a capacidade limitada de aprovação. A arte/legenda não são anexadas à mensagem pela API; o portador vê a prévia no site.
4. Conferir o resultado. **Aceito pela API não significa entregue, lido ou aprovado.** Não há webhook de entrega nesta versão. Quem decide é o portador do link, no site, após clicar explicitamente aprovar ou solicitar ajustes. Uma prévia automática de link não aprova nada.

A API de envio exige sessão, acesso atual à marca, confirmação recente de identidade, CSRF/origem, consentimento explícito, link pendente da revisão exata e chave de idempotência. O destino e a URL não podem ser escolhidos por parâmetros de host fornecidos pelo cliente.

## Resultado incerto e privacidade

- A aplicação nunca reenvia automaticamente. Há chave de idempotência, trava concorrente, intervalo mínimo de cinco minutos e limite de cinco tentativas por pedido.
- Em timeout, erro de rede ou resposta ambígua, o estado é **desconhecido**. Verificar no provedor antes de uma nova tentativa. Uma falha de rede pode ocorrer depois de a Meta ter aceitado a mensagem.
- O banco guarda status, ID de mensagem do provedor quando confirmado, hash do telefone e últimos quatro dígitos. Não guarda telefone completo, token do link nem corpo da resposta do provedor. Backups continuam privados porque incluem dados de todos os tenants.
- Revogar o link bloqueia novas leituras/decisões, mas não apaga mensagens entregues nem desfaz conteúdo já publicado.
- Restaurar backup revoga links e marca tentativas em voo como desconhecidas. Nunca repetir envios de um backup.

## Verificação e limites

O endpoint implementado é `POST https://graph.facebook.com/v26.0/{phone-number-id}/messages`, tipo `template`, um parâmetro `body` de texto. O retorno `wamid` é tratado apenas como aceitação. Fontes técnicas primárias: [coleção oficial Meta no Postman](https://www.postman.com/meta/whatsapp-business-platform/request/lwtlz1k/send-message-template-interactive) e [referência oficial de mensagens](https://developers.facebook.com/docs/whatsapp/cloud-api/reference/messages). A página técnica direta estava indisponível nesta rodada; o formato foi também conferido na [referência de template do SDK oficial arquivado](https://whatsapp.github.io/WhatsApp-Nodejs-SDK/api-reference/messages/template/). Não usamos esse SDK arquivado como dependência.

Testes locais usam transporte sintético e verificam segregação, consentimento, payload exato, segredo fora de logs/banco, idempotência, revogação e resultados incertos. O programador ainda deve validar versão de API, credencial, template aprovado, URL completa no celular, remetente/tenant correto e uma mensagem controlada expressamente autorizada. Não afirmar entrega real com base nesses testes.
