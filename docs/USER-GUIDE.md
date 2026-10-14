> Base histórica do piloto local 0.2, preservada para referência técnica. Para instalar o AgendePost 0.3 na VPS, use HOSTINGER-DEPLOY.md, HOSTED-OPERATIONS.md e META-SETUP-HOSTED.md. As antigas restrições operacionais de perfil local não descrevem o opt-in hospedado; os controles de isolamento e publicação permanecem válidos.

# Guia de uso do piloto Social Studio

Social Studio é um nome de trabalho. Este aplicativo separado é um piloto SaaS multiusuário, executado localmente para avaliação controlada. Não é um serviço público pronto para receber clientes ou cobrar. Não modifica o aplicativo local anterior.

## 1. Abrir o piloto

O operador deve seguir o README do projeto, instalar as dependências fixadas e iniciar o servidor com Node.js 24.19.0:

```sh
cd social_saas
npm ci
npm start
```

Abra o endereço de loopback informado no terminal. Não abra o arquivo HTML diretamente: login, autorização e dados dependem do servidor. Não publique o piloto, exponha portas ou configure túneis sem uma revisão de lançamento e autorização específicas.

A página inicial descreve somente os recursos implementados. O catálogo vem da API e mostra limites técnicos, sem preços inventados. “Criar acesso ao piloto” inicia o cadastro real.

## 2. Cadastro e verificação local

1. Clique em **Criar acesso ao piloto** e informe nome e email.
2. A resposta é genérica para proteger a existência de contas. **Nenhum email externo é enviado.**
3. No terminal do operador, consulte o link de desenvolvimento para esse endereço:

   ```sh
   npm run dev:mail -- --email pessoa@example.test --latest
   ```

4. Abra o link no navegador do piloto e defina uma senha entre 15 e 128 caracteres.
5. Depois da verificação, entre com o email e a senha. Não há login automático pelo link.

A caixa de saída é exclusiva do operador local. Seus links de teste dão acesso a fluxos de autenticação e não devem ser compartilhados, incluídos em capturas ou entregues a terceiros. Não existe uma página HTTP pública para consultar esses links.

O token do link é retirado do endereço antes de qualquer solicitação à API e fica somente na memória da aba. Se recarregar uma página de verificação, recuperação ou convite antes de concluir, reabra o link original. Links consumidos ou expirados precisam ser renovados.

A recuperação de senha segue o mesmo fluxo local. Uma redefinição encerra as sessões anteriores. Nenhuma senha ou credencial é armazenada no localStorage.

## 3. Criar a organização e a primeira marca

A primeira entrada de uma conta sem organizações abre o formulário de criação. Informe o nome da organização e um fuso IANA, por exemplo `America/Sao_Paulo`.

A organização começa vazia, sem clientes, métricas ou conteúdos de exemplo. O criador recebe o papel de proprietário. A revisão independente vem ativada.

Em **Marcas e canais**, crie sua primeira marca e, se desejar, alvos editoriais para Instagram, Facebook, LinkedIn, TikTok, YouTube ou Pinterest. Esses alvos são referências de planejamento. **Não conectam nem autenticam contas sociais.** A tela **Conexões sociais** mostra, por marca, se o operador configurou um destino real e uma autorização válida. Instagram e Facebook têm adaptador de publicação; as demais redes permanecem somente editoriais.

Use o seletor de organização no menu e o seletor de marca no topo para mudar de contexto. A autorização real é aplicada pelo servidor, inclusive para imagens, listagens e downloads.

## 4. Criar e revisar conteúdos

Em **Conteúdos**, clique em **Criar conteúdo**:

- Preencha o título interno e a legenda.
- Escolha o formato editorial. Vídeo e reel são formatos de planejamento; o piloto recebe somente arquivos de imagem.
- Adicione até 20 tags internas, separadas por vírgula.
- Selecione alvos editoriais desta marca e até 10 imagens da biblioteca.
- Salve o rascunho no servidor.

Cada edição salva gera uma nova revisão e invalida a aprovação anterior. Comentários identificam o autor autenticado. O histórico mostra o texto de cada revisão e as decisões vinculadas a ela.

