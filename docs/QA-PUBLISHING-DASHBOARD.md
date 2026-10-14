> Base histórica do piloto local 0.2, preservada para referência técnica. Para instalar o AgendePost 0.3 na VPS, use HOSTINGER-DEPLOY.md, HOSTED-OPERATIONS.md e META-SETUP-HOSTED.md. As antigas restrições operacionais de perfil local não descrevem o opt-in hospedado; os controles de isolamento e publicação permanecem válidos.

# QA independente: publicação e dashboard

Data: 14/10/2026. Escopo: incremento de publicação automática e dashboard do piloto `social_saas`, em Linux, Node.js 24.19.0. Este relatório complementa a evidência histórica de v0.1; não altera o ZIP anterior nem reaproveita sua contagem como se testasse funcionalidades novas.

## Estado da verificação

Verificação concluída em 14/10/2026, após o congelamento final dos arquivos executáveis:

- Árvore de desenvolvimento: sintaxe aprovada; **201/201 testes**, zero falhas, cancelamentos ou testes ignorados (170,1 segundos).
- Cópia limpa extraída de ZIP: instalação `npm ci --offline` a partir de cache separado, 121 pacotes instalados; sintaxe aprovada; **201/201 testes**, zero falhas, cancelamentos ou testes ignorados (171,4 segundos).
- Na mesma cópia limpa, repetição explícita de `npm run test:http`: **3/3**; de `npm run test:e2e`: **3/3**. Esses casos já integram a suíte completa e não são somados como testes novos.
- A comparação após os testes encontrou **119/119 arquivos idênticos** entre origem, manifesto anterior à execução e cópia limpa. Nenhum arquivo de banco, sessão, segredo privado ou log foi incluído no ZIP de QA.
- O arquivo OAuth DOM teve ainda cinco execuções consecutivas aprovadas, **15/15**, depois de tornar a troca de marca determinística. Os novos testes DOM de agendamento, estratégia e OAuth estão incluídos nos 201 testes.

O relatório recebeu somente esta atualização documental após a rodada. Nenhum arquivo executável foi alterado depois dos resultados acima. Tentativas anteriores interrompidas por ferramentas e a rodada anterior com um teste DOM falhando não foram contabilizadas como sucesso.

Os testes de publicação usam sessões HTTP verdadeiras, SQLite persistente e imagens JPEG regravadas pelo aplicativo. O adaptador externo e o transporte da Meta são substituídos exclusivamente por fixtures locais, identificadas como teste. Nenhuma credencial real, concessão OAuth, compra ou publicação em rede social é feita pela suíte. Um resultado `published` de fixture prova o fluxo e a confirmação interna, não uma publicação real na Meta.

## Cobertura independente

