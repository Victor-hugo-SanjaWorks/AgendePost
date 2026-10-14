-- Technical presets only. No prices, provider secrets, external accounts or payments.
CREATE TABLE plans (
 id TEXT NOT NULL, version INTEGER NOT NULL CHECK(version>0), label TEXT NOT NULL,
 limits_json TEXT NOT NULL CHECK(json_valid(limits_json)), flags_json TEXT NOT NULL CHECK(json_valid(flags_json)),
 active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)), PRIMARY KEY(id,version)
);
INSERT INTO plans VALUES
 ('pilot_base',1,'Piloto Base','{"workspaces":2,"members":3,"posts":100,"mediaBytes":20971520}','{"editorialPlanning":true,"socialPublishing":false}',1),
 ('pilot_team',1,'Piloto Equipe','{"workspaces":10,"members":10,"posts":1000,"mediaBytes":104857600}','{"editorialPlanning":true,"socialPublishing":false}',1);
CREATE TRIGGER plans_immutable BEFORE UPDATE ON plans
 WHEN OLD.id != NEW.id OR OLD.version != NEW.version OR OLD.label != NEW.label OR OLD.limits_json != NEW.limits_json OR OLD.flags_json != NEW.flags_json
 BEGIN SELECT RAISE(ABORT,'plan versions are immutable'); END;
CREATE TRIGGER plans_no_delete BEFORE DELETE ON plans BEGIN SELECT RAISE(ABORT,'plan versions cannot be deleted'); END;
CREATE TABLE tenant_entitlements (
 tenant_id TEXT PRIMARY KEY REFERENCES tenants(id), plan_id TEXT NOT NULL, plan_version INTEGER NOT NULL,
 source TEXT NOT NULL CHECK(source IN ('manual_trial','provider')),
 starts_at TEXT NOT NULL, ends_at TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1 CHECK(version>0),
 access_policy TEXT NOT NULL DEFAULT 'enabled' CHECK(access_policy IN ('enabled','read_only')),
 updated_at TEXT NOT NULL, FOREIGN KEY(plan_id,plan_version) REFERENCES plans(id,version)
);
CREATE TABLE platform_admins (
 user_id TEXT PRIMARY KEY REFERENCES users(id), status TEXT NOT NULL CHECK(status IN ('active','disabled')),
 created_at TEXT NOT NULL, created_by TEXT REFERENCES users(id)
);
CREATE TABLE billing_customers (
 tenant_id TEXT NOT NULL REFERENCES tenants(id), provider TEXT NOT NULL CHECK(provider='stripe'),
 provider_account_scope TEXT NOT NULL, customer_id TEXT NOT NULL,
 PRIMARY KEY(provider,provider_account_scope,customer_id), UNIQUE(tenant_id,provider,provider_account_scope),
 UNIQUE(tenant_id,provider,provider_account_scope,customer_id)
);
CREATE TABLE subscriptions (
 tenant_id TEXT NOT NULL, provider TEXT NOT NULL CHECK(provider='stripe'), provider_account_scope TEXT NOT NULL,
 subscription_id TEXT NOT NULL, customer_id TEXT NOT NULL, plan_id TEXT NOT NULL, plan_version INTEGER NOT NULL,
 provider_status TEXT NOT NULL CHECK(provider_status IN ('incomplete','incomplete_expired','trialing','active','past_due','canceled','unpaid','paused')),
 period_end TEXT, cancel_at_period_end INTEGER NOT NULL DEFAULT 0 CHECK(cancel_at_period_end IN (0,1)),
 reconciled_at TEXT, reconcile_version INTEGER NOT NULL DEFAULT 0,
 PRIMARY KEY(provider,provider_account_scope,subscription_id), UNIQUE(tenant_id,provider,provider_account_scope),
 FOREIGN KEY(tenant_id,provider,provider_account_scope,customer_id) REFERENCES billing_customers(tenant_id,provider,provider_account_scope,customer_id),
 FOREIGN KEY(plan_id,plan_version) REFERENCES plans(id,version)
);
CREATE TABLE billing_events (
 id TEXT PRIMARY KEY, provider TEXT NOT NULL CHECK(provider='stripe'), account_scope TEXT NOT NULL, event_id TEXT NOT NULL,
 tenant_id TEXT REFERENCES tenants(id), object_id TEXT NOT NULL, event_type TEXT NOT NULL, subscription_id TEXT NOT NULL,
 customer_id TEXT NOT NULL, received_at TEXT NOT NULL, body_digest TEXT NOT NULL,
 state TEXT NOT NULL CHECK(state IN ('queued','processing','processed','quarantined','failed')),
 attempts INTEGER NOT NULL DEFAULT 0, processed_at TEXT, error_code TEXT,
 UNIQUE(provider,account_scope,event_id), UNIQUE(id,tenant_id)
);
CREATE INDEX billing_events_operational ON billing_events(state,received_at);
CREATE TABLE jobs (
 id TEXT PRIMARY KEY, tenant_id TEXT REFERENCES tenants(id), type TEXT NOT NULL CHECK(type='billing.reconcile'),
 dedupe_key TEXT NOT NULL UNIQUE, payload_ref TEXT NOT NULL REFERENCES billing_events(id), run_at TEXT NOT NULL,
 state TEXT NOT NULL CHECK(state IN ('queued','processing','retry','done','failed')),
 lease_until TEXT, lease_token TEXT, attempts INTEGER NOT NULL DEFAULT 0, last_error_code TEXT,
 created_at TEXT NOT NULL, completed_at TEXT,
 FOREIGN KEY(payload_ref,tenant_id) REFERENCES billing_events(id,tenant_id),
 CHECK(type!='billing.reconcile' OR tenant_id IS NOT NULL)
);
CREATE INDEX jobs_due ON jobs(state,run_at,lease_until);
CREATE TABLE billing_reconciliation_locks (
 provider TEXT NOT NULL, account_scope TEXT NOT NULL, subscription_id TEXT NOT NULL,
 lease_token TEXT NOT NULL, lease_until TEXT NOT NULL,
 PRIMARY KEY(provider,account_scope,subscription_id)
);