O fluxo é:

1. Editor, administrador ou proprietário salva e solicita revisão.
2. Revisor, administrador ou proprietário aprova a revisão ou pede ajustes, com um motivo.
3. Com revisão independente ativada, o autor da revisão não pode aprová-la, mesmo sendo proprietário.
4. Depois da aprovação, editor, administrador ou proprietário pode definir uma intenção de data ou usar **Agendar publicação** para autorizar um envio automático a destinos realmente habilitados. São ações separadas.

Aprovação e planejamento usam a revisão esperada. Se outra pessoa alterou o conteúdo, o servidor recusa a gravação conflitante. A interface preserva o texto local no formulário e oferece recarregar a versão atual. **Copie suas alterações antes de escolher recarregar.** Não há mesclagem automática.

A interface também pede confirmação antes de sair de um editor com alterações não salvas. Um rascunho ainda não salvo existe somente na aba, não no servidor.

Arquivar retira a peça das listas ativas. O filtro **Arquivado** permite encontrá-la. Restaurar gera uma nova revisão de rascunho sem aprovação e sem planejamento. Duplicar cria outro rascunho, sem copiar a aprovação ou a intenção de data.

## 5. Planejar a data com fuso correto

O formulário de planejamento pede:

- Data e hora local
- Fuso IANA
- Offset da data, por exemplo `-03:00`

O offset sugerido corresponde ao fuso no momento atual. Revise-o se a data escolhida estiver em outro período de horário de verão. O servidor confere a combinação e recusa horários inexistentes ou offsets incompatíveis. Em horários ambíguos, a escolha do offset identifica explicitamente qual instante foi pretendido.

O calendário apresenta os conteúdos no fuso da organização. Itens sem data continuam em **Conteúdos**. Se houver paginação, carregue os próximos itens para completar o mês.

**Planejado significa intenção editorial. Esta ação não cria nenhum envio real.** Para envio automático, use **Agendar publicação**, conforme a próxima seção. O calendário editorial mostra intenções; a fila **Agendamentos** mostra os envios reais.

## 5A. Agendar a publicação automática

A função está implementada com fila persistida no servidor. Ela vem **desabilitada por padrão**. Sem configuração real do operador, autorização dos destinos e processo de envio ativo, a interface mostra os bloqueios e não permite agendar. Não há contas conectadas, autorizações, servidor hospedado ou publicações de demonstração presumidos.

### Conferir a ativação

1. Escolha a organização e a marca corretas no menu e no topo.
2. Abra **Conexões sociais**. Confira a mensagem geral, o estado do processo de envio e o diagnóstico de cada canal.
3. Um alvo editorial não é uma conta autenticada. O operador precisa preparar a configuração segura do aplicativo Meta. Quando o servidor estiver configurado, proprietários e administradores podem usar **Conectar pela Meta** em cada canal. Sem essa configuração, os botões permanecem desabilitados e a tela mostra os bloqueios.
4. A conexão precisa de um destino exato e autorização válida: conta profissional no Instagram ou Página do Facebook. O arquivo JPEG aprovado também precisa ter um endereço HTTPS autorizado, acessível à Meta, com o mesmo conteúdo conferido pelo adaptador.
5. Clique em **Atualizar situação** depois da configuração. Uma indicação de prontidão é uma verificação das condições atuais; não equivale à confirmação de uma publicação.

O procedimento de conexão e proteção das credenciais fica em [OAuth Meta](META-OAUTH.md). A configuração do adaptador e das imagens está em [Integração Meta](META-INTEGRATION.md). O operador deve concluir esse procedimento e verificar os bloqueios antes de habilitar o adaptador; um arquivo de exemplo não é uma conexão válida.

Não cole senhas, tokens sociais, segredos de aplicativo ou credenciais em chats, legendas ou comentários. O arquivo de configuração do operador não deve entrar no repositório, nas capturas ou em anexos de suporte.

### Conectar a conta pela Meta

