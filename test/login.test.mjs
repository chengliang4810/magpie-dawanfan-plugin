import test from 'node:test';
import assert from 'node:assert/strict';
import { completeBrowserLogin } from '../lib/login.mjs';

const json = (body, status = 200) => Response.json(body, { status });
const profile = { id: 123, email: 'person@example.test' };

test('existing active magpie key is revealed automatically without creation', async (t) => {
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    calls.push({ path: new URL(url).pathname, method: init.method });
    assert.equal(init.headers.authorization, 'Bearer test-session');
    assert.equal(init.redirect, 'error');
    if (url.endsWith('/api/me')) return json(profile);
    if (url.endsWith('/api/keys')) return json([
      { id: 1, name: 'other', status: 'active' },
      { id: 2, name: 'magpie', status: 'revoked' },
      { id: 3, name: 'magpie', status: 'active', has_enc: true },
    ]);
    assert.ok(url.endsWith('/api/keys/3/reveal'));
    return json({ key: 'existing-key' });
  });
  assert.deepEqual(await completeBrowserLogin('test-session'), {
    type: 'success', key: 'existing-key',
    metadata: { email: profile.email, sessionToken: 'test-session', managedKeyName: 'magpie' },
  });
  assert.deepEqual(calls, [
    { path: '/api/me', method: 'GET' },
    { path: '/api/keys', method: 'GET' },
    { path: '/api/keys/3/reveal', method: 'GET' },
  ]);
});

test('missing magpie key is created once with exact name and saved directly', async (t) => {
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    calls.push(init.method);
    if (url.endsWith('/api/me')) return json(profile);
    if (init.method === 'GET') return json([{ id: 1, name: 'another-key', status: 'active' }]);
    assert.equal(url, 'https://dawan.fan/api/keys');
    assert.deepEqual(JSON.parse(init.body), { name: 'magpie' });
    return json({ id: 4, key: 'new-key' }, 201);
  });
  assert.equal((await completeBrowserLogin('test-session')).key, 'new-key');
  assert.deepEqual(calls, ['GET', 'GET', 'POST']);
});

test('new key can be revealed when create returns only its id', async (t) => {
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    if (url.endsWith('/api/me')) return json(profile);
    if (init.method === 'POST') return json({ id: 4 }, 201);
    if (url.endsWith('/reveal')) return json({ key: 'revealed-new-key' });
    return json([]);
  });
  assert.equal((await completeBrowserLogin('test-session')).key, 'revealed-new-key');
});

test('revoked magpie keys are not reused', async (t) => {
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    if (url.endsWith('/api/me')) return json(profile);
    if (init.method === 'POST') return json({ key: 'replacement-key' }, 201);
    return json([{ id: 1, name: 'magpie', status: 'revoked' }]);
  });
  assert.equal((await completeBrowserLogin('test-session')).key, 'replacement-key');
});

test('same-account concurrent sign-ins share provisioning but retain their own sessions', async (t) => {
  let creates = 0;
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    if (url.endsWith('/api/me')) return json(profile);
    if (init.method === 'POST') { creates++; return json({ key: 'shared-account-key' }, 201); }
    await new Promise((resolve) => setTimeout(resolve, 10));
    return json([]);
  });
  const results = await Promise.all([completeBrowserLogin('session-a'), completeBrowserLogin('session-b')]);
  assert.equal(creates, 1);
  assert.equal(results[0].key, results[1].key);
  assert.equal(results[0].metadata.sessionToken, 'session-a');
  assert.equal(results[1].metadata.sessionToken, 'session-b');
});

test('different accounts never share a provisioned key', async (t) => {
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    const id = init.headers.authorization.endsWith('session-a') ? 1 : 2;
    if (url.endsWith('/api/me')) return json({ id, email: `user${id}@example.test` });
    if (init.method === 'POST') return json({ key: `key-${id}` }, 201);
    return json([]);
  });
  const [a, b] = await Promise.all([completeBrowserLogin('session-a'), completeBrowserLogin('session-b')]);
  assert.equal(a.key, 'key-1');
  assert.equal(b.key, 'key-2');
});

test('an unrevealable existing key fails without creating duplicates or reflecting secrets', async (t) => {
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    calls.push(init.method);
    if (url.endsWith('/api/me')) return json(profile);
    if (url.endsWith('/reveal')) return json({ message: 'reflected-secret' }, 404);
    return json([{ id: 1, name: 'magpie', status: 'active', has_enc: false }]);
  });
  await assert.rejects(completeBrowserLogin('session-secret'), (error) => {
    assert.doesNotMatch(error.message, /secret/);
    return /HTTP 404/.test(error.message);
  });
  assert.ok(calls.every((method) => method === 'GET'));
});

test('lost create response is never retried; the next login lists and reuses the created key', async (t) => {
  let creates = 0;
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    if (url.endsWith('/api/me')) return json(profile);
    if (init.method === 'POST') { creates++; throw new Error('connection lost after commit'); }
    if (url.endsWith('/reveal')) return json({ key: 'committed-key' });
    return json(creates ? [{ id: 1, name: 'magpie', status: 'active' }] : []);
  });
  await assert.rejects(completeBrowserLogin('test-session'), /连接大碗饭失败/);
  assert.equal((await completeBrowserLogin('test-session')).key, 'committed-key');
  assert.equal(creates, 1);
});

test('invalid session and malformed list never create a key', async (t) => {
  for (const fixture of ['unauthorized', 'bad-list']) {
    const methods = [];
    const mock = t.mock.method(globalThis, 'fetch', async (url, init) => {
      methods.push(init.method);
      if (fixture === 'unauthorized') return json({}, 401);
      return url.endsWith('/api/me') ? json(profile) : json({ unexpected: [] });
    });
    await assert.rejects(completeBrowserLogin('test-session'));
    assert.ok(methods.every((method) => method === 'GET'));
    mock.mock.restore();
  }
});
