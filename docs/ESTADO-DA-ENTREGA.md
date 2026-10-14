> Base histórica do piloto local 0.2, preservada para referência técnica. Para instalar o AgendePost 0.3 na VPS, use HOSTINGER-DEPLOY.md, HOSTED-OPERATIONS.md e META-SETUP-HOSTED.md. As antigas restrições operacionais de perfil local não descrevem o opt-in hospedado; os controles de isolamento e publicação permanecem válidos.

# Social Studio — piloto multiusuário 0.1.0

Nome provisório. Este projeto é separado do MVP local anterior. O objetivo é validar a base do futuro SaaS comercial antes da operação pública.

## O que esta versão permite validar

- Cadastro com verificação de email simulada em caixa de desenvolvimento, definição de senha, login, recuperação e revogação de sessões.
- Organizações isoladas, marcas, equipe, convites e permissões por marca.
- Conteúdos com revisões, comentários, solicitação de revisão, aprovação e planejamento de data. Aprovação independente é a regra inicial.
- Imagens privadas PNG, JPEG e WebP estáticas, reprocessadas pelo servidor.
- Relatórios internos, exportação e cópia de segurança operacional.
- Planos técnicos e limites, testes de acesso temporário e administração operacional separada do conteúdo dos clientes.

A lista descreve o escopo implementado; os resultados e limitações de validação constam nos relatórios de testes da entrega. Não confundir uma tela ou integração simulada com serviço externo ativo.

## O que não está ativo

- Publicação em Facebook, Instagram ou outras redes; um conteúdo planejado não será publicado sozinho.
- Cobranças, checkout, assinatura comercial, emissão fiscal ou contas reais em provedores de pagamento.
- Envio de emails pela internet. Links de teste ficam disponíveis apenas ao operador no terminal.
- Hospedagem pública, domínio, infraestrutura de produção ou aplicativo Windows compilado.
- Métricas de redes sociais: relatórios desta versão são de produção editorial interna.

## Próxima etapa para vender

1. Validar os fluxos e a experiência do piloto, incluindo navegador real e Windows.
2. Definir marca, planos, preços e condições comerciais. Pautiva foi descartado por conflito identificado; os nomes alternativos ainda não têm validação de marca ou domínio.
3. Preparar PostgreSQL e isolamento de produção, HTTPS, armazenamento privado, email transacional, autenticação adicional, monitoramento, restauração e revisão independente de segurança.
4. Conectar provedores oficiais e redes sociais com as autorizações exigidas, testar ambientes de homologação e validar os processos de cobrança, cancelamento e publicação.
5. Revisar termos e privacidade e realizar piloto controlado antes da venda pública.

Nenhum serviço pago foi contratado e nenhuma conta externa foi conectada para esta entrega. Os limites técnicos atuais não constituem oferta comercial nem capacidade de produção comprovada.

## Cuidados durante o teste

Use dados fictícios. Mantenha o serviço no endereço de loopback configurado e não abra portas ou túneis públicos. Não coloque segredos de provedores no código ou no navegador. O backup operacional contém dados de todas as organizações do piloto e exige armazenamento privado. A exportação de uma organização tem escopo diferente do backup completo do operador.
