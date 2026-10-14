import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import Stripe from 'stripe';
import { OfflineStripeTestAdapter, StripeWebhookVerifier, STRIPE_API_VERSION, DisabledBillingProvider } from '../src/commercial/providers.mjs';
import { harness, verified, idempotency, route, assertDenied } from './qa-helpers.mjs';

function fixture({ eventId='evt_QA1',customer='cus_QAA',subscription='sub_QAA',eventType='customer.subscription.updated',...extra }={}) {
  return {id:eventId,object:'event',api_version:STRIPE_API_VERSION,created:1700000000,livemode:false,type:eventType,
    data:{object:{id:subscription,object:'subscription',customer,status:'active',metadata:{tenantId:'untrusted-browser-tenant'}}},...extra};
}
function signed(event,secret,now=Date.now()) {
  const payload=typeof event==='string'?event:JSON.stringify(event);
  return {payload,headers:{'content-type':'application/json','stripe-signature':Stripe.webhooks.generateTestHeaderString({payload,secret,timestamp:Math.floor(now/1000)})}};
}

test('security: official Stripe offline verifier checks exact raw bytes, age, mode, account and schema',()=>{
  const now=Date.now(),secret=randomBytes(32).toString('hex'),verifier=new StripeWebhookVerifier({webhookSecret:secret,clock:()=>new Date(now).toISOString()});
  const good=signed(fixture(),secret,now);
  const result=verifier.verifyWebhook(Buffer.from(good.payload),good.headers);
  assert.equal(result.eventId,'evt_QA1');assert.equal(result.customerId,'cus_QAA');assert.equal(result.tenantId,undefined);
  assert.equal(result.metadata,undefined);assert.equal(result.status,undefined);
  const invalid=[
    {payload:good.payload+' ',headers:good.headers},
    {payload:good.payload,headers:{}},
    signed(fixture(),randomBytes(32).toString('hex'),now),
    signed(fixture(),secret,now-301000),
    signed(fixture(),secret,now+301000),
    signed(fixture({livemode:true}),secret,now),
    signed(fixture({account:'acct_Attacker'}),secret,now),
    signed(fixture({api_version:'1900-01-01'}),secret,now),
    signed(fixture({eventType:'checkout.session.completed'}),secret,now),
    signed(fixture({data:{object:{id:'sub_QAA',object:'subscription',customer:'cus_QAA',subscription:'sub_QAA'},arbitrary:'data'}}),secret,now),
  ];
  // Last fixture retains the minimum valid subscription schema and must still drop irrelevant data.
  const irrelevant=invalid.pop();assert.equal(verifier.verifyWebhook(Buffer.from(irrelevant.payload),irrelevant.headers).eventId,'evt_QA1');
  for(const item of invalid) assert.throws(()=>verifier.verifyWebhook(Buffer.from(item.payload),item.headers));
  assert.throws(()=>verifier.verifyWebhook(Buffer.from(good.payload),{...good.headers,'content-encoding':'gzip'}));
  assert.throws(()=>verifier.verifyWebhook(Buffer.alloc(256*1024+1),good.headers));
  assert.throws(()=>new OfflineStripeTestAdapter({mode:'development'}));
  assert.throws(()=>new DisabledBillingProvider().createCheckout(),e=>e.code==='BILLING_NOT_CONFIGURED');
});

