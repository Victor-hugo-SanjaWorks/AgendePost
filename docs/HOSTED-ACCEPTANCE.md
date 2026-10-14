# Aceitação do AgendePost 0.4.0

## Resultado desta entrega

Preparado como **código de um piloto fechado para instalação em VPS Linux**, com controles adicionais e roteiro de operação. Não foi instalado na VPS Hostinger do usuário, e a existência do pacote não comprova DNS, certificado, liberação Meta ou atendimento comercial.

Ambiente de testes: Linux, Node.js 24.19.0, npm 11.9.0, SQLite via Node, dependências fixadas no lockfile. Nenhuma credencial real ou conta Meta foi usada. O aplicativo original Social Studio 0.2 permanece separado.

Resultado consolidado de testes: ver resumo final em `RELEASE-VERIFICATION.txt`, na raiz deste pacote.

## O que foi exercitado

- Sintaxe de todos os arquivos JavaScript.
- HTTP real em loopback, fluxos DOM com jsdom e toda a regressão editorial/comercial/publishing/OAuth já existente.
- Perfil hospedado exige opt-in, Linux, dados privados fora do repositório, canonical HTTPS e proxy local explícito.
- Host diferente, IP/proto falsificados, cadeias `X-Forwarded-For`, header host alternativo e conexões não confiáveis são recusados.
- Cookies `__Host` com `Secure`/`HttpOnly`, sessão, CSRF, expiração, revogação e limite de emissão de pré-sessões.
- Cadastro/reenvio/recuperação públicos ausentes, incluindo caminhos percent-encoded. Nenhum outbox de desenvolvimento é criado pelo perfil hospedado.
- Links do operador: cadastro, recuperação e convite; validade curta, hash persistido, invalidação de link anterior, uso único e vínculo ao destinatário.
- Dois tenants reais de teste e mídia raster normalizada: acesso cruzado e acesso anônimo recusados.
- Proxy HTTPS real **de teste em loopback**, usando certificado temporário com CA explicitamente confiada apenas pelo cliente de teste. Login, cookies seguros, origem/CSRF e encerramento de sessão. Isso não é validação de nginx ou do certificado público da VPS.
- Processo real `server.mjs` em `NODE_ENV=production` + hosted-pilot: startup, proxy obrigatório, cookie seguro, parada graciosa, reinício com o mesmo banco temporário e saída com erro quando o watchdog detecta worker indisponível.
- Readiness considera o worker atual e o heartbeat dele, sem aceitar heartbeat de outro processo. Falha de timer para o worker e readiness retorna 503.
- Backup do banco com transações em WAL, snapshot standalone, integridade e restauração em pasta nova. A origem não é alterada.
- Recuperação invalida sessões, links, convites pendentes e conexões OAuth locais, congela jobs e não dispara provedores. Marcadores impedem o startup de cópia não revisada ou falha.
- OAuth e publicação usam respostas HTTP sintéticas: nenhum teste concede permissões ou publica conteúdo real.
- Configuration ID opcional do Facebook Login for Business: validação de formato e composição da URL apenas; compatibilidade real do aplicativo ainda precisa ser confirmada.

## Novos fluxos da versão 0.4

- Compartilhamento explícito por proprietário/admin, hash de token, escopo exato de marca/tenant, expiração/revogação, leitura sem sessão e sem disparo de provedores, respostas allowlist e remoção de token do histórico da página.
- Dashboard DOM responsivo por CSS, atualização visível a cada 60s, resultados ausentes distintos de zero, timestamps reais, cancelamento de requisições antigas e limpeza após revogação/troca de contexto.
- Coleta Meta autorizada opt-in, snapshots persistentes, leases/backoff, listagem limitada da própria conta, rejeição de proprietário incorreto e rechecagem de autoridade após esperas assíncronas. Somente respostas sintéticas; detalhes em SOCIAL-METRICS.md.
- Aprovação externa: prévia exata de imagem/legenda/redes/horário, POST explícito com CSRF/challenge, revisão congelada, replay/races, agendamento atômico multicanal quando apto, bloqueio honesto quando faltar requisito e preservação da revisão interna.
- WhatsApp: payload oficial de template via transporte falso, confirmação de consentimento/destino, isolamento de remetente, idempotência concorrente, aceito diferente de entregue, ausência de segredos/telefone bruto no banco/logs e ausência de reenvio automático.
- Upgrade offline 0.3 preservando conteúdo/blobs/configuração cifrada, migração atômica e downgrade recusado. Restore 0.4 revoga links externos, desativa coleta e bloqueia replay de notificações.