- Enfileiramento exige revisão atual aprovada, imagem única, destinos vinculados à mesma marca e versão da conexão apresentada na confirmação. Campos de autoridade e credenciais no corpo HTTP são rejeitados.
- Datas passadas, sem offset, inválidas, com fuso inexistente, incoerência de offset, gap de horário de verão e prazo superior a 90 dias são recusadas. A interface distingue as duas ocorrências de horário ambíguo e exige a escolha explícita do offset.
- Vários destinos são criados atomicamente. Falha no segundo destino desfaz o primeiro; repetição idempotente mantém os mesmos IDs.
- Worker não antecipa envio; revalida autor, papel, grant da marca, aprovador, suspensão da organização, vínculo da conexão e conteúdo no momento do disparo. A revisão/imagem/legenda enviada corresponde à aprovação.
- Resultados por canal são independentes. Falha em Facebook não transforma confirmação de Instagram em falha ou vice-versa.
- Exceção, resposta malformada, sucesso sem ID, resposta desconhecida e retry sem prova explícita de segurança exigem conferência. Não há repetição cega nem novo job para a mesma revisão/canal incerto.
- Cancelamento e reagendamento concorrentes têm um único vencedor. Leases antigos não podem enviar depois de cancelamento/reagendamento. Envio iniciado recusa cancelamento, reagendamento e edição do conteúdo.
- Expiração de lease e resposta tardia são exercitadas antes e depois da recuperação explícita. Processo sem heartbeat recente ou parado impede novo agendamento.
- Atraso superior a 15 minutos falha sem iniciar envio. Preparação que atravessa esse limite não pode alcançar o checkpoint de publicação irreversível.
- Reinícios mantêm jobs, revisão, data, canal e sessão. Jobs confirmados não são executados novamente depois de novo reinício.
- Teste TCP usa listener real em loopback para agendar, repetir idempotentemente, executar o worker e consultar a confirmação. Origin e CSRF incorretos e falta de sessão são recusados.
- Dashboard, análises, concorrentes e revisões respeitam a marca concedida. Sete posts em marca oculta não elevam métricas da marca visível. Dados sociais ausentes permanecem `null`, sem alcance, engajamento ou seguidores inventados.
- Evidência interna mostra regra, numerador, denominador e origem. Hipóteses manuais são identificadas; evidências e concorrentes informados não são apresentados como verificados externamente.
- Fontes exigem esquema HTTP/HTTPS, sem credenciais, com datas reais e contexto apropriado. Endereços locais, privados e link-local são recusados. Campos de URL não disparam coleta externa.
- Concorrentes têm dados numéricos opcionais, limites e janela de observação explícita. Campo vazio não é tratado como zero. Escrita por reviewer/viewer, campos extras, versões antigas e IDs fora da marca são recusados.
- Interface executada em jsdom com APIs e cookies reais: prontidão desativada, revisão exata, edição não salva, DST, clique duplicado, reagendamento, cancelamento, conflito com texto preservado, fontes e HTML inerte, papéis de leitura e resposta atrasada da marca anterior.

## Revisão de adaptador e integração

Os testes do responsável do adaptador também são executados independentemente em conjunto. Cobrem criação de mídia não publicada, processamento pendente, checkpoint durável antes do POST irreversível, reuso do container, limite de resposta/tempo, validação do JPEG hospedado por digest, recusas de autenticação/permissão, ID remoto ausente ou de outra Página, destinos de rede privada e configuração local protegida.

Os testes integrados usam o adaptador Meta verdadeiro com transporte HTTP falso e o worker SQLite real. Exercitam rejeição explícita por limite da Meta seguida de retry seguro sem recriar a mídia, ID de Página errada sem replay e container do Instagram pendente seguido de confirmação. A integração OAuth calcula `appsecret_proof` no servidor, e as mutações Graph sintéticas conferem sua presença sem entregar o segredo do aplicativo ao adaptador.

## OAuth offline e proteção de configuração

A verificação independente usa o cliente OAuth real contra respostas HTTP sintéticas. Callback de outra sessão não troca o código; state consumido não é reutilizado. Candidatos pendentes pertencem à sessão, marca e canal de origem. Reader/editor não pode selecionar conexão. Tokens não aparecem nas respostas públicas, auditoria ou payloads em claro nas tabelas de pendência/conexão. A desconexão remove a credencial utilizável e impede o disparo de job já enfileirado. Uma falha atrasada vinculada à versão antiga não revoga uma conexão nova, e uma conexão revogada não recai silenciosamente em credencial estática. Isso não comprova login, permissões ou autorização em uma conta Meta real.

A inicialização recusa os três caminhos declarados de segredo quando são relativos ou ficam na árvore da aplicação, inclusive webroot, aliases/symlinks, arquivos privados com modo 0600 e caminhos ainda não criados. A recusa ocorre antes de abrir o banco e registrar HTTP, mesmo com a integração desativada. Diretórios internos cujo nome começa por dois pontos (como `..private`) não escapam da contenção. Arquivos com múltiplos hardlinks também são recusados, pois outro nome público poderia expor o mesmo inode. Os loaders de publicação e OAuth fazem suas próprias validações; arquivo absoluto privado externo, regular, com único link e permissões adequadas permanece utilizável.

## Defeitos encontrados e correções verificadas

