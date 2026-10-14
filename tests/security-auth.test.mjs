import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { harness, Client, verified, QA_PASSWORD, QA_ORIGIN, assertDenied } from './qa-helpers.mjs';

const digest = value => createHash('sha256').update(value).digest('hex');

test('security: registration is preauth-CSRF protected, normalized, non-preclaimable and one-use', async t => {
  const h = await harness(t), attacker = new Client(h), victim = new Client(h);
  const email = `preclaim-${randomUUID()}@example.test`;
  await attacker.bootstrap();
  assertDenied(await attacker.request('POST', '/api/v1/auth/register', { email, displayName: 'Initial pending name' }, { headers: { 'x-csrf-token': '' } }), 403);
  assertDenied(await attacker.request('POST', '/api/v1/auth/register', { email, displayName: 'Initial pending name' }, { headers: { origin: 'https://evil.example' } }), 403);
  const unknown = await attacker.request('POST', '/api/v1/auth/register', { email, displayName: 'Initial pending name', password: 'Attacker chosen password!', role: 'owner' });
  assert.ok([400, 422].includes(unknown.status), unknown.body);
  await attacker.ok('POST', '/api/v1/auth/register', { email: `  ${email.toUpperCase()}  `, displayName: 'Initial pending name' });
  let pending = h.db.prepare('SELECT * FROM users WHERE email_normalized=?').get(email);
  assert.ok(pending); assert.equal(pending.password_hash, null); assert.equal(pending.email_verified_at, null);
  assert.equal(h.db.prepare('SELECT count(*) AS n FROM tenants').get().n, 0);
  await attacker.ok('POST', '/api/v1/auth/register', { email, displayName: 'Attacker replacement name' });
  pending = h.db.prepare('SELECT * FROM users WHERE email_normalized=?').get(email);
  assert.equal(pending.display_name, 'Initial pending name');
  assert.equal(h.db.prepare('SELECT count(*) AS n FROM users WHERE email_normalized=?').get(email).n, 1);
  const message = h.messages.findLast(item => item.to === email && item.purpose === 'email_verify');
  assert.ok(message?.token); assert.ok(message.url.startsWith(QA_ORIGIN));
  assert.ok(new URL(message.url).hash.includes(message.token));
  assert.ok(!new URL(message.url).search.includes(message.token));
  await victim.bootstrap();
  const pair = await Promise.all([
    victim.request('POST', '/api/v1/auth/email/verify', { token: message.token, password: QA_PASSWORD }),
    victim.request('POST', '/api/v1/auth/email/verify', { token: message.token, password: 'Second simultaneous password!' })
  ]);
  assert.equal(pair.filter(r => r.status >= 200 && r.status < 300).length, 1, JSON.stringify(pair.map(r => r.json)));
  assert.equal(h.db.prepare('SELECT count(*) AS n FROM tenants').get().n, 0);
  assert.equal((await victim.bootstrap()).user, null, 'Verification must not create an authenticated session');
  const active = h.db.prepare('SELECT * FROM users WHERE email_normalized=?').get(email);
  assert.ok(active.password_hash); assert.ok(active.email_verified_at);
  const tokenRows = h.db.prepare('SELECT * FROM auth_tokens WHERE user_id=?').all(active.id);
  assert.ok(tokenRows.length); assert.ok(tokenRows.every(row => !Object.values(row).includes(message.token)), 'Only token digests are stored');
  assert.ok(tokenRows.some(row => row.token_hash === digest(message.token) && row.consumed_at));
});

test('security: login rotates session, rejects CSRF/session spoofing and stored hash as password', async t => {
  const h = await harness(t), identity = await verified(h, 'session-owner');
  const { client, email, user } = identity;
  const firstCookie = client.cookie, firstCsrf = client.csrf;
  const outsider = new Client(h); await outsider.bootstrap();
  assertDenied(await outsider.request('POST', '/api/v1/auth/login', { email, password: QA_PASSWORD }, { headers: { 'x-csrf-token': firstCsrf } }), 403);
  assertDenied(await outsider.request('POST', '/api/v1/auth/login', { email, password: QA_PASSWORD }, { headers: { origin: 'null' } }), 403);
  assertDenied(await outsider.request('POST', '/api/v1/auth/login', { email, password: QA_PASSWORD }, { headers: { 'sec-fetch-site': 'cross-site' } }), 403);
  const preCookie = outsider.cookie;
  await outsider.login(email);
  assert.notEqual(outsider.cookie, preCookie); assert.notEqual(outsider.cookie, firstCookie);
  const stored = h.db.prepare('SELECT * FROM users WHERE id=?').get(user.id);
  assert.match(stored.password_hash, /scrypt/); assert.ok(stored.password_hash.includes('131072'));
  const wrong = new Client(h); await wrong.bootstrap();
  assertDenied(await wrong.request('POST', '/api/v1/auth/login', { email, password: stored.password_hash }), 422); // Serialized hash exceeds accepted password length.
  const missing = new Client(h); assertDenied(await missing.request('GET', '/api/v1/me', undefined, { headers: { cookie: '', 'x-csrf-token': firstCsrf } }), 401);
  const forged = new Client(h); assertDenied(await forged.request('GET', '/api/v1/me', undefined, { headers: { cookie: 'ss_session_dev=attacker' } }), 401);
  const sessionRows = h.db.prepare('SELECT * FROM sessions WHERE user_id=?').all(user.id);
  assert.ok(sessionRows.length >= 2);
  assert.ok(sessionRows.every(row => !client.cookie.includes(row.token_hash)));
  assert.ok(sessionRows.every(row => !Object.values(row).includes(firstCookie)));
  await client.ok('POST', '/api/v1/auth/logout-all', {});
  assertDenied(await outsider.request('GET', '/api/v1/me'), 401);
  assertDenied(await client.request('GET', '/api/v1/me', undefined, { headers: { cookie: firstCookie } }), 401);
});