O fluxo OAuth está implementado, mas exige um aplicativo Meta real, origem HTTPS autorizada, cookies seguros e armazenamento protegido das chaves no servidor. Nesta entrega, os arquivos privados de chave OAuth são aceitos somente em ambiente POSIX; o inicializador local do Windows não habilita essa integração. A implantação pública continua bloqueada até revisão e autorização de infraestrutura. Configuração de exemplo e testes sintéticos não comprovam conexão real.

A conexão requer papel de proprietário ou administrador e autenticação recente. Se o formulário pedir, use **Confirmar identidade** no próprio aplicativo e repita a ação.

1. Confira a marca no topo e clique em **Conectar pela Meta** no canal desejado.
2. Para Instagram, informe explicitamente se o acesso é direto à Página vinculada ou pelo portfólio empresarial / Business Manager. O segundo caso requer a permissão adicional `ads_read`; se não souber, confirme com o responsável pela conta.
3. Clique em **Preparar autorização**. O servidor gera um link temporário vinculado à sua sessão, à organização, à marca e ao canal.
4. Clique em **Autorizar na Meta** e confira as permissões no site oficial da Meta. Não compartilhe esse link. O aplicativo não pede sua senha da Meta.
5. Depois do retorno, confira a marca recuperada pelo aplicativo. Clique em **Escolher destino** e selecione explicitamente a Página ou a conta profissional elegível. Revise o nome e o identificador real mostrado.
6. Marque a confirmação e clique em **Conectar este destino**. A autorização é revalidada e o acesso é salvo de forma criptografada no servidor. A tela só passa a mostrar uma conexão associada após a confirmação do servidor.
7. Confira separadamente a **prontidão de publicação**. Conta conectada não elimina os requisitos da imagem, aprovação e processo de envio.

Se a Meta recusar a autorização, se você cancelar, se a seleção expirar ou se as permissões não forem suficientes, a tela informa o estado. Nenhuma conta é conectada por simulação. O servidor rejeita retornos de outra sessão, destinos fora do acesso autorizado e alterações conflitantes do canal.

Para remover o acesso local, use **Desconectar**. A confirmação identifica a conta e explica o impacto: as credenciais salvas desse canal são removidas e os envios ainda não iniciados são bloqueados. Um envio já iniciado pode concluir. Publicações já feitas permanecem na rede social. A autorização geral do aplicativo deve ser administrada separadamente nas configurações da Meta; removê-la lá pode afetar outras marcas e canais.

### Criar um envio

1. Na biblioteca da marca, adicione a imagem JPEG que será realmente publicada.
2. Salve o conteúdo com formato **Imagem**, exatamente uma imagem e os alvos Instagram/Facebook desejados. PNG e WebP continuam válidos para a biblioteca e o planejamento, mas o primeiro adaptador real aceita somente JPEG. Vídeos, reels, stories, carrosséis, texto isolado e outras redes não são publicados nesta versão.
3. Solicite e obtenha a aprovação da versão atual. Alterações não salvas ou revisões sem aprovação bloqueiam o agendamento.
4. No painel **Publicação automática** do conteúdo, clique em **Agendar publicação**.
5. Revise os destinos reais, a revisão aprovada, a data e a hora local e o fuso IANA. O offset é calculado para a **data escolhida**, inclusive quando ela estiver em outro período de horário de verão. Horários inexistentes são recusados. Se houver duas possibilidades de offset, escolha a correta explicitamente.
6. O envio deve ficar no futuro e em até 90 dias. Confira o instante UTC mostrado e marque a confirmação dos destinos, da versão e da data. Clique em **Agendar publicação**.
7. A confirmação indica que os envios foram colocados na fila do servidor. **Não indica que já foram publicados.** Abra **Agendamentos** para acompanhar o resultado por canal.

O servidor confere novamente aprovação, acesso à marca, autorização do destino e mídia. Os destinos são agendados em conjunto ou nenhum é criado. Cada canal terá um resultado independente depois do envio. O rascunho não é alterado silenciosamente para atender ao provedor: corrija a imagem ou o texto, salve uma nova versão e peça outra aprovação quando necessário.

### Acompanhar, alterar ou cancelar

