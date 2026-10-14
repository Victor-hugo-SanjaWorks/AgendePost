> Base histórica do piloto local 0.2, preservada para referência técnica. Para instalar o AgendePost 0.3 na VPS, use HOSTINGER-DEPLOY.md, HOSTED-OPERATIONS.md e META-SETUP-HOSTED.md. As antigas restrições operacionais de perfil local não descrevem o opt-in hospedado; os controles de isolamento e publicação permanecem válidos.

# Revisão de segurança: publicação e estratégia v0.2

Data: 14/10/2026. Ambiente: Linux, Node 24.19.0, aplicação local em loopback. Revisão de código e verificações offline. Nenhuma conta, credencial real, concessão OAuth, hospedagem ou publicação externa foi usada nesta revisão.

## Resultado e escopo

A fila durável, o adaptador HTTP Meta, o fluxo OAuth e o dashboard de estratégia foram examinados. Uma exposição concreta de arquivo de credenciais foi reproduzida e corrigida, incluindo variantes com aliases e hardlinks. As corridas de desconexão/reconexão e a integração OAuth → fila → adaptador HTTP foram verificadas com transporte substituído. Não permanece um defeito de segurança conhecido nas superfícies locais examinadas. A conclusão depende também da matriz funcional final em `QA-REPORT.md` e não autoriza ativação externa.

A aplicação continua sendo um piloto local. Esta revisão não demonstra aprovação do aplicativo Meta, conexão efetiva de uma conta, execução Windows, disponibilidade contínua ou prontidão de produção. Os bloqueios de implantação pública devem permanecer ativos.

## SEC-PUB-01 — Arquivo privado de credenciais podia ser servido sem autenticação

**Impacto:** um operador podia configurar `SOCIAL_SAAS_META_CONFIG_FILE` dentro de `public/`. O carregador aceitava um arquivo regular pertencente ao usuário do servidor, com modo `0600`. O mesmo processo depois registrava o diretório no servidor estático e podia entregar o JSON, incluindo tokens e URLs assinadas, sem sessão. As permissões Unix não protegem contra leitura pelo próprio servidor. Este era um erro de configuração possível, não uma capacidade de escolher caminhos pela API.

**Reprodução independente:** em uma cópia descartável do aplicativo, um JSON com token explicitamente falso foi criado com modo `0600` dentro da raiz estática. `createApp` iniciou com o adaptador habilitado. Um GET sem cookie retornou HTTP 200 e o marcador do token falso. Foram feitas zero requisições externas. Nenhum arquivo de credenciais real foi lido ou criado.

**Correção:**

- `src/config.mjs` rejeita, antes de abrir o banco ou registrar rotas, os três caminhos declarados de segredo: configuração de publicação, configuração OAuth e chave de criptografia.
- Os caminhos precisam ser absolutos e ficar fora do repositório, tanto lexicalmente quanto pelo caminho físico. A verificação alcança aliases por symlink, caminhos ainda não criados e nomes de diretório filhos iniciados em dois pontos (`..private`), que não devem ser confundidos com travessia para o diretório pai.
- A recusa vale mesmo com os controles de integração desligados. Apenas retornar um adaptador desabilitado não impediria a exposição de um arquivo já colocado na raiz estática.
- Arquivos existentes precisam ter um único hardlink (`nlink === 1`): um caminho externo privado não pode esconder um segundo nome servido pelo diretório público.
- O erro é somente `PRIVATE_CREDENTIAL_PATH_FORBIDDEN`, sem conteúdo ou caminho sensível.
- `createMetaPublishingAdapterFromEnv` também rejeita configurações relativas ou dentro do repositório quando usado isoladamente, preservando as demais verificações de tamanho, arquivo regular, proprietário e modo.

**Reavaliação:** a reprodução passou a recusar o startup com o erro sanitizado. `tests/security-publishing-config.test.mjs` verifica arquivos falsos `0600` em `public/` e no repositório, aliases físicos externos, symlink dentro da raiz estática apontando para fora, caminho relativo, caminho inexistente, filho `..private` e hardlink externo para a raiz estática. Exercita as três variáveis, com as integrações desligadas, e confirma que arquivo privado externo continua utilizável. Conjunto configuração + adaptador: 34 testes passaram.

**Limite:** o controle não torna seguro guardar outros segredos arbitrários na raiz estática. Nenhum segredo deve ser colocado no repositório, no pacote de entrega ou em diretório servido por HTTP.

## Controles examinados na publicação

