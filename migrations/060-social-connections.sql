-- OAuth state is only a hash; authorization codes are never persisted.
CREATE TABLE social_oauth_states (
 state_hash TEXT PRIMARY KEY,
 tenant_id TEXT NOT NULL,
 workspace_id TEXT NOT NULL,
 channel_id TEXT NOT NULL,
 channel_version INTEGER NOT NULL,
 platform TEXT NOT NULL CHECK(platform IN ('facebook','instagram')),
 user_id TEXT NOT NULL,
 session_hash TEXT NOT NULL REFERENCES sessions(token_hash),
 access_basis TEXT NOT NULL CHECK(access_basis IN ('direct','business_manager')),
 created_at TEXT NOT NULL,
 expires_at TEXT NOT NULL,
 consumed_at TEXT,
 result_code TEXT,
 FOREIGN KEY(tenant_id,workspace_id,channel_id) REFERENCES channels(tenant_id,workspace_id,id),
 FOREIGN KEY(tenant_id,user_id) REFERENCES memberships(tenant_id,user_id)
) STRICT;
CREATE INDEX social_oauth_session ON social_oauth_states(session_hash,expires_at);
CREATE TABLE social_oauth_pending (
 id TEXT PRIMARY KEY,
 tenant_id TEXT NOT NULL,
 workspace_id TEXT NOT NULL,
 channel_id TEXT NOT NULL,
 channel_version INTEGER NOT NULL,
 platform TEXT NOT NULL CHECK(platform IN ('facebook','instagram')),
 user_id TEXT NOT NULL,
 session_hash TEXT NOT NULL REFERENCES sessions(token_hash),
 provider_user_id TEXT NOT NULL,
 access_basis TEXT NOT NULL CHECK(access_basis IN ('direct','business_manager')),
 encrypted_payload TEXT NOT NULL,
 created_at TEXT NOT NULL,
 expires_at TEXT NOT NULL,
 consumed_at TEXT,
 FOREIGN KEY(tenant_id,workspace_id,channel_id) REFERENCES channels(tenant_id,workspace_id,id),
 FOREIGN KEY(tenant_id,user_id) REFERENCES memberships(tenant_id,user_id)
) STRICT;
CREATE TABLE social_connections (
 id TEXT PRIMARY KEY,
 tenant_id TEXT NOT NULL,
 workspace_id TEXT NOT NULL,
 channel_id TEXT NOT NULL,
 platform TEXT NOT NULL CHECK(platform IN ('facebook','instagram')),
 provider_user_id TEXT NOT NULL,
 account_id TEXT NOT NULL,
 page_id TEXT NOT NULL,
 destination_label TEXT NOT NULL,
 token_type TEXT NOT NULL CHECK(token_type='page'),
 access_basis TEXT NOT NULL CHECK(access_basis IN ('direct','business_manager')),
 permissions TEXT NOT NULL CHECK(json_valid(permissions)),
 page_tasks TEXT NOT NULL CHECK(json_valid(page_tasks)),
 encrypted_payload TEXT,
 status TEXT NOT NULL CHECK(status IN ('active','disconnected','revoked')),
 expires_at TEXT NOT NULL,
 verified_at TEXT NOT NULL,
 version INTEGER NOT NULL DEFAULT 1 CHECK(version>0),
 authorization_version TEXT NOT NULL,
 connected_by TEXT NOT NULL,
 created_at TEXT NOT NULL,
 updated_at TEXT NOT NULL,
 disconnected_at TEXT,
 UNIQUE(tenant_id,workspace_id,channel_id),
 FOREIGN KEY(tenant_id,workspace_id,channel_id) REFERENCES channels(tenant_id,workspace_id,id),
 FOREIGN KEY(tenant_id,connected_by) REFERENCES memberships(tenant_id,user_id),
 CHECK((status='active')=(encrypted_payload IS NOT NULL))
) STRICT;
-- Database invalidation complements dynamic provider checks before each external write.
CREATE TRIGGER social_connection_fence AFTER UPDATE OF status,authorization_version ON social_connections
 WHEN NEW.status!='active' OR NEW.authorization_version!=OLD.authorization_version
 BEGIN
 UPDATE publication_jobs SET status='blocked',error_code='CONNECTION_CHANGED',version=version+1,
 lease_token=NULL,lease_owner=NULL,lease_until=NULL,updated_at=NEW.updated_at
 WHERE tenant_id=NEW.tenant_id AND workspace_id=NEW.workspace_id AND channel_id=NEW.channel_id
 AND status IN ('scheduled','retry_wait','leased');
 END;