- **Agendado:** aguarda a data e a verificação final.
- **Preparando envio:** o processo reservou o item. Alterar ou cancelar ainda exige confirmação do servidor de que o envio não começou.
- **Enviando:** a chamada à rede social começou. Não há promessa de cancelamento remoto.
- **Nova tentativa segura:** o adaptador comprovou que não houve publicação. O sistema programa a próxima tentativa dentro do limite exibido.
- **Publicado:** a rede social confirmou a publicação com um identificador remoto. Um link só aparece quando o servidor fornece um endereço verificado.
- **Falha confirmada / Bloqueado:** leia o motivo. Não há repetição manual cega nesta tela.
- **Conferência necessária:** o resultado é incerto, por exemplo após uma interrupção durante o envio. A publicação pode existir na rede social. Confira a conta antes de qualquer outra ação. O sistema não repete automaticamente o envio ambíguo.
- **Cancelado:** o servidor confirmou o cancelamento antes do início do envio. Isso não exclui publicações feitas anteriormente na rede social.

Use **Alterar data** ou **Cancelar envio** apenas quando essas ações aparecerem. Se o envio começar enquanto o formulário estiver aberto, o servidor pode recusar a ação para evitar uma confirmação falsa. As mutações conferem a versão atual da entrada na fila. A fila e o painel do conteúdo atualizam situações ativas a cada 15 segundos enquanto a aba estiver visível; também há **Atualizar situação**.

### Limite operacional importante

O processo de envio roda junto do aplicativo local. **O servidor precisa continuar em execução e o computador precisa permanecer acordado.** Fechar apenas a aba não cancela a fila. Desligar ou suspender o servidor impede o envio no horário previsto. A fila fica persistida e o processo revalida condições ao retomar. Se não puder iniciar o envio em até **15 minutos após o horário marcado**, o item falha visivelmente e exige um novo agendamento; não é publicado silenciosamente no dia seguinte. Uma interrupção durante o envio pode exigir conferência manual. Não existe hospedagem 24 horas incluída, e os bloqueios de lançamento público continuam vigentes.

## 6. Biblioteca privada

Aceita JPEG, PNG e WebP estáticas, com até 5 MiB de entrada, 25 megapixels e 10.000 pixels por dimensão. O servidor decodifica e regrava os pixels, removendo metadados. A quota considera os bytes normalizados armazenados.

A biblioteca é exclusiva de uma marca. Downloads exigem sessão e permissão atuais. Uma imagem usada por um conteúdo ou por uma revisão retida não pode ser excluída, para preservar o histórico.

## 7. Equipe, convites e permissões

Proprietários e administradores encontram **Equipe e acesso** no menu. Um convite exige email, papel e, para papéis limitados, marcas específicas.

- **Proprietário:** gerencia a organização, incluindo outros proprietários e administradores; sempre deve existir ao menos um proprietário ativo.
- **Administrador:** acessa todas as marcas e gerencia editores, revisores e leitores.
- **Editor:** cria, altera, comenta, solicita revisão, planeja e agenda a publicação de versões aprovadas nas marcas concedidas, quando os destinos estão habilitados.
- **Revisor:** consulta, comenta, aprova ou pede ajustes nas marcas concedidas.
- **Leitor:** apenas consulta as marcas concedidas.

O convite fica na caixa de saída local do operador. Nenhum email é enviado. A pessoa precisa entrar com uma conta verificada do mesmo email para aceitá-lo. Convites válidos não aceitos já consomem um assento. Gerar outro link invalida o anterior; revogar impede o aceite.

Alterações de acesso passam a valer na próxima solicitação. O seletor visual não concede acesso. Papéis e permissões são novamente verificados no servidor.

Algumas ações de maior consequência exigem autenticação recente. Use **Confirmar identidade**, informe a senha e repita a ação. O formulário informa quando isso é necessário.

## 8. Dashboard, exportação e consumo

**Dashboard** reúne análises por marca, contagens editoriais e ferramentas de estratégia. Dados sociais reais dependem de fontes verificáveis; alcance, seguidores e engajamento não são inventados. A visão de envios por canal permanece em **Agendamentos**.

