CREATE TABLE users (
 id TEXT PRIMARY KEY, email_normalized TEXT NOT NULL UNIQUE, display_name TEXT NOT NULL,
 password_hash TEXT, email_verified_at TEXT, status TEXT NOT NULL CHECK(status IN ('pending','active','blocked')),
 session_epoch INTEGER NOT NULL DEFAULT 0 CHECK(session_epoch>=0), created_at TEXT NOT NULL,
 CHECK((status='pending' AND password_hash IS NULL AND email_verified_at IS NULL) OR (status IN ('active','blocked') AND password_hash IS NOT NULL AND email_verified_at IS NOT NULL))
) STRICT;
CREATE TABLE sessions (
 token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), csrf_token TEXT NOT NULL,
 created_at TEXT NOT NULL,last_seen_at TEXT NOT NULL,expires_at TEXT NOT NULL,absolute_expires_at TEXT NOT NULL,
 revoked_at TEXT,auth_at TEXT NOT NULL,session_epoch INTEGER NOT NULL
) STRICT;
CREATE INDEX sessions_user ON sessions(user_id);
CREATE TABLE preauth_sessions(token_hash TEXT PRIMARY KEY,csrf_token TEXT NOT NULL,created_at TEXT NOT NULL,expires_at TEXT NOT NULL) STRICT;
CREATE TABLE auth_tokens(token_hash TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id),purpose TEXT NOT NULL CHECK(purpose IN ('email_verify','password_reset')),created_at TEXT NOT NULL,expires_at TEXT NOT NULL,consumed_at TEXT) STRICT;
CREATE INDEX auth_tokens_user ON auth_tokens(user_id,purpose);
CREATE TABLE tenants(id TEXT PRIMARY KEY,name TEXT NOT NULL,slug TEXT NOT NULL UNIQUE,timezone TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','suspended')),require_independent_approval INTEGER NOT NULL DEFAULT 1 CHECK(require_independent_approval IN (0,1)),version INTEGER NOT NULL DEFAULT 1,created_at TEXT NOT NULL,updated_at TEXT NOT NULL) STRICT;
CREATE TABLE memberships(tenant_id TEXT NOT NULL REFERENCES tenants(id),user_id TEXT NOT NULL REFERENCES users(id),role TEXT NOT NULL CHECK(role IN ('owner','admin','editor','reviewer','viewer')),status TEXT NOT NULL CHECK(status IN ('active','inactive')),scope TEXT NOT NULL CHECK(scope IN ('organization','workspaces')),version INTEGER NOT NULL DEFAULT 1,created_at TEXT NOT NULL,PRIMARY KEY(tenant_id,user_id),CHECK((role IN ('owner','admin') AND scope='organization') OR (role IN ('editor','reviewer','viewer') AND scope='workspaces'))) STRICT;
CREATE INDEX memberships_user ON memberships(user_id,status);
CREATE TABLE workspace_grants(tenant_id TEXT NOT NULL,workspace_id TEXT NOT NULL,user_id TEXT NOT NULL,PRIMARY KEY(tenant_id,workspace_id,user_id),FOREIGN KEY(tenant_id,user_id) REFERENCES memberships(tenant_id,user_id),FOREIGN KEY(tenant_id,workspace_id) REFERENCES workspaces(tenant_id,id)) STRICT;
CREATE TABLE invitations(id TEXT PRIMARY KEY,tenant_id TEXT NOT NULL REFERENCES tenants(id),email_normalized TEXT NOT NULL,role TEXT NOT NULL CHECK(role IN ('owner','admin','editor','reviewer','viewer')),scope TEXT NOT NULL CHECK(scope IN ('organization','workspaces')),token_hash TEXT NOT NULL UNIQUE,expires_at TEXT NOT NULL,accepted_at TEXT,revoked_at TEXT,invited_by TEXT NOT NULL REFERENCES users(id),created_at TEXT NOT NULL,CHECK((role IN ('owner','admin') AND scope='organization') OR (role IN ('editor','reviewer','viewer') AND scope='workspaces')),UNIQUE(tenant_id,id)) STRICT;
CREATE UNIQUE INDEX invitations_active ON invitations(tenant_id,email_normalized) WHERE accepted_at IS NULL AND revoked_at IS NULL;
CREATE TABLE invitation_grants(tenant_id TEXT NOT NULL,invitation_id TEXT NOT NULL,workspace_id TEXT NOT NULL,PRIMARY KEY(tenant_id,invitation_id,workspace_id),FOREIGN KEY(tenant_id,invitation_id) REFERENCES invitations(tenant_id,id),FOREIGN KEY(tenant_id,workspace_id) REFERENCES workspaces(tenant_id,id)) STRICT;
CREATE TABLE audit_events(id TEXT PRIMARY KEY,tenant_id TEXT REFERENCES tenants(id),actor_id TEXT REFERENCES users(id),action TEXT NOT NULL,target_type TEXT NOT NULL,target_id TEXT,outcome TEXT NOT NULL CHECK(outcome IN ('success','denied','failure')),safe_changes TEXT NOT NULL DEFAULT '{}',request_id TEXT,created_at TEXT NOT NULL) STRICT;
CREATE INDEX audit_events_tenant ON audit_events(tenant_id,created_at);
CREATE TRIGGER audit_no_update BEFORE UPDATE ON audit_events BEGIN SELECT RAISE(ABORT,'audit append-only'); END;
CREATE TRIGGER audit_no_delete BEFORE DELETE ON audit_events BEGIN SELECT RAISE(ABORT,'audit append-only'); END;
CREATE TABLE idempotency_keys(tenant_id TEXT NOT NULL,actor_id TEXT NOT NULL REFERENCES users(id),method TEXT NOT NULL,route TEXT NOT NULL,key TEXT NOT NULL,request_hash TEXT NOT NULL,result_ref TEXT NOT NULL,expires_at TEXT NOT NULL,PRIMARY KEY(tenant_id,actor_id,method,route,key)) STRICT;
CREATE TABLE mail_outbox(id TEXT PRIMARY KEY,to_email TEXT NOT NULL,purpose TEXT NOT NULL,payload_json TEXT NOT NULL,created_at TEXT NOT NULL,expires_at TEXT NOT NULL) STRICT;
CREATE INDEX mail_outbox_expiry ON mail_outbox(expires_at);
