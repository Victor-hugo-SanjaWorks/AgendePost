> Base histórica do piloto local 0.2, preservada para referência técnica. Para instalar o AgendePost 0.3 na VPS, use HOSTINGER-DEPLOY.md, HOSTED-OPERATIONS.md e META-SETUP-HOSTED.md. As antigas restrições operacionais de perfil local não descrevem o opt-in hospedado; os controles de isolamento e publicação permanecem válidos.

# Social Studio — revisão 0.2

Esta revisão atende às duas prioridades mais recentes: agendamento de publicação e Dashboard com FOFA e análise de concorrentes. É uma evolução separada do pacote 0.1 já entregue; não indica ativação de contas ou implantação pública.

## Agendamento e publicação

O conteúdo aprovado pode gerar trabalhos persistentes por canal, com data, horário, fuso, versão aprovada e destino confirmado. O processo de envio revalida permissões e aprovação e registra separadamente agendado, em envio, publicado, falha e resultado incerto. Cancelamentos e reagendamentos usam controle de versão. Um resultado incerto não é reenviado cegamente, para evitar posts duplicados.

A primeira integração implementada atende imagem única JPEG no feed do Instagram profissional vinculado a uma Página e em Páginas do Facebook. Vídeos, Reels, carrosséis e Stories continuam como planejamento editorial, sem envio automático nesta revisão. Uma imagem precisa ter cópia HTTPS autorizada e bytes correspondentes à mídia aprovada.

Existe uma tolerância máxima de 15 minutos após o horário agendado. Passado esse prazo, o sistema registra a falha para revisão em vez de publicar uma promoção ou anúncio de evento no dia errado.

## Dashboard

A área antes chamada Relatórios passa a ser Dashboard. Inclui indicadores e gráficos editoriais por marca, FOFA e comparação de concorrentes com fontes e datas. Indicadores editoriais vêm do próprio sistema; não representam alcance, vendas ou engajamento de redes sociais. Dados não disponíveis aparecem como ausentes, e hipóteses não são apresentadas como fatos.

É possível registrar análises e observações de concorrentes, atualizar com controle de versão e arquivar sem apagar o histórico. Não há coleta automática das contas dos concorrentes nem promessa de leitura de dados privados.

## Conectar contas com segurança

O fluxo de conexão usa autorização oficial da Meta, seleção explícita do destino e armazenamento de credenciais somente no servidor. A configuração fica desabilitada até existir aplicativo Meta, configuração segura do servidor e autorização das contas. Não informe senhas, tokens ou chaves no chat, em legendas ou em arquivos públicos.

Criar o aplicativo no Meta Developers, obter permissões adequadas e preparar a operação contínua são etapas distintas de testar o código. Para disponibilizar a plataforma a clientes externos, ainda há requisitos da Meta e de produção que não são substituídos por testes simulados.

## Limites operacionais

- O piloto local só processa agendamentos enquanto o programa e o computador estão ativos.
- Não foi contratada nem implantada hospedagem 24 horas.
- O modo público de produção permanece bloqueado. Não exponha este piloto diretamente à internet.
- A ativação OAuth exige configuração HTTPS segura e armazenamento de segredos compatível. O fluxo atual de arquivos privados é para servidor POSIX/Linux; o atalho Windows não ativa essa integração sozinho.
- Nenhuma publicação real, cobrança ou concessão de acesso foi executada durante os testes automatizados.
- O pacote não contém credenciais, bancos de clientes ou contas pré-conectadas.

Leia os relatórios de QA e segurança desta revisão para os resultados exatos e as limitações de teste. O guia de uso está em USER-GUIDE.md; operação de publicação em PUBLISHING-OPERATIONS.md; configuração Meta em META-INTEGRATION.md e META-OAUTH.md.
