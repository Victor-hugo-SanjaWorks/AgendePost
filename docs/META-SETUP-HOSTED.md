# Meta: configuração pelo programador após instalar a VPS

## Dados deste projeto

- Produto/site: **AgendePost**, `https://agendepost.com.br`
- Aplicativo Meta principal existente: **Social L2M**, App ID **1635966938158621**. Confirmar no painel do proprietário antes de inserir no servidor.
- O ID **1655445465943595** é específico do produto Instagram no painel e não deve substituir automaticamente o App ID principal usado pelo Facebook Login.
- Callback exato desta implementação: **https://agendepost.com.br/api/v1/social-connections/meta/callback**

O domínio foi registrado no Registro.br; DNS deve apontar para a VPS Hostinger pelo painel de DNS que efetivamente administra a zona. Não alterar servidores DNS indiscriminadamente se houver email ou outros serviços existentes.

Esses identificadores não são credenciais. App Secret, chave de criptografia, códigos OAuth e tokens nunca pertencem ao chat, ZIP, frontend ou repositório.

## Separar três etapas

1. **Instalar o piloto HTTPS:** nginx, serviço, dados persistentes, contas por convite, backup e smoke test.
2. **Conectar uma conta Meta:** configuração de aplicativo e consentimento da pessoa; OAuth descobre e permite selecionar destinos reais.
3. **Publicar um teste:** revisão aprovada, destino exato autorizado, JPEG HTTPS temporário, worker e confirmação expressa do conteúdo. Conexão bem-sucedida não comprova publicação.

Esta entrega contém código e testes offline para essas funções. Nenhuma etapa externa foi realizada, nenhuma conta foi conectada e nenhuma publicação real foi enviada. Os testes não substituem App Review, Advanced Access ou Business Verification quando exigidos pela Meta.

## Antes de habilitar OAuth

- Confirmar proprietário e App ID no painel Meta oficial; não criar outro aplicativo apenas para tentar corrigir configuração.
- Confirmar que o fluxo do produto é Facebook Login/Instagram API com Facebook Login para **token de usuário**, vinculado a Página. O código não implementa login direto Instagram, WhatsApp Embedded Signup, token de system user ou variantes de integração comercial sem avaliação adicional.
- Configurar a URL acima em Valid OAuth Redirect URIs, com HTTPS e comparação exata. Não adicionar barra no fim, fragmento, URL do frontend, `www`, endereço IP ou localhost como substituto.
- Confirmar URL do site/domínio, política de privacidade, contato de suporte, processo de exclusão de dados e demais campos exigidos. O operador deve fornecer identidade legal, contato e regras de tratamento/retensão reais; o pacote não inventa uma política jurídica nem fornece webhook de desautorização/exclusão. Publicar os documentos revisados antes de convidar clientes ou pedir revisão à Meta.
- Usar inicialmente contas/pessoas elegíveis para o modo de desenvolvimento do aplicativo. Atender pessoas fora dos papéis permitidos pode depender de revisão e acesso avançado.
- Conferir Page task `CREATE_CONTENT`; para Instagram, conta Business ou Creator profissional realmente ligada à Página.
- Registrar o consentimento da pessoa para conceder acesso e selecionar o destino, sem compartilhar sua senha com o programador.

## Arquivos privados no servidor

Use uma subpasta privada fora do código, por exemplo `/etc/agendepost/meta/`, pertencente ao usuário `agendepost`, modo `0700`. Cada arquivo é regular, sem symlink/hardlink, proprietário `agendepost`, modo `0600`. O serviço deve conseguir ler, mas o nginx e usuários não autorizados não devem poder ler. O código verifica esses limites.

Criar `meta-oauth.json` localmente no servidor por fluxo seguro, sem registrar seu conteúdo em histórico ou logs:

```json
{
  "enabled": true,
  "apiVersion": "v26.0",
  "appId": "1635966938158621",
  "appSecret": "INSERIR_SOMENTE_NO_ARQUIVO_PRIVADO_DA_VPS",
  "redirectUri": "https://agendepost.com.br/api/v1/social-connections/meta/callback",
  "tokenFlow": "user",
  "requestTimeoutMs": 15000
}
```

Provisionar uma chave aleatória de 32 bytes, codificada em Base64 padrão, em `meta-token-key`. Ela protege tokens com AES-256-GCM. Não use a chave de exemplo de testes, não cole a chave em conversa e não a inclua no ZIP ou backup comum do banco. Preserve recuperação privada independente. Perder ou trocar a chave bloqueia a leitura das conexões; não há rotação automática.

Após autorização e preparação, configurar no arquivo de ambiente do serviço:

