CREATE TABLE publication_jobs (
 tenant_id TEXT NOT NULL,
 workspace_id TEXT NOT NULL,
 id TEXT NOT NULL,
 post_id TEXT NOT NULL,
 channel_id TEXT NOT NULL,
 platform TEXT NOT NULL CHECK(platform IN ('instagram','facebook')),
 revision INTEGER NOT NULL CHECK(revision>0),
 actor_id TEXT NOT NULL,
 connection_version TEXT NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('scheduled','leased','sending','retry_wait','published','failed','blocked','cancelled','needs_attention')),
 scheduled_at TEXT NOT NULL,
 scheduled_timezone TEXT NOT NULL,
 next_attempt_at TEXT NOT NULL,
 expires_at TEXT NOT NULL,
 attempt_count INTEGER NOT NULL DEFAULT 0 CHECK(attempt_count>=0),
 max_attempts INTEGER NOT NULL DEFAULT 5 CHECK(max_attempts BETWEEN 1 AND 5),
 version INTEGER NOT NULL DEFAULT 1 CHECK(version>0),
 lease_token TEXT,
 lease_owner TEXT,
 lease_until TEXT,
 provider_state TEXT CHECK(provider_state IS NULL OR json_valid(provider_state)),
 remote_id TEXT,
 remote_url TEXT,
 published_at TEXT,
 error_code TEXT,
 created_at TEXT NOT NULL,
 updated_at TEXT NOT NULL,
 PRIMARY KEY(tenant_id,workspace_id,id),
 FOREIGN KEY(tenant_id,workspace_id,post_id,revision) REFERENCES post_revisions(tenant_id,workspace_id,post_id,revision),
 FOREIGN KEY(tenant_id,workspace_id,channel_id) REFERENCES channels(tenant_id,workspace_id,id),
 FOREIGN KEY(tenant_id,actor_id) REFERENCES memberships(tenant_id,user_id),
 CHECK((status='published')=(remote_id IS NOT NULL AND published_at IS NOT NULL)),
 CHECK((status IN ('leased','sending'))=(lease_token IS NOT NULL AND lease_owner IS NOT NULL AND lease_until IS NOT NULL))
) STRICT;
CREATE INDEX publication_due ON publication_jobs(status,next_attempt_at,scheduled_at);
CREATE INDEX publication_post ON publication_jobs(tenant_id,workspace_id,post_id,created_at,id);
CREATE UNIQUE INDEX publication_no_duplicate ON publication_jobs(tenant_id,workspace_id,post_id,revision,channel_id)
 WHERE status NOT IN ('cancelled','failed','blocked');
CREATE TABLE publication_attempts (
 tenant_id TEXT NOT NULL,
 workspace_id TEXT NOT NULL,
 id TEXT NOT NULL,
 job_id TEXT NOT NULL,
 attempt_number INTEGER NOT NULL,
 lease_token TEXT NOT NULL,
 outcome TEXT NOT NULL CHECK(outcome IN ('sending','published','retry','failed','ambiguous','recovered_safe')),
 error_code TEXT,
 started_at TEXT NOT NULL,
 finished_at TEXT,
 PRIMARY KEY(tenant_id,workspace_id,id),
 UNIQUE(tenant_id,workspace_id,job_id,attempt_number),
 FOREIGN KEY(tenant_id,workspace_id,job_id) REFERENCES publication_jobs(tenant_id,workspace_id,id)
) STRICT;
CREATE TABLE publication_workers (
 id TEXT PRIMARY KEY,
 started_at TEXT NOT NULL,
 heartbeat_at TEXT NOT NULL,
 stopped_at TEXT
) STRICT;
-- Content/approval invalidation fences all jobs that have not begun an outbound attempt.
CREATE TRIGGER publication_invalidate_revision AFTER UPDATE OF revision,approved_revision,status ON posts
 WHEN NEW.revision!=OLD.revision OR NEW.approved_revision IS NULL OR NEW.status NOT IN ('approved','planned')
 BEGIN
 UPDATE publication_jobs SET status='blocked',error_code='APPROVAL_STALE',version=version+1,
 lease_token=NULL,lease_owner=NULL,lease_until=NULL,updated_at=NEW.updated_at
 WHERE tenant_id=NEW.tenant_id AND workspace_id=NEW.workspace_id AND post_id=NEW.id
 AND status IN ('scheduled','retry_wait','leased');
 END;