test('security: password recovery is purpose-bound, one-use, generic and revokes sessions', async t => {
  const h = await harness(t), identity = await verified(h, 'recovery-owner');
  const { client, email, user } = identity;
  const second = new Client(h); await second.login(email);
  const anonymous = new Client(h); await anonymous.bootstrap();
  const known = await anonymous.ok('POST', '/api/v1/auth/password/forgot', { email });
  const unknown = await anonymous.ok('POST', '/api/v1/auth/password/forgot', { email: `absent-${randomUUID()}@example.test` });
  assert.deepEqual(known, unknown, 'Reset request response must not enumerate accounts');
  const reset = h.messages.findLast(item => item.to === email && item.purpose === 'password_reset');
  assert.ok(reset?.token);
  const wrongPurpose = await anonymous.request('POST', '/api/v1/auth/email/verify', { token: reset.token, password: 'Wrong purpose must not work!' });
  assert.ok(wrongPurpose.status >= 400 && wrongPurpose.status < 500, wrongPurpose.body);
  const newPassword = 'Recovered independent QA password!';
  const pair = await Promise.all([anonymous.request('POST', '/api/v1/auth/password/reset', { token: reset.token, password: newPassword }), anonymous.request('POST', '/api/v1/auth/password/reset', { token: reset.token, password: newPassword })]);
  assert.equal(pair.filter(r => r.status >= 200 && r.status < 300).length, 1);
  assertDenied(await client.request('GET', '/api/v1/me'), 401);
  assertDenied(await second.request('GET', '/api/v1/me'), 401);
  assert.equal((await anonymous.bootstrap()).user, null);
  await anonymous.login(email, newPassword);
  const oldLogin = new Client(h); await oldLogin.bootstrap();
  assertDenied(await oldLogin.request('POST', '/api/v1/auth/login', { email, password: QA_PASSWORD }), 401);
  assert.equal(h.db.prepare('SELECT count(*) AS n FROM auth_tokens WHERE user_id=? AND purpose=? AND consumed_at IS NULL').get(user.id, 'password_reset').n, 0);
});

test('security: fresh user state, idle expiry and absolute expiry invalidate real sessions', async t => {
  let now = Date.now();
  const h = await harness(t, { clock: () => new Date(now) }), identity = await verified(h, 'expiry-owner');
  const { client, email, user } = identity;
  h.db.prepare("UPDATE users SET status='blocked' WHERE id=?").run(user.id);
  assertDenied(await client.request('GET', '/api/v1/me'), 401);
  h.db.prepare("UPDATE users SET status='active' WHERE id=?").run(user.id);
  await client.login(email);
  now += 31 * 60 * 1000;
  assertDenied(await client.request('GET', '/api/v1/me'), 401);
  await client.login(email);
  for (let hour = 0; hour < 25; hour++) {
    now += 29 * 60 * 1000;
    const result = await client.request('GET', '/api/v1/me');
    if (hour < 24) assert.equal(result.status, 200, result.body);
    else assertDenied(result, 401);
  }
});

test('security: real scrypt uses unique salts, fixed expensive parameters, bounded work and malformed-hash defense', async () => {
  const { createPasswordHasher, validatePassword } = await import('../src/auth/passwords.mjs');
  const hasher = createPasswordHasher({ concurrency: 2, maxQueue: 1 });
  const first = hasher.hash(QA_PASSWORD), second = hasher.hash(QA_PASSWORD), queued = hasher.hash('Queued strong password with spaces');
  await assert.rejects(hasher.hash('Excess queue strong password'), e => e.statusCode === 429 && e.code === 'HASH_BUSY');
  assert.deepEqual(hasher.stats().cost, { N: 131072, r: 8, p: 1, maxmem: 256 * 1024 * 1024 });
  assert.equal(hasher.stats().active, 2); assert.equal(hasher.stats().queued, 1);
  const [a, b] = await Promise.all([first, second, queued]);
  assert.notEqual(a, b);
  assert.match(a, /^scrypt\$v1\$131072\$8\$1\$[a-f0-9]{32}\$[a-f0-9]{128}$/);
  assert.equal(await hasher.verify(QA_PASSWORD, a), true);
  assert.equal(await hasher.verify(a, a), false);
  assert.equal(await hasher.verify(QA_PASSWORD, 'scrypt$v1$2$8$1$bad$bad'), false);
  assert.throws(() => validatePassword('short'));
  assert.throws(() => validatePassword('123456789012345'));
  validatePassword('多言語の独立したパスワード 2026!');
  assert.equal(hasher.stats().active, 0); assert.equal(hasher.stats().queued, 0);
});