No **Dashboard**, selecione a marca e o período da produção interna. As contagens, o ritmo de criação e os mixes de formatos e destinos vêm dos registros reais da marca; não representam alcance ou desempenho de publicações sociais.

A **Matriz FOFA** separa forças, fraquezas, oportunidades e ameaças. Os sinais automáticos mostram a regra de cálculo e os registros editoriais usados. A equipe pode adicionar análises, marcar hipóteses ou evidências informadas e registrar fonte, data e contexto. Oportunidades e ameaças externas não são inventadas pelo sistema. Analise a procedência antes de tratar uma observação como fato.

Em **Concorrentes**, registre referências e observações da equipe, incluindo fonte e data. Seguidores e frequência de publicações são dados informados, não uma coleta automática. Ausência de informação aparece como ausência, nunca como zero ou estimativa. Dados de períodos ou fontes diferentes podem não ser comparáveis. O filtro de produção no topo não altera a data própria de observação de cada concorrente.

As análises e referências ficam persistidas por marca, respeitam permissões e controle de versão, e podem ser editadas ou arquivadas conforme o acesso. Uma marca nova começa sem concorrentes ou análises de exemplo.

Proprietário e administrador podem exportar dados editoriais para JSON. A exportação inclui metadados do escopo autorizado; não é backup do servidor, não contém credenciais ou dados de cobrança e não inclui os bytes das imagens. O servidor aplica limites de volume explícitos.

**Plano e uso** consulta os limites e o consumo reais. O plano inicial é uma concessão manual de avaliação, nunca um pagamento confirmado. Os presets técnicos não são promessas comerciais. Exceder limites impede aumentar o recurso excedido e não apaga dados existentes.

Não há cartão, checkout, assinatura ou portal de cobrança ativos. Os preços ainda serão definidos.

## 9. Configurações, conta e administração

Em **Configurações**, os gestores podem alterar nome e fuso da organização. Somente o proprietário pode mudar a revisão independente; essa mudança exige motivo e autenticação recente e é auditada.

A senha pode ser alterada informando a senha atual. A ação encerra as sessões. Também é possível sair desta sessão ou encerrar todas as sessões.

A área **Operação da plataforma** aparece somente para uma conta com o privilégio separado de administrador da plataforma atribuído pela operação local. Ela mostra metadados e contagens, sem conferir acesso editorial a clientes. Concessões técnicas exigem prazo, motivo e autenticação recente. Não representam pagamento.

## 10. Limites de avaliação e solução de problemas

- **Servidor inacessível:** confira se o processo local está em execução e se o endereço é o informado pelo operador.
- **Sessão encerrada:** entre novamente. Reabra o link original de convite se necessário.
- **Acesso não permitido:** o papel ou a marca concedida pode ter mudado. Não tente contornar o controle pela URL.
- **Conflito de versão:** preserve seu texto e carregue a versão atual antes de reaplicar as alterações.
- **Limite atingido:** consulte Plano e uso. A exclusão de dados não é feita automaticamente.
- **Link ausente após recarregar:** reabra o link original. O token foi removido intencionalmente do endereço.
- **Email não recebido:** este piloto não envia emails; use o comando local do operador.
- **Publicação desabilitada / destino indisponível:** consulte **Conexões sociais** e o diagnóstico do servidor. A criação de um canal não concede autorização social.
- **Resultado de envio incerto:** consulte a conta real; não tente duplicar ou repetir um envio em conferência necessária.
- **JPEG ou endereço público ausente:** o operador precisa conferir o arquivo aprovado e o destino de mídia, sem converter ou trocar a imagem silenciosamente.
- **Validação recusada:** revise os campos. Datas precisam combinar horário, fuso e offset; imagens precisam estar no formato e limite aceitos.

O piloto precisa de validação visual em navegador real e dos demais gates de segurança, infraestrutura, operação e produto antes de lançamento público. Os testes de DOM exercitam interações e APIs, mas não substituem verificação de layout, acessibilidade assistiva e comportamento em dispositivos reais.
