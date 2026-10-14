# Atualização de 0.3 para 0.4 · programador responsável

A versão 0.4 adiciona **Dashboard do cliente**, compartilhamento de resultados, **Aprovações** externas e adaptador opcional WhatsApp. O ZIP 0.3 entregue permanece válido e separado. Esta entrega não foi instalada em uma VPS nem conectada a contas reais.

## Preservação e migrações

As migrações existentes 001–060 não foram alteradas. As novas migrações adicionam tabelas/índices/triggers para métricas, links, decisões e notificações. A primeira abertura do banco com o novo código aplica as migrações pendentes em uma transação e confere nomes/checksums. O script abaixo permite fazer isso **sem abrir HTTP ou iniciar qualquer worker**.

- Manter o mesmo `SOCIAL_SAAS_DATA_DIR` privado externo à release. Não mover dados para dentro do ZIP/repositório.
- Preservar banco, blobs de mídia (guardados no SQLite), arquivo de ambiente, arquivos OAuth e chave de criptografia. Não substituir esses arquivos pelos exemplos.
- Dependências e versões permanecem fixadas; executar `npm ci` na arquitetura da VPS em diretório novo. Não copiar `node_modules` de outra máquina.
- Atualização normal preserva sessões, dados e conexões existentes. **Ensaio de restauração é outra operação:** por segurança, a cópia restaurada revoga sessões/conexões/links e congela a fila.
- Novos tenants e configurações de coleta começam desativados. Nenhum link público é gerado automaticamente e nenhuma notificação é enviada na migração.

## Sequência segura

1. Revisar este guia, `HOSTINGER-DEPLOY.md`, `SOCIAL-METRICS.md`, `CLIENT-APPROVALS.md` e `WHATSAPP-SETUP.md`. Confirmar janela e responsáveis; não executar uma instalação inicial por cima da VPS existente.
2. Extrair em nova pasta, conferir `SHA256SUMS.txt`, Node 24.19+ linha24, `npm ci`, `npm run check`, `npm test` e `npm run test:runtime`. Nunca testar com o banco real nem credenciais reais.
3. Fazer backup consistente com `scripts/backup.mjs`. Guardar separadamente uma cópia protegida de configuração/chave. Executar `restore-check.mjs` da nova release para uma pasta de ensaio nova e privada; conferir integridade e contagens. Não promover a cópia do ensaio como atualização normal.
4. Parar o único serviço `agendepost`, aguardar encerramento gracioso e conferir que não há processo/worker em voo. Não usar `kill -9` para acelerar. Se houver tentativa externa incerta, reconciliar antes de prosseguir.
5. Fazer **novo backup consistente depois da parada**, para incluir alterações desde o ensaio. Manter o original intacto.
6. No ambiente privado, definir as novas flags `SOCIAL_SAAS_METRICS_ENABLED=false` e `SOCIAL_SAAS_WHATSAPP_ENABLED=false`. Para o primeiro startup de validação, pausar também as flags Meta/OAuth/publicação de forma explícita, sem apagar seus arquivos. Conferir o efeito sobre horários agendados e comunicar a janela à equipe. Nenhum envio deve ser reativado apenas por instalar a release.
7. Na pasta da release nova, como usuário de serviço e com o mesmo ambiente autorizado:

```sh
sudo -u agendepost /usr/local/bin/node --env-file=/etc/agendepost/agendepost.env \
  scripts/migrate.mjs --confirm-service-stopped
```

O caminho do Node deve corresponder à VPS. `--confirm-service-stopped` é a declaração do operador, não detecção de processos. O comando só migra e verifica o banco; não inicia rede, aplicação ou coleta. Saída esperada: `migrated_offline`, `networkStarted:false`, `workersStarted:false`. Em qualquer erro, não iniciar o serviço e não editar checksums para contornar.

8. Trocar o symlink de release controlado pelo operador e iniciar uma única instância. Não substituir arquivos de nginx/systemd/configuração sem revisão. Revalidar `/health/live`, `/health/ready`, login, seleção de organização/marca, conteúdo/mídia e os fluxos abaixo. Observar erros e armazenamento.
9. Reativar somente integrações previamente autorizadas após reconciliação. Antes da coleta nova, o operador habilita a flag de métricas e o proprietário da organização habilita explicitamente cada marca. Antes de WhatsApp, completar seu guia específico. Não pedir segredos em conversas.

## Aceitação funcional com marca sintética

- Abrir **Dashboard do cliente**. Confirmar nome/marca/canais corretos e ausência de dados privados de outra marca.
- Indicadores ausentes aparecem indisponíveis; LinkedIn e insights avançados não viram números inventados. Conferir horário real da coleta e cobertura dos posts.
- Proprietário/admin escolhe **Compartilhar dashboard**, confirma que o portador poderá ver atualizações, seleciona validade e copia. Abrir em navegador sem sessão: somente resultados. Revogar e confirmar que o mesmo link perde acesso e limpa a tela. Não copiar esse link em log/ticket público.
- Preparar uma imagem JPEG/legenda no editor e aprovação interna. Para envio Meta, configurar separadamente a URL HTTPS temporária da imagem exata; o aplicativo não publica a biblioteca privada nem hospeda automaticamente os assets para Meta. Em **Aprovações**, escolher redes/data/fuso, gerar link; conferir a imagem, texto, destino e horário na prévia sem login.
- Abrir o link não decide nada. Solicitar ajustes não agenda. Aprovar uma revisão apta cria exatamente a fila prevista; repetir clique não duplica. Alterar conteúdo/data invalida o pedido; data passada exige novo pedido.
- Com publicação propositalmente desligada, a aprovação fica registrada com **bloqueio explícito**, nunca como “agendada”. Uma fila válida ainda não é comprovação de postagem real.
- WhatsApp sem configuração oferece copiar link. Com configuração autorizada, fazer somente um envio de teste consentido e conferir aceitação/entrega no canal correto. Não há webhook de entrega no pacote.

## Rollback e recuperação

O código 0.3 **recusa** abrir um banco com migrações 0.4. Trocar apenas o symlink de volta não é rollback de banco. Preferir correção para frente ou, se necessário, recuperação do backup em diretório novo com `restore-check.mjs`, seguindo integralmente a revisão de recuperação de `HOSTINGER-DEPLOY.md`. Não copiar um SQLite antigo por cima do ativo, não remover registros de migração e não reexecutar filas cegamente.

A recuperação 0.4 também revoga links de dashboard/aprovação, remove desafios públicos, desativa coleta, remove leases e marca tentativas WhatsApp em voo como desconhecidas. Revisar mensagens/publicações que possam ter ocorrido depois do snapshot. Credenciais privadas fora do banco precisam permanecer desligadas e ser revisadas separadamente.

## O que os testes demonstram

Testes de upgrade criam banco com migrações 0.3, inserem tenants, conteúdo, mídia e credencial **sintética**, aplicam 0.4 e comparam todas essas linhas. Também cobrem repetição segura, bloqueio de downgrade e rollback atômico de uma migração com erro. Isso não substitui backup/ensaio do banco real. Resultados finais do pacote estão em `RELEASE-VERIFICATION.txt`.
