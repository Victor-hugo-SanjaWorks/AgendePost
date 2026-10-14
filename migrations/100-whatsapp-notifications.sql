CREATE TABLE approval_whatsapp_notifications (
 tenant_id TEXT NOT NULL,
 workspace_id TEXT NOT NULL,
 approval_id TEXT NOT NULL,
 id TEXT NOT NULL,
 request_key_hash TEXT NOT NULL CHECK(length(request_key_hash)=64),
 request_hash TEXT NOT NULL CHECK(length(request_hash)=64),
 actor_id TEXT NOT NULL,
 recipient_hash TEXT NOT NULL CHECK(length(recipient_hash)=64),
 recipient_last4 TEXT NOT NULL CHECK(length(recipient_last4)=4),
 status TEXT NOT NULL CHECK(status IN ('sending','accepted','rejected','unknown')),
 provider_message_id TEXT,
 error_code TEXT,
 created_at TEXT NOT NULL,
 updated_at TEXT NOT NULL,
 PRIMARY KEY(tenant_id,workspace_id,id),
 UNIQUE(tenant_id,workspace_id,approval_id,actor_id,request_key_hash),
 FOREIGN KEY(tenant_id,workspace_id,approval_id) REFERENCES client_approval_requests(tenant_id,workspace_id,id),
 FOREIGN KEY(tenant_id,actor_id) REFERENCES memberships(tenant_id,user_id)
) STRICT;
CREATE INDEX approval_whatsapp_scope ON approval_whatsapp_notifications(tenant_id,workspace_id,approval_id,created_at);