test('security: billing disabled routes never create checkout; manual grants require platform authority and are audited',async t=>{
  const h=await harness(t),owner=await verified(h,'billing-owner'),operator=await verified(h,'billing-operator');
  const tenant=await owner.client.ok('POST','/api/v1/tenants',{name:'Billing QA',slug:'billing-qa',timezone:'UTC'},idempotency());
  for(const op of ['checkout','portal']) {const result=await owner.client.request('POST',`/api/v1/tenants/${tenant.id}/billing/${op}`,{});assert.equal(result.status,503,result.body);assert.equal(result.json.error.code,'BILLING_NOT_CONFIGURED');assert.ok(!result.body.includes('https://checkout'));}
  const absent=await h.app.inject({method:'POST',url:'/api/v1/webhooks/stripe',headers:{'content-type':'application/json'},payload:'{}'});assert.equal(absent.statusCode,404,absent.body);
  const grantPath=`/api/v1/admin/tenants/${tenant.id}/entitlement-grants`,grant={planId:'pilot_team',planVersion:1,endsAt:new Date(Date.now()+7*86400e3).toISOString(),reason:'Independent local QA grant'};
  assertDenied(await owner.client.request('POST',grantPath,grant,idempotency()),403);
  h.db.prepare("INSERT INTO platform_admins(user_id,status,created_at) VALUES(?,'active',?)").run(operator.user.id,new Date().toISOString());
  const first=await operator.client.ok('POST',grantPath,grant,idempotency('manual-grant-once'));
  const second=await operator.client.ok('POST',grantPath,grant,idempotency('manual-grant-once'));
  assert.equal(first.version,second.version);assert.equal(first.source,'manual_trial');assert.equal(first.plan.id,'pilot_team');
  assert.equal(h.db.prepare("SELECT count(*) AS n FROM audit_events WHERE action='admin.entitlement.granted'").get().n,1);
  assert.equal(h.db.prepare('SELECT count(*) AS n FROM subscriptions').get().n,0);
  h.db.prepare("UPDATE platform_admins SET status='disabled' WHERE user_id=?").run(operator.user.id);
  assertDenied(await operator.client.request('GET','/api/v1/admin/tenants'),403);
});

