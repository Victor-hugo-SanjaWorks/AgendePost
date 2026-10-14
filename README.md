# AgendePost 0.4.0 · piloto hospedado para VPS

Pacote de código para o programador instalar na **VPS Linux da Hostinger**, com domínio **agendepost.com.br** registrado no Registro.br. Perfil limitado, por convite, de uma única instância. O pacote 0.3 entregue e o aplicativo original Social Studio 0.2 permanecem separados, sem alteração.

## Comece aqui

0. **[Atualização de 0.3 para 0.4](docs/UPGRADE-0.4.md)**: preservar dados, backup, migração offline e rollback.
1. **[Instalação na VPS](docs/HOSTINGER-DEPLOY.md)**: serviço, HTTPS, DNS, diretórios privados e testes após a instalação.
2. **[Configuração Meta](docs/META-SETUP-HOSTED.md)**: callback exato, App ID, arquivos privados e validação externa.
3. **[Contas e operação](docs/HOSTED-OPERATIONS.md)**: primeiros usuários, convites, recuperação, worker e backup.
4. **[Aceitação e testes](docs/HOSTED-ACCEPTANCE.md)**: o que foi verificado aqui e o que o programador deve confirmar na VPS.

## Novidades da versão 0.4

- **Dashboard do cliente por marca**, com resultados sociais e ação **Compartilhar dashboard**. Link de leitura revogável com validade, sem login administrativo; dados consultados a cada 60 segundos. [Guia](docs/CLIENT-DASHBOARD.md).
- Coletor Meta opt-in, no mínimo a cada 15 minutos: seguidores e contadores básicos disponíveis de Instagram/Facebook; uma página de até 25 publicações retornadas pela conta, inclusive feitas fora do AgendePost, mais o histórico local identificado. Não é tempo real nem histórico completo. Alcance, impressões e LinkedIn permanecem explicitamente não integrados. [Detalhes técnicos](docs/SOCIAL-METRICS.md).
- **Aprovações**: prévia privada de arte/legenda/redes/horário; cliente aprova ou pede ajustes. Aprovação de revisão apta cria a fila do horário combinado; requisitos pendentes aparecem com motivo. Preserva a aprovação interna exigida pela organização. [Fluxo](docs/CLIENT-APPROVALS.md).
- WhatsApp oficial opcional por template aprovado, com consentimento e confirmação de envio. Sem configuração, copiar link funciona. Não há simulação de mensagem entregue nem conexão por QR. [Configuração](docs/WHATSAPP-SETUP.md).

As novas integrações começam desligadas. Nenhum link para dados reais ou mensagem foi gerado nesta entrega. APIs externas foram testadas com respostas sintéticas; conexão e aceite reais continuam pendentes.

## Escopo real da entrega

- Backend Node.js 24.19+ da linha 24, Fastify e SQLite persistente, um processo na VPS.
- Perfil explícito `hosted-pilot`: HTTPS canônico e proxy local obrigatório; o Node continua ouvindo apenas loopback.
- Cookies `Secure`/`HttpOnly`, sessões revogáveis, CSRF, origem/Host exatos e limite de emissão de sessões anônimas.
- Acesso somente a pessoas convidadas. Sem cadastro aberto, senhas de demonstração ou caixa de email de desenvolvimento no modo hospedado.
- Marcas, conteúdos, permissões, aprovação, mídia privada, planejamento e fila durável.
- Código de OAuth e publicação Meta existente preservado, com criptografia de tokens e publicação desativada por padrão.
- Templates de nginx/systemd, backup consistente e restauração para cópia isolada que invalida sessões e congela a fila.

**Preparado para instalação e validação de um piloto controlado. Não é certificação de produção comercial.** A VPS, DNS, certificado, configuração real Meta, política de privacidade e teste real de conexão/publicação não foram executados nesta entrega. Assinaturas/cobrança continuam desativadas. Não há aprovação automática de aplicativo ou permissões da Meta.

## Requisitos

- VPS Linux com acesso administrativo do programador; Node 24.19 ou atualização compatível da linha 24 e npm.
- Disco local persistente, pelo menos 2 GiB de RAM recomendados para o piloto (scrypt e processamento de imagem consomem memória); avaliar capacidade antes de ampliar uso.
- Uma instância do aplicativo. Não usar cluster PM2, réplicas, NFS, filesystem efêmero ou rede de proxies/CDN sem revisão específica.
- nginx no mesmo host para TLS. O bind interno `127.0.0.1:4180` não deve ser publicado por firewall/NAT.
- Diretório de dados já provisionado privado, fora do código; segredos somente em arquivos privados do operador, também fora do código.

## Verificação do código

```sh
npm ci
npm run check
npm test
npm run test:hosted
npm run test:runtime
```

A suíte `hosted-https.test.mjs` usa OpenSSL disponível no Linux para criar um certificado efêmero de teste, confiado apenas pelo cliente de teste. Nenhuma autoridade de certificado é instalada no sistema. Os testes não contatam a Meta, enviam email ou publicam conteúdo real.

Para avaliação local, `npm start` usa somente `http://127.0.0.1:4180`. Para a VPS, siga o arquivo `deploy/agendepost.env.example`; ele exige opt-in explícito e não contém segredos. A instalação não consiste em subir arquivos na pasta pública de um site PHP/WordPress.

## Limites importantes

- Até 50 contas emitidas pelo operador; email transacional e MFA ainda não implementados neste corte. Identidade do destinatário verificada pelo operador antes de entregar links privados.
- SQLite usa isolamento de aplicação e chaves compostas verificadas; não oferece RLS de PostgreSQL. A separação foi testada, mas não substitui uma auditoria externa de lançamento.
- Integração de publicação limitada a uma imagem JPEG e legenda para Instagram profissional vinculado a Página e Facebook Pages. Vídeo, reels, carrosséis, stories e outras redes continuam fora do envio.
- Publicação depende de worker ativo, autorização, revisão aprovada e uma URL HTTPS temporária da imagem exata. A biblioteca privada não é exposta automaticamente.
- Backups precisam de criptografia, retenção e cópia externa operadas pelo responsável. O pacote não contrata esses serviços.
- Modo `production` sem `SOCIAL_SAAS_DEPLOYMENT=hosted-pilot` e os controles exigidos continua recusado.

Os demais documentos preservados registram a base local 0.2. Em caso de diferença operacional, use os guias de atualização/recursos 0.4 e os guias hospedados acima; os contratos de isolamento, aprovação e prevenção de duplicidade continuam válidos.
