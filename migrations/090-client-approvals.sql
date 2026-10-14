-- Client consent is deliberately separate from authenticated internal approvals.
CREATE TABLE client_approval_requests (
 tenant_id TEXT NOT NULL,
 workspace_id TEXT NOT NULL,
 id TEXT NOT NULL,
 post_id TEXT NOT NULL,
 revision INTEGER NOT NULL CHECK(revision>0),
 requester_id TEXT NOT NULL,
 token_hash TEXT NOT NULL UNIQUE CHECK(length(token_hash)=64),
 snapshot_digest TEXT NOT NULL CHECK(length(snapshot_digest)=64),
 preview_json TEXT NOT NULL CHECK(json_valid(preview_json)),
 channel_ids_json TEXT NOT NULL CHECK(json_valid(channel_ids_json)),
 connection_versions_json TEXT NOT NULL CHECK(json_valid(connection_versions_json)),
 scheduled_at TEXT NOT NULL,
 scheduled_timezone TEXT NOT NULL,
 source_scheduled_at TEXT,
 source_scheduled_timezone TEXT,
 status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','changes_requested','revoked','invalidated')),
 scheduling_status TEXT NOT NULL DEFAULT 'awaiting_client' CHECK(scheduling_status IN ('awaiting_client','not_requested','blocked','scheduled','cancelled')),
 scheduling_code TEXT,
 publication_ids_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(publication_ids_json)),
 feedback TEXT CHECK(feedback IS NULL OR length(feedback)<=2000),
 version INTEGER NOT NULL DEFAULT 1 CHECK(version>0),
 created_at TEXT NOT NULL,
 expires_at TEXT NOT NULL,
 decided_at TEXT,
 revoked_at TEXT,
 updated_at TEXT NOT NULL,
 PRIMARY KEY(tenant_id,workspace_id,id),
 FOREIGN KEY(tenant_id,workspace_id,post_id,revision) REFERENCES post_revisions(tenant_id,workspace_id,post_id,revision),
 FOREIGN KEY(tenant_id,requester_id) REFERENCES memberships(tenant_id,user_id),
 CHECK((source_scheduled_at IS NULL)=(source_scheduled_timezone IS NULL))
) STRICT;
CREATE INDEX client_approval_workspace ON client_approval_requests(tenant_id,workspace_id,created_at,id);
CREATE UNIQUE INDEX client_approval_one_active ON client_approval_requests(tenant_id,workspace_id,post_id,revision) WHERE status IN ('pending','approved');
CREATE TABLE client_approval_challenges (
 challenge_hash TEXT PRIMARY KEY CHECK(length(challenge_hash)=64),
 tenant_id TEXT NOT NULL,
 workspace_id TEXT NOT NULL,
 request_id TEXT NOT NULL,
 token_hash TEXT NOT NULL CHECK(length(token_hash)=64),
 version INTEGER NOT NULL,
 expires_at TEXT NOT NULL,
 FOREIGN KEY(tenant_id,workspace_id,request_id) REFERENCES client_approval_requests(tenant_id,workspace_id,id)
) STRICT;
CREATE INDEX client_approval_challenge_expiry ON client_approval_challenges(expires_at);
-- Any content revision, archival, or change to the displayed editorial plan invalidates consent.
CREATE TRIGGER client_approval_invalidate_content AFTER UPDATE OF revision,status,scheduled_at,scheduled_timezone ON posts
 WHEN NEW.revision!=OLD.revision OR NEW.status='archived' OR NEW.scheduled_at IS NOT OLD.scheduled_at OR NEW.scheduled_timezone IS NOT OLD.scheduled_timezone
 BEGIN
 UPDATE client_approval_requests SET status='invalidated',version=version+1,updated_at=NEW.updated_at,
 scheduling_status=CASE WHEN scheduling_status='scheduled' THEN 'blocked' ELSE scheduling_status END,scheduling_code='CLIENT_APPROVAL_STALE'
 WHERE tenant_id=NEW.tenant_id AND workspace_id=NEW.workspace_id AND post_id=NEW.id AND status IN ('pending','approved');
 UPDATE publication_jobs SET status='blocked',error_code='APPROVAL_STALE',version=version+1,lease_token=NULL,lease_owner=NULL,lease_until=NULL,updated_at=NEW.updated_at
 WHERE tenant_id=NEW.tenant_id AND workspace_id=NEW.workspace_id AND post_id=NEW.id AND status IN ('scheduled','retry_wait','leased')
 AND id IN (SELECT value FROM client_approval_requests r,json_each(r.publication_ids_json) WHERE r.tenant_id=NEW.tenant_id AND r.workspace_id=NEW.workspace_id AND r.post_id=NEW.id AND r.status='invalidated');
 END;