test('security: signed webhook ledger is durable/idempotent and reconciliation trusts server binding plus current provider state',async t=>{
  let now=Date.now();const secret=randomBytes(32).toString('hex');
  const adapter=new OfflineStripeTestAdapter({mode:'test',webhookSecret:secret,clock:()=>new Date(now).toISOString()});
  const h=await harness(t,{clock:()=>new Date(now),billingAdapter:adapter}),a=await verified(h,'webhook-a'),b=await verified(h,'webhook-b');
  const tenantA=await a.client.ok('POST','/api/v1/tenants',{name:'Webhook A',slug:'webhook-a',timezone:'UTC'},idempotency());
  const tenantB=await b.client.ok('POST','/api/v1/tenants',{name:'Webhook B',slug:'webhook-b',timezone:'UTC'},idempotency());
  const beforeA=h.db.prepare('SELECT * FROM tenant_entitlements WHERE tenant_id=?').get(tenantA.id);
  h.db.prepare("INSERT INTO billing_customers VALUES(?,'stripe','platform','cus_QAB')").run(tenantB.id);
  h.db.prepare("INSERT INTO subscriptions(tenant_id,provider,provider_account_scope,subscription_id,customer_id,plan_id,plan_version,provider_status) VALUES(?,'stripe','platform','sub_QAB','cus_QAB','pilot_team',1,'incomplete')").run(tenantB.id);
  const snapshot={id:'sub_QAB',customer:'cus_QAB',status:'active',livemode:false,current_period_end:Math.floor(now/1000)+86400,cancel_at_period_end:false};adapter.subscriptions.set('sub_QAB',snapshot);
  const send=async event=>{const body=signed(event,secret,now);return h.app.inject({method:'POST',url:'/api/v1/webhooks/stripe',...body});};
  await t.test('metadata cannot move customer B into tenant A; concurrent duplicate produces one ledger and job',async()=>{
    const event=fixture({eventId:'evt_BindB',customer:'cus_QAB',subscription:'sub_QAB'});event.data.object.metadata.tenantId=tenantA.id;
    const pair=await Promise.all([send(event),send(event)]);for(const r of pair)assert.equal(r.statusCode,200,r.body);
    assert.equal(h.db.prepare('SELECT count(*) AS n FROM billing_events').get().n,1);assert.equal(h.db.prepare('SELECT count(*) AS n FROM jobs').get().n,1);
    assert.equal(h.db.prepare('SELECT tenant_id FROM billing_events').get().tenant_id,tenantB.id);
    assert.deepEqual(h.db.prepare('SELECT * FROM tenant_entitlements WHERE tenant_id=?').get(tenantA.id),beforeA);
    assert.equal((await h.app.ctx.services.billing.processNextJob()).state,'done');
    assert.equal((await h.app.ctx.services.billing.processNextJob()).state,'idle');
    assert.equal(h.db.prepare('SELECT source FROM tenant_entitlements WHERE tenant_id=?').get(tenantB.id).source,'provider');
    assert.equal(adapter.calls.subscription,1);
    const changed=structuredClone(event);changed.created++;assert.equal((await send(changed)).statusCode,409);
  });
  await t.test('unknown customer/subscription is quarantined without provisioning or a job',async()=>{
    const unknown=fixture({eventId:'evt_Unknown',customer:'cus_Unmapped',subscription:'sub_Unmapped'});unknown.data.object.metadata.tenantId=tenantA.id;
    assert.equal((await send(unknown)).statusCode,200);
    const row=h.db.prepare("SELECT * FROM billing_events WHERE event_id='evt_Unknown'").get();assert.equal(row.state,'quarantined');assert.equal(row.tenant_id,null);
    assert.equal(h.db.prepare('SELECT count(*) AS n FROM jobs WHERE payload_ref=?').get(row.id).n,0);
    assert.deepEqual(h.db.prepare('SELECT * FROM tenant_entitlements WHERE tenant_id=?').get(tenantA.id),beforeA);
  });
  await t.test('old activation after cancellation does not reactivate when current provider state is canceled',async()=>{
    adapter.subscriptions.set('sub_QAB',{...snapshot,status:'canceled'});
    const canceled=fixture({eventId:'evt_Canceled',eventType:'customer.subscription.deleted',customer:'cus_QAB',subscription:'sub_QAB'});canceled.created=200;
    const oldActive=fixture({eventId:'evt_OldActive',customer:'cus_QAB',subscription:'sub_QAB'});oldActive.created=100;oldActive.data.object.status='active';
    assert.equal((await send(canceled)).statusCode,200);assert.equal((await h.app.ctx.services.billing.processNextJob()).state,'done');
    const version=h.db.prepare('SELECT version FROM tenant_entitlements WHERE tenant_id=?').get(tenantB.id).version;
    assert.equal((await send(oldActive)).statusCode,200);const result=await h.app.ctx.services.billing.processNextJob();assert.equal(result.state,'done');assert.equal(result.entitlementChanged,false);
    const entitlement=h.db.prepare('SELECT * FROM tenant_entitlements WHERE tenant_id=?').get(tenantB.id);assert.equal(entitlement.access_policy,'read_only');assert.equal(entitlement.version,version);
  });
  await t.test('provider failure retries and crashed expired leases recover once; max attempts becomes visible failure',async()=>{
    adapter.failuresRemaining=1;assert.equal((await send(fixture({eventId:'evt_Retry',customer:'cus_QAB',subscription:'sub_QAB'}))).statusCode,200);
    assert.equal((await h.app.ctx.services.billing.processNextJob()).state,'retry');assert.equal((await h.app.ctx.services.billing.processNextJob()).state,'idle');
    now+=10000;assert.equal((await h.app.ctx.services.billing.processNextJob()).state,'done');
    assert.equal((await send(fixture({eventId:'evt_Crash',customer:'cus_QAB',subscription:'sub_QAB'}))).statusCode,200);
    const job=h.db.prepare("SELECT j.* FROM jobs j JOIN billing_events e ON e.id=j.payload_ref WHERE e.event_id='evt_Crash'").get();
    h.db.prepare("UPDATE jobs SET state='processing',lease_token='old-worker',lease_until=?,attempts=1 WHERE id=?").run(new Date(now-1).toISOString(),job.id);
    assert.equal((await h.app.ctx.services.billing.processNextJob()).state,'done');
    assert.equal(h.db.prepare('SELECT attempts FROM jobs WHERE id=?').get(job.id).attempts,2);
    adapter.failuresRemaining=10;await send(fixture({eventId:'evt_Exhausted',customer:'cus_QAB',subscription:'sub_QAB'}));
    for(let attempt=0;attempt<5;attempt++){const result=await h.app.ctx.services.billing.processNextJob();assert.equal(result.state,attempt===4?'failed':'retry');now+=3600000;}
    assert.equal(h.db.prepare("SELECT state FROM billing_events WHERE event_id='evt_Exhausted'").get().state,'failed');
    assert.equal((await h.app.ctx.services.billing.processNextJob()).state,'idle');
  });
  assert.deepEqual(h.db.prepare('SELECT * FROM tenant_entitlements WHERE tenant_id=?').get(tenantA.id),beforeA);
  const persisted=JSON.stringify(h.db.prepare('SELECT * FROM billing_events').all());assert.ok(!persisted.includes(secret));assert.ok(!persisted.includes('metadata'));
});