1. Escritas estratégicas validavam quota fora da transação, produzindo erro 500. A validação mutável foi movida para a transação e a autorização de leitura do alvo mantém IDs de outra marca indistinguíveis de inexistentes.
2. Edição de legenda era aceita durante envio em andamento. A API passou a rejeitar a alteração com conflito antes de gravar uma nova revisão.
3. Adaptador tentava regredir checkpoint de `publishing` para `ready`, o que o worker corretamente recusava. Após erro explícito de rate limit, somente o worker faz a mudança durável ao registrar o resultado seguro; o adaptador não regride o checkpoint por conta própria.
4. Confirmação tardia poderia finalizar sem conferir a validade temporal do lease. O caminho final agora recupera o lease vencido e não aceita o resultado tardio como sucesso.
5. Encerramento precisava acompanhar também chamadas diretas de dispatch. O worker agora aborta e aguarda os envios em andamento antes do fechamento do banco.
6. Configuração sensível podia ser declarada dentro do webroot, onde o mesmo processo a serviria apesar do modo 0600. O gate de caminho descrito acima impede a inicialização. A revisão também identificou o limite de contenção em nomes `..private` e a variante com hardlink público; ambas têm regressões incluídas na suíte final.
7. Evento redundante de seleção da marca atual podia recarregar a página e fechar um formulário aberto. A interface agora ignora seleção sem mudança. A fixture OAuth foi corrigida para começar explicitamente na marca A, mudar de fato para B e aguardar um novo nó de interface; uma regressão separada verifica a preservação do formulário em seleção inalterada, sem aumentar timeouts ou enfraquecer a cobertura entre marcas.

## Limitações

- A tentativa pelo navegador oficial de nuvem, em tab isolada, não abriu o listener local: `net::ERR_CONNECTION_REFUSED`. A tentativa subsequente de inspecionar a página de erro foi recusada pela política de protocolo do navegador. Nenhum bloqueio foi contornado; abas de autenticação não foram tocadas.
- Assim, não há certificação visual/responsiva, screenshots reais, teclado real, leitores de tela ou CSP no motor de navegador. jsdom valida integração DOM e não substitui essas verificações.
- Não foi feita publicação real, OAuth real, teste de credenciais, entrega Meta, validação de aplicativo Meta em produção ou disponibilidade de hospedagem 24 horas.
- O worker local depende de processo ativo e máquina acordada. A fila durável não torna o produto um serviço hospedado.
- Gates de produção, Windows/macOS nativos, carga, falhas de infraestrutura e revisão jurídica continuam fora desta evidência.

## Reproduzir

```sh
npm ci
npm run check
npm test
node --test --test-concurrency=1 tests/qa-publication-*.test.mjs tests/security-strategy*.test.mjs
npm run test:http
npm run test:e2e
```

## Integridade da entrega

O ZIP de QA foi extraído em diretório novo e recebeu instalação limpa das dependências. Antes de empacotar, foram recusados symlinks e arquivos sensíveis/de execução e excluídos bancos, outbox, caches, artefatos temporários e `node_modules`. A cópia testada inclui todos os gates finais de caminho privado, hardlinks, prova do segredo Meta e seleção inalterada de contexto.

Digest SHA-256 do manifesto de todos os arquivos não Markdown testados, ordenados por caminho, com tamanho e SHA-256 de cada arquivo: `d9178ff616540d78f8cf7e51255f948ae2fbc2648a1d84ba0221f716e7786e35`. O manifesto usa JSON compacto com chaves ordenadas. A atualização deste relatório não altera esse digest.

O ZIP histórico de v0.1 permanece intacto: SHA-256 `75b1f80ddb1c137fd25ea8a146d468f9cbc10e29ad07a68c39d97538e3c56997`. O novo pacote deve ser produzido com nome e manifesto próprios e corresponder aos arquivos verificados aqui. O hash do ZIP final é registrado no manifesto de entrega, sem substituir o histórico.

A aprovação é da execução offline e da integridade local descritas neste documento. Login e concessão Meta, publicação real, instalação nativa e avaliação visual permanecem fora da evidência.
