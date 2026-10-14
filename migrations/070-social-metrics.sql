-- Opt-in read-only metric snapshots. Credentials remain exclusively in social_connections.
CREATE TABLE social_metrics_settings (
 tenant_id TEXT NOT NULL,
 workspace_id TEXT NOT NULL,
 enabled INTEGER NOT NULL DEFAULT 0 CHECK(enabled IN (0,1)),
 cadence_minutes INTEGER NOT NULL DEFAULT 15 CHECK(cadence_minutes BETWEEN 15 AND 1440),
 enabled_by TEXT NOT NULL,
 version INTEGER NOT NULL DEFAULT 1 CHECK(version>0),
 updated_at TEXT NOT NULL,
 PRIMARY KEY(tenant_id,workspace_id),
 FOREIGN KEY(tenant_id,workspace_id) REFERENCES workspaces(tenant_id,id),
 FOREIGN KEY(tenant_id,enabled_by) REFERENCES memberships(tenant_id,user_id)
) STRICT;
CREATE TABLE social_metrics_sync (
 tenant_id TEXT NOT NULL,
 workspace_id TEXT NOT NULL,
 channel_id TEXT NOT NULL,
 authorization_version TEXT NOT NULL,
 channel_version INTEGER NOT NULL,
 settings_version INTEGER NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('pending','syncing','ready','partial','error','disconnected','scope_missing','unsupported')),
 code TEXT,
 last_attempt_at TEXT,
 last_success_at TEXT,
 next_run_at TEXT NOT NULL,
 failure_count INTEGER NOT NULL DEFAULT 0 CHECK(failure_count>=0),
 lease_token TEXT,
 lease_until TEXT,
 PRIMARY KEY(tenant_id,workspace_id,channel_id),
 FOREIGN KEY(tenant_id,workspace_id,channel_id) REFERENCES channels(tenant_id,workspace_id,id),
 CHECK((lease_token IS NULL)=(lease_until IS NULL))
) STRICT;
CREATE INDEX social_metrics_due ON social_metrics_sync(next_run_at,lease_until);
CREATE TABLE social_metrics_accounts (
 tenant_id TEXT NOT NULL,
 workspace_id TEXT NOT NULL,
 channel_id TEXT NOT NULL,
 authorization_version TEXT NOT NULL,
 observed_at TEXT NOT NULL,
 metrics_json TEXT NOT NULL CHECK(json_valid(metrics_json)),
 PRIMARY KEY(tenant_id,workspace_id,channel_id),
 FOREIGN KEY(tenant_id,workspace_id,channel_id) REFERENCES channels(tenant_id,workspace_id,id)
) STRICT;
CREATE TABLE social_metrics_posts (
 tenant_id TEXT NOT NULL,
 workspace_id TEXT NOT NULL,
 publication_id TEXT NOT NULL,
 channel_id TEXT NOT NULL,
 authorization_version TEXT NOT NULL,
 observed_at TEXT,
 last_attempt_at TEXT NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('ready','partial','error','unsupported','disconnected','scope_missing')),
 code TEXT,
 permalink TEXT,
 metrics_json TEXT NOT NULL CHECK(json_valid(metrics_json)),
 PRIMARY KEY(tenant_id,workspace_id,publication_id),
 FOREIGN KEY(tenant_id,workspace_id,publication_id) REFERENCES publication_jobs(tenant_id,workspace_id,id),
 FOREIGN KEY(tenant_id,workspace_id,channel_id) REFERENCES channels(tenant_id,workspace_id,id)
) STRICT;
-- Fencing prevents a stale asynchronous response from surviving a disconnect or rebind.
CREATE TRIGGER social_metrics_connection_fence AFTER UPDATE OF status,authorization_version ON social_connections
 WHEN NEW.status!='active' OR NEW.authorization_version!=OLD.authorization_version
 BEGIN
 DELETE FROM social_metrics_accounts WHERE tenant_id=NEW.tenant_id AND workspace_id=NEW.workspace_id AND channel_id=NEW.channel_id;
 DELETE FROM social_metrics_posts WHERE tenant_id=NEW.tenant_id AND workspace_id=NEW.workspace_id AND channel_id=NEW.channel_id;
 DELETE FROM social_metrics_sync WHERE tenant_id=NEW.tenant_id AND workspace_id=NEW.workspace_id AND channel_id=NEW.channel_id;
 END;
