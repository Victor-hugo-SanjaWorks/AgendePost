import { randomUUID } from 'node:crypto';
export const id = () => randomUUID();
export const statuses = ['scheduled','leased','sending','retry_wait','published','failed','blocked','cancelled','needs_attention'];
export const safeStages = ['prepared','processing','ready'];
export const plus = (now, ms) => new Date(Date.parse(now) + ms).toISOString();
export const failureMessages = {
 META_AUTH_EXPIRED:'A autorização da Meta expira antes do envio. Renove a conexão segura antes de agendar.',
 META_PERMISSION_DENIED:'A conta não possui as permissões necessárias para publicar.',
 META_CONNECTION_MISSING:'A conta Meta deste canal ainda não foi configurada pelo operador.',
 META_CONNECTION_CHANGED:'A conta ou autorização mudou. Revise o destino e faça um novo agendamento.',
 IMAGE_JPEG_REQUIRED:'Para publicar, envie e aprove uma única imagem JPEG. PNG e WebP ainda não estão habilitados.',
 IMAGE_INVALID:'A imagem aprovada é inválida ou foi alterada.',
 IMAGE_DIMENSIONS:'Para Instagram, use JPEG entre 320 e 1440 pixels de largura e proporção entre 4:5 e 1,91:1.',
 CAPTION_INVALID:'A legenda excede os limites do canal ou contém caracteres inválidos.',
 PUBLIC_ASSET_MISSING:'Disponibilize a imagem JPEG aprovada em HTTPS e configure o vínculo seguro antes de agendar.',
 PUBLIC_ASSET_EXPIRED:'A imagem HTTPS precisa continuar disponível até depois do horário de envio.',
 PUBLIC_ASSET_UNAVAILABLE:'A imagem HTTPS não está acessível. O envio será tentado novamente apenas quando for seguro.',
 PUBLIC_ASSET_DIGEST_MISMATCH:'A imagem hospedada difere da revisão aprovada. O envio foi impedido.',
 PUBLIC_ASSET_TYPE_INVALID:'A hospedagem não entregou a imagem JPEG aprovada.',
 PUBLIC_ASSET_HOST_FORBIDDEN:'A hospedagem da imagem não está autorizada na configuração segura.',
 META_RATE_LIMIT:'A Meta pediu uma pausa. Uma nova tentativa segura está programada.',
 META_CONTAINER_PROCESSING:'A Meta está preparando a imagem. Uma nova verificação está programada.',
 META_CONTAINER_ERROR:'A Meta não conseguiu preparar a imagem. Revise o arquivo.',
 META_CONTAINER_EXPIRED:'A preparação da imagem na Meta expirou. Revise e agende novamente.',
 META_PUBLISHED_ID_UNRESOLVED:'A Meta indica que houve publicação, mas não confirmou o ID da publicação. Confira a conta antes de novo envio.',
 PUBLISH_RECONCILIATION_REQUIRED:'O envio pode ter sido concluído. Confira a conta; não haverá repetição automática.',
 WORKER_INTERRUPTED_BEFORE_PUBLISH:'O processo parou antes da publicação. A preparação segura será retomada.',

 ENTITLEMENT_EXPIRES_BEFORE_SCHEDULE:'O acesso atual termina antes da data escolhida. Regularize o período de acesso ou escolha uma data anterior.',
 PUBLISHING_DISABLED:'Publicação real desativada. É necessária configuração segura do operador.',
 WORKER_UNAVAILABLE:'O processo de publicação não está ativo. Nenhum agendamento foi criado.',
 UNSUPPORTED_PLATFORM:'Este canal não aceita publicação neste corte.',
 UNSUPPORTED_FORMAT:'A publicação deste corte aceita somente uma imagem por peça. Vídeo, reel, carrossel, story e texto não estão disponíveis.',
 APPROVAL_STALE:'A revisão atual precisa de aprovação válida antes da publicação.',
 AUTHORIZATION_REVOKED:'O acesso do responsável ou do aprovador mudou. Revise as permissões e a aprovação.',
 TENANT_SUSPENDED:'A organização está suspensa para publicação.',
 WORKSPACE_ARCHIVED:'A marca está arquivada.',
 CHANNEL_UNAVAILABLE:'O canal está arquivado, foi removido da peça ou está indisponível.',
 CONNECTION_UNAVAILABLE:'Conecte e autorize a conta pelo processo seguro de configuração.',
 CONNECTION_CHANGED:'A autorização ou o destino da conta mudou. Faça um novo agendamento após revisão.',
 MEDIA_UNAVAILABLE:'A imagem aprovada não está disponível para envio.',
 PUBLIC_ASSET_REQUIRED:'O Instagram precisa de uma URL HTTPS autorizada para a imagem aprovada.',
 PUBLICATION_EXPIRED:'O prazo seguro de publicação passou. Revise a peça antes de agendar novamente.',
 RETRIES_EXHAUSTED:'O limite de tentativas seguras foi atingido.',
 PROVIDER_FAILED:'O fornecedor recusou a publicação. Revise a configuração e o conteúdo.',
 PROVIDER_AMBIGUOUS:'O fornecedor pode ter recebido a publicação. Confira a conta antes de qualquer novo envio.',
 WORKER_INTERRUPTED:'O processo parou durante um envio. Confira a conta; não haverá repetição automática.',
};
export function message(code) { return failureMessages[code] || (String(code).includes('AMBIGUOUS') || String(code).includes('RECONCILIATION') ? failureMessages.PROVIDER_AMBIGUOUS : failureMessages.PROVIDER_FAILED); }
export function safeCode(code, fallback='PROVIDER_FAILED') { return typeof code==='string' && /^[A-Z][A-Z0-9_]{1,79}$/.test(code) ? code : fallback; }
export function publicationDTO(row) { return { id:row.id,postId:row.post_id,channelId:row.channel_id,platform:row.platform,revision:row.revision,status:row.status,scheduledAt:row.scheduled_at,scheduledTimezone:row.scheduled_timezone,nextAttemptAt:row.next_attempt_at,attemptCount:row.attempt_count,maxAttempts:row.max_attempts,version:row.version,remoteId:row.remote_id,remoteUrl:row.remote_url,publishedAt:row.published_at,errorCode:row.error_code,errorMessage:row.error_code?message(row.error_code):null,createdAt:row.created_at,updatedAt:row.updated_at }; }
export function normalizeState(state) {
 if (!state || typeof state!=='object' || Array.isArray(state) || Object.keys(state).some(k=>!['containerId','stage'].includes(k)) || ![...safeStages,'publishing'].includes(state.stage) || typeof state.containerId!=='string' || !/^[\w.-]{1,200}$/.test(state.containerId)) throw new Error('INVALID_PROVIDER_STATE');
 return {containerId:state.containerId,stage:state.stage};
}
export const disabledAdapter = {enabled:false,kind:'disabled',readiness:()=>({ready:false,code:'PUBLISHING_DISABLED'}),validate:()=>({ready:false,code:'PUBLISHING_DISABLED'}),async publish(){throw new Error('PUBLISHING_DISABLED');}};