- O destino Graph é fixo e versionado. IDs remotos aceitos pelo adaptador são numéricos; URLs de API e métodos não vêm de uma requisição do usuário. A autorização da publicação fica em cabeçalho, não na URL.
- URLs de mídia são mapeadas pelo operador por tenant, marca e digest. A API de publicação não aceita URL arbitrária, token, segredo ou configuração de provedor.
- A busca do JPEG exige HTTPS, porta 443, host explicitamente permitido, ausência de usuário/senha/fragmento e DNS público. Se qualquer resposta DNS for privada/reservada, o acesso é recusado. A conexão usa um único endereço previamente validado, sem segunda resolução, proxy, cookies ou cabeçalho de autorização Meta.
- O transporte de mídia não segue redirecionamentos e limita bytes. MIME, tamanho, assinatura JPEG e SHA-256 precisam corresponder aos bytes aprovados. As chamadas Graph têm timeout, limite de resposta, política sem redirecionamentos e erros sanitizados.
- Agendar exige aprovação vigente da revisão exata e mídia única preservada. O servidor revalida organização, plano, marca, canal, usuário que agendou, aprovador, papéis e grants.
- A UI envia as versões de conexão vistas no diálogo. O servidor exige o conjunto exato de canais e versões; mudança de destino/autorização entre revisão e confirmação impede enfileiramento.
- A chave única de banco impede duplicata da mesma revisão/canal enquanto houver agendamento ativo, resultado publicado ou resultado incerto. Conteúdo e aprovação não são inferidos do status de planejamento.
- Claims, cancelamento, reagendamento e commits usam transações, versões e tokens de lease. Um despachante antigo não pode sobrescrever recuperação ou cancelamento. Tentativas após perda do lease não podem confirmar sucesso local.
- Antes do POST que publica, o adaptador aguarda a persistência do checkpoint `publishing`; o callback revalida autorização, conexão, lease e prazo. Checkpoints não podem regredir por conta própria.
- Uma rejeição de rate limit positivamente identificada pode produzir retry seguro, com rollback do fence e resultado na mesma transação. Timeout, erro de rede, resposta sem ID confiável e resultado incerto não são reapresentados como sucesso nem repetidos automaticamente.
- Cancelamento/reagendamento e edição de conteúdo são recusados durante `sending`. A interface não promete remover uma publicação remota.

## Controles examinados na estratégia

- Todas as consultas de registros, revisões e agregações mantêm tenant e workspace na seleção e nos joins. Grants e papéis são rechecados no servidor; revisores/viewers não gravam dados.
- Campos extras de identidade, escopo ou verificação são rejeitados. Gravações têm controle de versão e transação; evidência informada exige fonte/data, e ausência de número permanece distinta de zero.
- Valores textuais são escapados antes de compor HTML. Links permitem somente HTTP/HTTPS sem credenciais e usam `noopener noreferrer`. URLs de referência nunca são buscadas pelo backend.
- Respostas atrasadas de uma marca antiga não substituem a marca selecionada. Testes DOM mantêm payloads HTML inertes.
- Métricas são contagens editoriais internas. A UI declara que não são alcance, engajamento ou resultados reais das redes. A FOFA calculada usa regras transparentes; registros de concorrentes são observações manuais sem verificação independente.

## OAuth: controles e verificações concluídas

O fluxo examinado contém state aleatório de uso único, digest no banco, vínculo à sessão/usuário/tenant/marca/canal, expiração curta, exigência de autenticação recente e rechecagem após chamadas assíncronas. Códigos não são persistidos. Tokens pendentes e conexões usam AES-256-GCM, IV aleatório e AAD vinculada ao registro e ao contexto. Seleção de conta é separada do retorno OAuth e revalida usuário, permissões, tarefas da Página e vínculo Instagram.

Uma hipótese de revogação de grant por marca foi descartada após conferir o CHECK do banco: owner/admin sempre têm escopo organizacional neste modelo, portanto aquele cenário não era reproduzível. O resolvedor passou a explicitar também o escopo/grant e email verificado como defesa adicional. Rebaixamento de papel, usuário inativo, revogação e expiração precisam bloquear a conexão.

Foi corrigida uma corrida de resposta obsoleta: o serviço de revogação agora compara a versão de autorização da chamada que falhou antes de apagar credenciais. Uma falha de token antigo não pode apagar uma conexão mais nova. Reprodução independente offline criou uma conexão, reconectou e tentou revogar pela versão antiga; a nova conexão permaneceu ativa. O adaptador reconsulta o resolvedor após esperas assíncronas e antes de cada chamada Graph. Um registro OAuth desconectado/revogado é autoritativo e não permite fallback para credenciais estáticas antigas.