## Limitações da validação local

- Não houve navegador gráfico real nem inspeção visual em dispositivos; DOM não certifica layout, acessibilidade completa ou comportamento de todos os navegadores.
- Não houve VPS Hostinger, nginx instalado, certificado público, DNS real, reboot de sistema operacional, systemd instalado ou monitoramento externo validado. Templates passaram por verificações de contrato e revisão, mas precisam de `nginx -t`, `systemd-analyze verify` e smoke test no destino.
- Um `npm ci --offline` em diretório vazio não pôde completar por falta de pacotes no cache. Os testes usaram as dependências instaladas e fixadas da base, sem mudança de versões. O programador precisa validar `npm ci` normal na arquitetura da VPS antes de ativar o serviço. Não se declara auditoria de vulnerabilidades de dependências nem instalação nova online concluída.
- Não houve benchmark de carga, pentest independente, revisão jurídica/LGPD, auditoria comercial ou garantia de uptime.
- Não houve provedor de email real, MFA, cobrança, storage público de mídia, backup off-host criptografado ou agendamento operacional dessas rotinas.
- As páginas oficiais Meta de Login for Business não puderam ser lidas nesta rodada devido a HTTP 429. A configuração atual deve ser conferida pelo programador; nenhum relato informal foi usado como comprovação de compatibilidade.

## Checklist que o programador deve concluir antes dos convites reais

- [ ] VPS correta e recursos verificados; nenhum site ou serviço existente sobrescrito
- [ ] Instalação limpa das dependências, sintaxe, testes, runtime smoke e versão Node corretos
- [ ] DNS canônico, TLS público e renovação validados
- [ ] nginx e systemd validados no próprio servidor
- [ ] Código somente leitura para o serviço; dados e segredos privados fora do código
- [ ] Apenas uma instância; bind loopback; nenhuma exposição da porta interna
- [ ] Login por convite funciona; sem contas demo, logs sensíveis ou cadastro aberto
- [ ] Teste de acesso cruzado de tenants e mídia anônima falha corretamente
- [ ] Reinício e reboot preservam dados; readiness, watchdog e alertas verificados
- [ ] Backup, restore, proteção/recuperação de chaves e cópia off-host testados
- [ ] Identidade do operador, privacidade, contato e exclusão de dados definidos e publicados quando exigidos
- [ ] Meta, métricas e WhatsApp seguem desativados até os pré-requisitos dos guias de integração serem concluídos
- [ ] Links de dashboard e aprovação testados com marca sintética; revisão/escopo/revogação/validade conferidos em celular e desktop
- [ ] Coleta real autorizada comparada com as contas de origem, incluindo posts externos e limites de cobertura
- [ ] Template/número/consentimento e uma notificação controlada WhatsApp validados se o recurso for ativado

## Checklist adicional antes de publicar qualquer conteúdo

- [ ] App principal, variante Login for Business e User-token configuration confirmados no painel/documentação atual
- [ ] Callback HTTPS exato e consentimento válido da pessoa dona da conta
- [ ] Destino social selecionado e conferido por nome/ID, permissões e prazo
- [ ] Conteúdo/revisão e destinatário social autorizados expressamente
- [ ] Apenas JPEG aprovado exposto em URL temporária; bytes/digest exatos e expiração efetiva testados
- [ ] Worker saudável e monitorado; comportamento de atraso, falha e resultado incerto conhecido
- [ ] Primeiro envio controlado autorizado, com ID remoto real verificado

Não marque itens pendentes como concluídos com base apenas em um teste offline ou em um health check 200.
