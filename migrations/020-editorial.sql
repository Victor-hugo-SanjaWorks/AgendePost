CREATE TABLE workspaces (
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  id TEXT NOT NULL,
  name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 120),
  color TEXT NOT NULL DEFAULT '#635BFF',
  archived_at TEXT,
  version INTEGER NOT NULL DEFAULT 1 CHECK(version > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(tenant_id,id)
) STRICT;
CREATE INDEX workspaces_tenant_active ON workspaces(tenant_id,archived_at,id);
CREATE TABLE channels (
  tenant_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  id TEXT NOT NULL,
  platform TEXT NOT NULL CHECK(platform IN ('instagram','facebook','linkedin','tiktok','youtube','pinterest','threads','x','other')),
  label TEXT NOT NULL CHECK(length(label) BETWEEN 1 AND 120),
  connection_status TEXT NOT NULL DEFAULT 'not_connected' CHECK(connection_status='not_connected'),
  archived_at TEXT,
  version INTEGER NOT NULL DEFAULT 1 CHECK(version>0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(tenant_id,workspace_id,id),
  FOREIGN KEY(tenant_id,workspace_id) REFERENCES workspaces(tenant_id,id)
) STRICT;
CREATE TABLE media (
  tenant_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  id TEXT NOT NULL,
  original_name TEXT NOT NULL,
  normalized_mime TEXT NOT NULL CHECK(normalized_mime IN ('image/jpeg','image/png','image/webp')),
  size_bytes INTEGER NOT NULL CHECK(size_bytes>0 AND size_bytes<=5242880),
  width INTEGER NOT NULL CHECK(width BETWEEN 1 AND 10000),
  height INTEGER NOT NULL CHECK(height BETWEEN 1 AND 10000),
  digest TEXT NOT NULL,
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  PRIMARY KEY(tenant_id,workspace_id,id),
  FOREIGN KEY(tenant_id,workspace_id) REFERENCES workspaces(tenant_id,id),
  FOREIGN KEY(tenant_id,created_by) REFERENCES memberships(tenant_id,user_id),
  CHECK(width*height<=25000000)
) STRICT;
CREATE TABLE media_blobs (
  tenant_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  media_id TEXT NOT NULL,
  bytes BLOB NOT NULL,
  PRIMARY KEY(tenant_id,workspace_id,media_id),
  FOREIGN KEY(tenant_id,workspace_id,media_id) REFERENCES media(tenant_id,workspace_id,id) ON DELETE CASCADE
) STRICT;
CREATE TABLE posts (
  tenant_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  id TEXT NOT NULL,
  title TEXT NOT NULL CHECK(length(title) BETWEEN 1 AND 180),
  caption TEXT NOT NULL DEFAULT '' CHECK(length(caption)<=10000),
  format TEXT NOT NULL DEFAULT 'image' CHECK(format IN ('image','carousel','video','reel','story','text')),
  status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','in_review','changes_requested','approved','planned','archived')),
  revision INTEGER NOT NULL DEFAULT 1 CHECK(revision>0),
  approved_revision INTEGER,
  scheduled_at TEXT,
  scheduled_timezone TEXT,
  author_id TEXT NOT NULL REFERENCES users(id),
  updated_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(tenant_id,workspace_id,id),
  FOREIGN KEY(tenant_id,workspace_id) REFERENCES workspaces(tenant_id,id),
  FOREIGN KEY(tenant_id,author_id) REFERENCES memberships(tenant_id,user_id),
  FOREIGN KEY(tenant_id,updated_by) REFERENCES memberships(tenant_id,user_id),
  FOREIGN KEY(tenant_id,workspace_id,id,approved_revision) REFERENCES post_revisions(tenant_id,workspace_id,post_id,revision),
  CHECK((scheduled_at IS NULL)=(scheduled_timezone IS NULL)),
  CHECK(approved_revision IS NULL OR approved_revision=revision),
  CHECK(status NOT IN ('approved','planned') OR (approved_revision IS NOT NULL AND approved_revision=revision)),
  CHECK(status!='planned' OR scheduled_at IS NOT NULL)
) STRICT;
CREATE INDEX posts_tenant_status_date ON posts(tenant_id,workspace_id,status,scheduled_at,id);
CREATE TABLE post_tags (
  tenant_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  post_id TEXT NOT NULL,
  tag TEXT NOT NULL CHECK(length(tag) BETWEEN 1 AND 60),
  position INTEGER NOT NULL CHECK(position BETWEEN 0 AND 19),
  PRIMARY KEY(tenant_id,workspace_id,post_id,tag),
  UNIQUE(tenant_id,workspace_id,post_id,position),
  FOREIGN KEY(tenant_id,workspace_id,post_id) REFERENCES posts(tenant_id,workspace_id,id)
) STRICT;
CREATE TABLE post_channels (
  tenant_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  post_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  position INTEGER NOT NULL CHECK(position BETWEEN 0 AND 5),
  PRIMARY KEY(tenant_id,workspace_id,post_id,channel_id),
  UNIQUE(tenant_id,workspace_id,post_id,position),
  FOREIGN KEY(tenant_id,workspace_id,post_id) REFERENCES posts(tenant_id,workspace_id,id),
  FOREIGN KEY(tenant_id,workspace_id,channel_id) REFERENCES channels(tenant_id,workspace_id,id)
) STRICT;
CREATE TABLE post_media (
  tenant_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  post_id TEXT NOT NULL,
  media_id TEXT NOT NULL,
  position INTEGER NOT NULL CHECK(position BETWEEN 0 AND 9),
  PRIMARY KEY(tenant_id,workspace_id,post_id,media_id),
  UNIQUE(tenant_id,workspace_id,post_id,position),
  FOREIGN KEY(tenant_id,workspace_id,post_id) REFERENCES posts(tenant_id,workspace_id,id),
  FOREIGN KEY(tenant_id,workspace_id,media_id) REFERENCES media(tenant_id,workspace_id,id)
) STRICT;
CREATE TABLE post_revisions (
  tenant_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  post_id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK(revision>0),
  actor_id TEXT NOT NULL REFERENCES users(id),
  content_snapshot TEXT NOT NULL CHECK(json_valid(content_snapshot)),
  created_at TEXT NOT NULL,
  PRIMARY KEY(tenant_id,workspace_id,post_id,revision),
  FOREIGN KEY(tenant_id,workspace_id,post_id) REFERENCES posts(tenant_id,workspace_id,id),
  FOREIGN KEY(tenant_id,actor_id) REFERENCES memberships(tenant_id,user_id)
) STRICT;
CREATE TABLE post_revision_media (
  tenant_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  post_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  media_id TEXT NOT NULL,
  PRIMARY KEY(tenant_id,workspace_id,post_id,revision,media_id),
  FOREIGN KEY(tenant_id,workspace_id,post_id,revision) REFERENCES post_revisions(tenant_id,workspace_id,post_id,revision),
  FOREIGN KEY(tenant_id,workspace_id,media_id) REFERENCES media(tenant_id,workspace_id,id)
) STRICT;
CREATE TABLE comments (
  tenant_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  id TEXT NOT NULL,
  post_id TEXT NOT NULL,
  author_id TEXT NOT NULL REFERENCES users(id),
  body TEXT NOT NULL CHECK(length(body) BETWEEN 1 AND 5000),
  created_at TEXT NOT NULL,
  PRIMARY KEY(tenant_id,workspace_id,id),
  FOREIGN KEY(tenant_id,workspace_id,post_id) REFERENCES posts(tenant_id,workspace_id,id),
  FOREIGN KEY(tenant_id,author_id) REFERENCES memberships(tenant_id,user_id)
) STRICT;
CREATE INDEX comments_post ON comments(tenant_id,workspace_id,post_id,id);
CREATE TABLE approvals (
  tenant_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  id TEXT NOT NULL,
  post_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  reviewer_id TEXT NOT NULL REFERENCES users(id),
  decision TEXT NOT NULL CHECK(decision IN ('approved','changes_requested')),
  reason TEXT CHECK(reason IS NULL OR length(reason)<=2000),
  created_at TEXT NOT NULL,
  PRIMARY KEY(tenant_id,workspace_id,id),
  FOREIGN KEY(tenant_id,workspace_id,post_id,revision) REFERENCES post_revisions(tenant_id,workspace_id,post_id,revision),
  FOREIGN KEY(tenant_id,reviewer_id) REFERENCES memberships(tenant_id,user_id)
) STRICT;
CREATE TABLE post_events (
  tenant_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  id TEXT NOT NULL,
  post_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  actor_id TEXT NOT NULL REFERENCES users(id),
  action TEXT NOT NULL,
  from_status TEXT,
  to_status TEXT NOT NULL,
  reason TEXT CHECK(reason IS NULL OR length(reason)<=2000),
  scheduled_at TEXT,
  scheduled_timezone TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY(tenant_id,workspace_id,id),
  FOREIGN KEY(tenant_id,workspace_id,post_id,revision) REFERENCES post_revisions(tenant_id,workspace_id,post_id,revision),
  FOREIGN KEY(tenant_id,actor_id) REFERENCES memberships(tenant_id,user_id)
) STRICT;
CREATE INDEX post_events_post ON post_events(tenant_id,workspace_id,post_id,id);
