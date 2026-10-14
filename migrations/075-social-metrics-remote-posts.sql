-- Bounded recent owned posts/media, including publications made outside AgendePost.
-- No captions, media bodies, user lists, comments or provider paging URLs are stored.
CREATE TABLE social_metrics_remote_posts (
 tenant_id TEXT NOT NULL,
 workspace_id TEXT NOT NULL,
 channel_id TEXT NOT NULL,
 remote_id TEXT NOT NULL CHECK(length(remote_id) BETWEEN 1 AND 81),
 account_id TEXT NOT NULL,
 authorization_version TEXT NOT NULL,
 published_at TEXT NOT NULL,
 observed_at TEXT NOT NULL,
 permalink TEXT,
 metrics_json TEXT NOT NULL CHECK(json_valid(metrics_json)),
 PRIMARY KEY(tenant_id,workspace_id,channel_id,remote_id),
 FOREIGN KEY(tenant_id,workspace_id,channel_id) REFERENCES channels(tenant_id,workspace_id,id)
) STRICT;
CREATE TABLE social_metrics_discovery (
 tenant_id TEXT NOT NULL,
 workspace_id TEXT NOT NULL,
 channel_id TEXT NOT NULL,
 authorization_version TEXT NOT NULL,
 observed_at TEXT,
 last_attempt_at TEXT NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('partial','error','unsupported','disconnected','scope_missing')),
 code TEXT,
 returned_count INTEGER NOT NULL DEFAULT 0 CHECK(returned_count BETWEEN 0 AND 25),
 has_more INTEGER CHECK(has_more IS NULL OR has_more IN (0,1)),
 PRIMARY KEY(tenant_id,workspace_id,channel_id),
 FOREIGN KEY(tenant_id,workspace_id,channel_id) REFERENCES channels(tenant_id,workspace_id,id)
) STRICT;
CREATE TRIGGER social_metrics_remote_connection_fence AFTER UPDATE OF status,authorization_version ON social_connections
 WHEN NEW.status!='active' OR NEW.authorization_version!=OLD.authorization_version
 BEGIN
 DELETE FROM social_metrics_remote_posts WHERE tenant_id=NEW.tenant_id AND workspace_id=NEW.workspace_id AND channel_id=NEW.channel_id;
 DELETE FROM social_metrics_discovery WHERE tenant_id=NEW.tenant_id AND workspace_id=NEW.workspace_id AND channel_id=NEW.channel_id;
 END;
