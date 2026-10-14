# Dashboard do cliente · AgendePost 0.4

## Caminho na interface

1. Escolher a organização e cadastrar/selecionar uma marca, por exemplo DTA.
2. Vincular os canais editoriais e conectar as contas suportadas em **Conexões**. Um canal chamado LinkedIn é apenas um cadastro editorial: este piloto não oferece OAuth nem métricas reais dessa rede.
3. Abrir **Dashboard do cliente** no menu lateral. A área **Estratégia editorial** continua separada e não entra no link compartilhado.
4. Após configurar o servidor, o proprietário habilita explicitamente a coleta da marca. A ação exige confirmação recente de identidade. Habilitar coleta não gera um link e gerar um link não habilita coleta.
5. Proprietário/admin escolhe **Compartilhar dashboard**, informa nome/validade, aceita a informação de que qualquer portador poderá consultar resultados e copia o link. Sem essa ação explícita, não existe acesso público aos dados.
6. O cliente abre o URL completo sem entrar no aplicativo administrativo. Enquanto válido, o mesmo link consulta novas informações salvas. A equipe pode revogá-lo e gerar outro quando necessário.

## O que aparece

- Nome da marca, nomes dos canais/contas, estado de conexão/coleta.
- Seguidores e contadores básicos que a Meta efetivamente disponibilizar para a conta e publicação autorizadas.
- Publicações realizadas: uma página de até 25 objetos retornados por conta Meta, inclusive criados fora do AgendePost, mais os publicados e identificados no AgendePost. A ordem depende do provedor, sem promessa de histórico completo. A tela limita a 50 itens por conta e 100 no total, ordenados por data de publicação.
- Link oficial da publicação quando validado, métricas disponíveis, horário observado e limites de cobertura. Não baixamos legendas ou imagens do feed para este dashboard.
- Estado indisponível/erro/desatualizado e valor `null` onde não houver número confirmado. Zero só aparece quando foi retornado como zero. Alcance, impressões, visitas e insights avançados ainda não foram integrados; essa é uma limitação do piloto, não uma afirmação de que a rede não os oferece.

Não são compartilhados rascunhos, arquivos de mídia privada, comentários internos, FOFA, plano estratégico, membros, faturamento, sessões, credenciais ou poderes administrativos. O link de dashboard não autoriza decisões de aprovação; isso usa um link separado.

## Atualização automática e cobertura

A tela consulta snapshots salvos a cada 60 segundos enquanto a aba está visível. Reabrir/atualizar a página **não chama a Meta**. O coletor no servidor funciona somente com duas autorizações: `SOCIAL_SAAS_METRICS_ENABLED=true` pelo operador e habilitação da marca pelo proprietário. Intervalo mínimo de 15 minutos, sujeito a limites de API, fila, falhas e backoff. Não é tempo real.

“Última coleta” é a observação de dados, não o momento em que alguém abriu a tela. O horário geral é a observação mais recente entre contas; verificar também cada conta e cobertura. Contadores são retratos dos totais observados, não crescimento diário, análise de intervalo selecionado ou série histórica. Curtidas e reações do Facebook não devem ser somadas como se fossem públicos distintos. Não há total agregado de alcance/engajamento entre redes.

Detalhes de campos, permissões, listagem, limites e fontes primárias: [SOCIAL-METRICS.md](SOCIAL-METRICS.md).

## Link privado e controles

- Token aleatório de 256 bits, apenas SHA-256 no banco. O link aparece uma vez; listas/auditoria/idempotência não permitem recuperar o token bruto.
- URL `/client-dashboard#token=...`. O fragmento não acompanha o GET da página. O JavaScript o captura, remove da barra e usa somente cabeçalho Bearer em chamadas HTTPS de mesma origem. Não usa localStorage, sessionStorage, cookies de login nem token na URL de API/imagem.
- Validade de 1–90 dias; padrão visual 30. Até cinco links ativos por marca. Compartilhar somente com destinatários autorizados; o sistema não verifica identidade nominal do portador. Reenvio do link por um destinatário também permite acesso até revogação/expiração.
- Criar/revogar exige papel proprietário/admin atual, marca ativa, sessão, origem/CSRF, identidade recente, escopo exato e versão na revogação. A criação exige chave de idempotência, sem recuperação de segredo em repetição.
- Cada leitura revalida o criador e o estado da organização/marca. Remover seu papel/acesso, suspender a conta/organização, arquivar a marca ou revogar o link bloqueia novas leituras.
- Respostas `no-store`, política sem referrer, CSP, noindex e projeção allowlist. Rotas privadas continuam exigindo login; o bearer não cria sessão nem autoriza mutação.
- Ao perder autorização, a tela apaga os resultados. Enquanto há erro temporário de rede, mostra os últimos dados já recebidos com aviso. Revogação não pode retirar uma captura de tela ou cópia que o destinatário já fez.
- Restaurar backup revoga links existentes e desativa coleta. Emitir novos links após revisão e não reaproveitar links de snapshots.

Se a resposta da criação se perder ou o diálogo for fechado sem copiar, revogar o registro e gerar outro. Não buscar tokens no banco ou pedir sua exposição em logs.

## Validação pendente na VPS

Testes do pacote cobrem HTTP/DOM, vazamento de tokens, escopo cruzado, permissões, expiração/revogação, refresh e respostas atrasadas. A coleta usa provedores sintéticos. Antes de uso real: validar HTTPS, conta/permissões Meta, dados observados, ordenação/cobertura, privacidade, destinatários autorizados e navegadores/celulares. A tentativa de inspeção Chromium neste ambiente foi bloqueada pelo runtime; os testes DOM não certificam renderização visual ou acessibilidade completa.