O adaptador recebe somente a prova HMAC derivada (`appsecret_proof`), sem receber o app secret do serviço OAuth; os valores não são incluídos nos DTOs. A prova também é sensível e deve ser suprimida de logs de proxy/APM.

O callback é HTTPS exato e os arquivos OAuth/chave são POSIX privados, fora do repositório; Windows falha fechado tanto para o armazenamento OAuth quanto para o arquivo legado de publicação enquanto não existir backend de segredos/ACL revisado. As rotas de autenticação do provedor podem transportar códigos, app secret ou tokens em parâmetros server-to-server conforme o contrato Graph. Esses URLs são sensíveis: nunca devem ser registrados, devolvidos à UI ou incluídos em erros. Isso é diferente do transporte de publicação, que usa Authorization no cabeçalho.

## Evidências executadas pelo revisor

Não somar como testes únicos: conjuntos podem se sobrepor.

- Inspeção direta de transporte, adaptador, serviço, worker, migrações, configuração, estratégia e renderização.
- Harness adicional offline da implementação nativa de transporte, substituindo somente DNS e `https.request`: 16 verificações passaram; zero requisições de rede. Cobriu destinos privados e mistos, pinning, ausência de segunda resolução/redirecionamento/auth/cookies, HTTPS/porta/credenciais e limite de bytes.
- `node --test --test-concurrency=1 tests/meta-provider.test.mjs tests/meta-provider-worker.test.mjs tests/qa-publication-worker.test.mjs tests/security-strategy.test.mjs tests/security-strategy-dom.test.mjs`: 59 testes passaram, sem falhas ou ignorados, no snapshot anterior à integração OAuth final.
- `node --test tests/security-publishing-config.test.mjs tests/meta-provider.test.mjs`: 34 testes passaram após a correção de caminhos.
- Reprodução descartável do arquivo estático antes/depois: HTTP 200 e marcador falso antes; startup recusado depois.
- `node --test tests/publishing-checkpoints.test.mjs`: 8 testes passaram, incluindo destino trocado após a confirmação, janela máxima de 15 minutos e impedimento de contornar resultado incerto por uma revisão nova.
- Reprodução independente de revogação OAuth obsoleta: nova versão permaneceu ativa; zero requisições externas.
- Verificação final de configuração, provedor, configuração OAuth, fluxo OAuth, integração OAuth/publicação e checkpoints: 68 testes passaram, sem falhas ou ignorados. Comando: `node --test --test-concurrency=1 tests/security-publishing-config.test.mjs tests/meta-provider.test.mjs tests/social-connections-config.test.mjs tests/social-connections.test.mjs tests/social-connections-publishing.test.mjs tests/publishing-checkpoints.test.mjs`.
- Após a última alteração de `appsecret_proof`, reexecução de `tests/meta-provider.test.mjs`, `tests/social-connections-publishing.test.mjs` e `tests/security-publishing-config.test.mjs`: 50 testes passaram, sem falhas ou ignorados.

A revisão independente de QA mantém o agregado final e a cobertura UI/HTTP em `QA-REPORT.md`. Mudanças após estes comandos exigem reexecução dos testes afetados; estes resultados não substituem o agregado final.

## Limites operacionais e autorização

1. Nenhum teste usou uma conta Meta real. Tokens de teste e HTTP substituído comprovam comportamento local, não elegibilidade de app ou integração externa bem-sucedida.
2. O worker depende do processo e do computador ativos. Persistência não significa serviço hospedado 24 horas. A janela máxima de envio é 15 minutos após o horário previsto, com rechecagem antes da publicação final e limite de cinco tentativas seguras; essa política precisa estar clara ao operador.
3. O host público precisa ser autorizado e imutável. O digest conferido antes da chamada não pode garantir que um host alterado entregue os mesmos bytes quando a Meta buscar depois.
4. Configuração legada de publicação usa arquivo privado local. Não existe validação de DACL Windows; por isso ambos os leitores de segredo reais falham fechado nessa plataforma. Nenhuma execução Windows foi verificada.
5. Uma resposta ambígua exige conferência humana da conta. Não há garantia de exactly-once fornecida pela Meta, nem resolução por semelhança de legenda/horário.
6. Publicação de um primeiro conteúdo, criação/concessão de app, upload público, credenciais, termos e implantação permanecem ações separadas, sujeitas à autorização apropriada. Construir e testar o código não as executa.
