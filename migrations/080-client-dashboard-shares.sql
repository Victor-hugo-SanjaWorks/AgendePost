-- Client-facing read-only snapshots. Bearer secrets are never persisted in cleartext.
CREATE TABLE client_dashboard_shares (
 tenant_id TEXT NOT NULL,
 workspace_id TEXT NOT NULL,
 id TEXT NOT NULL,
 token_hash TEXT NOT NULL UNIQUE CHECK(length(token_hash)=64),
 request_key_hash TEXT NOT NULL CHECK(length(request_key_hash)=64),
 label TEXT NOT NULL CHECK(length(label) BETWEEN 1 AND 100),
 created_by TEXT NOT NULL,
 created_at TEXT NOT NULL,
 expires_at TEXT NOT NULL,
 revoked_at TEXT,
 version INTEGER NOT NULL DEFAULT 1 CHECK(version>0),
 PRIMARY KEY(tenant_id,workspace_id,id),
 UNIQUE(tenant_id,workspace_id,created_by,request_key_hash),
 FOREIGN KEY(tenant_id,workspace_id) REFERENCES workspaces(tenant_id,id),
 FOREIGN KEY(tenant_id,created_by) REFERENCES memberships(tenant_id,user_id)
) STRICT;
CREATE INDEX client_dashboard_shares_scope ON client_dashboard_shares(tenant_id,workspace_id,created_at);