```dotenv
SOCIAL_SAAS_META_OAUTH_ENABLED=true
SOCIAL_SAAS_META_OAUTH_CONFIG_FILE=/etc/agendepost/meta/meta-oauth.json
SOCIAL_SAAS_META_ENCRYPTION_KEY_FILE=/etc/agendepost/meta/meta-token-key
SOCIAL_SAAS_META_ENABLED=false
SOCIAL_SAAS_PUBLISHING_WORKER=false
```

Reiniciar o serviço em janela autorizada e verificar o painel de Conexões sociais. A configuração inválida mantém OAuth indisponível; não relaxe validação de arquivo ou HTTPS.

## Facebook Login for Business: conferir configuração atual

O usuário alcançou a área “Facebook Login for Business” do aplicativo. A entrega adiciona passagem opcional de um `loginConfigId` numérico, configurado exclusivamente no arquivo privado acima, para o parâmetro `config_id` da URL oficial de autorização. O fluxo continua `response_type=code`, com `state` de uso único, callback fixo e verificação de token **USER** no backend.

Se o painel desse aplicativo exigir uma configuração de Login for Business, o programador deve conferir a documentação atual e criar/selecionar uma configuração apropriada para token de usuário e para os escopos necessários. Só então adicionar `"loginConfigId": "ID_NUMERICO_VERIFICADO"` ao JSON. Não confundir Configuration ID, App ID e Instagram App ID. Não escolher system-user/WhatsApp ou permissões extras como atalho.

**Limitação verificada:** a documentação oficial de Facebook Login for Business retornou HTTP 429 durante esta preparação. Foi testada apenas a validação e composição opcional do parâmetro; não foi demonstrado que uma configuração específica do aplicativo Social L2M é aceita pela Meta. O parâmetro `scope` existente é preservado; a interação com a configuração de Business Login deve ser confirmada no teste real. Se a Meta exigir outra variante ou formato, pare e revise a integração, sem marcar a conexão como pronta.

Referência oficial a conferir pelo programador: https://developers.facebook.com/docs/facebook-login/facebook-login-for-business/

## Permissões usadas pelo código

- Facebook Pages: `pages_show_list`, `pages_read_engagement`, `pages_manage_posts`
- Instagram via Facebook Login: `pages_show_list`, `pages_read_engagement`, `instagram_basic`, `instagram_content_publish`
- Para Instagram quando a pessoa declara acesso pelo Business Manager: `ads_read` adicional. Não é solicitado indistintamente a todos os usuários.

O programa valida permissões, identidade, aplicativo, prazo, Página e vínculo profissional após trocar o código. Não conecta automaticamente o primeiro resultado. Owner/admin com autenticação recente seleciona explicitamente o destino para a marca/canal correto. Uma autorização expirada, revogada ou trocada bloqueia os jobs antigos; não existe refresh automático nem fallback silencioso para token estático anterior.

## Smoke test OAuth que falta executar

Com a pessoa dona da conta presente e autorizando o acesso:

1. Entrar em `agendepost.com.br`, criar a marca/canal correto e ir a Conexões sociais.
2. Confirmar que a URL de consentimento vai ao domínio oficial Facebook e contém callback/id esperados, sem app secret.
3. Revisar e autorizar as permissões na Meta. Não registrar a tela de retorno, query strings ou códigos.
4. Verificar que o callback retorna à marca correta, mostra somente destinos realmente descobertos e exige seleção.
5. Selecionar a Página/Instagram exatos. Conferir nome, ID e prazo na aplicação.
6. Confirmar em inspeção privada que o banco armazena somente payload cifrado e logs não contêm código/token/segredo.
7. Testar desconexão e invalidação de jobs sem mandar postagem. Reconectar exige novo consentimento conforme a Meta.

Erros “aplicativo indisponível”, escopo, tarefa, revisão, callback ou tipo de token devem ser tratados como configuração/compatibilidade ainda pendente. Não editar estado do banco para fingir autorização.

## Publicação fica desligada até a mídia e o teste final

Para ativar publicação depois, seguir `META-INTEGRATION.md` e `HOSTED-OPERATIONS.md`. O arquivo privado de publicação usa `connections: []` para resolver os vínculos OAuth e um mapa de imagens aprovadas com escopo tenant/marca, digest e URL HTTPS temporária. URLs assinadas são sensíveis. A expiração precisa ser aplicada no host da mídia, não só no JSON.

O aplicativo não fornece armazenamento público automático de imagens. Mantenha a biblioteca privada; disponibilize apenas o JPEG exato cuja publicação foi autorizada, pelo prazo necessário. O adaptador verifica bytes, tamanho e digest antes do envio. Sem esse serviço configurado, OAuth pode ser testado, mas publicação permanece bloqueada.

Só ligar `SOCIAL_SAAS_META_ENABLED=true` e `SOCIAL_SAAS_PUBLISHING_WORKER=true` depois de preparar o arquivo seguro, revisar conteúdo/destino e autorizar o teste. O resultado “publicado” exige ID remoto real. Timeout após envio final permanece incerto e não permite reenvio automático.
