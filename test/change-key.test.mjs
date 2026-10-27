import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DawanFanPlugin } from '../index.mjs';
import { changeAPIKey } from '../lib/change-key.mjs';
import { completeBrowserLogin, savedAccounts } from '../lib/login.mjs';

const json = (body, status = 200) => Response.json(body, { status });
const old = { type: 'api', key: 'old-key', metadata: {
  email: 'person@example.test', sessionToken: 'web-session', managedKeyName: 'magpie',
} };
const newKey = 'sk-mp-new-value';
function store(records = { dawanfan: structuredClone(old) }) {
  const directory = mkdtempSync(join(tmpdir(), 'dawanfan-key-test-'));
  const file = join(directory, 'plugin-auth.json');
  writeFileSync(file, JSON.stringify(records));
  return { directory, file, records };
}
function mockAPI(t, { modelStatus = 200, key = newKey, email = old.metadata.email, onModels } = {}) {
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    calls.push({ path: new URL(url).pathname, method: init.method, token: init.headers.authorization });
    if (url.endsWith('/api/me')) return json({ email });
    if (url.endsWith('/api/keys')) return json([
      { id: 7, name: 'custom', prefix: 'sk-mp-new', status: 'active' },
      { id: 8, name: 'revoked', prefix: 'sk-mp-new', status: 'revoked' },
    ]);
    if (url.endsWith('/api/keys/7/reveal')) return json({ key });
    if (url.endsWith('/v1/models')) { onModels?.(); return json({ data: [{ id: 'model-a' }] }, modelStatus); }
    throw new Error('unexpected request');
  });
  return calls;
}

test('the key-change action appears dynamically after login and lists only this provider accounts', async () => {
  const { directory, file } = store({ openai: old });
  const hooks = await DawanFanPlugin({ directory });
  assert.equal(hooks.auth.methods.length, 1);
  writeFileSync(file, JSON.stringify({ openai: old, dawanfan: old, 'dawanfan#two': {
    ...old, metadata: { ...old.metadata, email: 'second@example.test' },
  } }));
  assert.deepEqual(hooks.auth.methods.map(m => m.label), ['网页登录', '更换 API Key']);
  assert.deepEqual(hooks.auth.methods[1].prompts[0].options, [
    { value: 'dawanfan', label: 'person@example.test' },
    { value: 'dawanfan#two', label: 'second@example.test' },
  ]);
  assert.equal(hooks.auth.methods[1].prompts[1].type, 'password');
});

test('changing a key preserves identity and web session and never writes credentials directly', async (t) => {
  const { directory, file } = store();
  const calls = mockAPI(t);
  const before = readFileSync(file, 'utf8');
  const hooks = await DawanFanPlugin({ directory });
  const flow = await hooks.auth.methods[1].authorize({ account: 'dawanfan', apiKey: ` ${newKey} ` });
  assert.equal(flow.url, '');
  const result = await flow.callback();
  assert.equal(result.type, 'success');
  assert.equal(result.key, newKey);
  assert.equal(result.metadata.email, old.metadata.email);
  assert.equal(result.metadata.sessionToken, old.metadata.sessionToken);
  assert.equal(result.metadata.apiKeySource, 'custom');
  assert.equal(result.metadata.keyName, 'custom');
  assert.equal(readFileSync(file, 'utf8'), before);
  assert.ok(calls.every(call => call.method === 'GET'));
  assert.equal(calls.at(-1).token, `Bearer ${newKey}`);
  assert.ok(calls.slice(0, -1).every(call => call.token === 'Bearer web-session'));
});

test('a key from another account is refused even when its prefix matches', async (t) => {
  const { directory, file } = store();
  const before = readFileSync(file, 'utf8');
  const calls = mockAPI(t, { key: 'different-secret-with-same-prefix' });
  await assert.rejects(changeAPIKey(directory, { account: 'dawanfan', apiKey: newKey }), /不属于所选账号/);
  assert.equal(calls.length, 3);
  assert.equal(readFileSync(file, 'utf8'), before);
});

test('a refused new key leaves the previous credentials intact', async (t) => {
  const { directory, file } = store();
  mockAPI(t, { modelStatus: 401 });
  const hooks = await DawanFanPlugin({ directory });
  const flow = await hooks.auth.methods[1].authorize({ account: 'dawanfan', apiKey: newKey });
  const result = await flow.callback();
  assert.equal(result.type, 'failed');
  assert.match(result.error, /API Key 无效/);
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).dawanfan.key, old.key);
});

test('a mismatched web identity cannot overwrite the selected account', async (t) => {
  const { directory } = store();
  const calls = mockAPI(t, { email: 'other@example.test' });
  await assert.rejects(changeAPIKey(directory, { account: 'dawanfan', apiKey: newKey }), /会话与所选账号不一致/);
  assert.equal(calls.length, 1);
});

test('accounts removed during validation cannot be resurrected', async (t) => {
  const { directory, file } = store();
  mockAPI(t, { onModels: () => writeFileSync(file, '{}') });
  await assert.rejects(changeAPIKey(directory, { account: 'dawanfan', apiKey: newKey }), /账号已发生变化/);
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), {});
});

test('newer web sessions are preserved if a session renews during key validation', async (t) => {
  const { directory, file } = store();
  mockAPI(t, { onModels: () => writeFileSync(file, JSON.stringify({ dawanfan: {
    ...old, metadata: { ...old.metadata, sessionToken: 'renewed-session' },
  } })) });
  const result = await changeAPIKey(directory, { account: 'dawanfan', apiKey: newKey });
  assert.equal(result.metadata.sessionToken, 'renewed-session');
});

test('web re-login renews the session without resetting a user-chosen key', async (t) => {
  const { directory } = store({ dawanfan: { ...old, key: newKey,
    metadata: { ...old.metadata, apiKeySource: 'custom', keyName: 'custom' },
  } });
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async (url) => {
    calls++;
    assert.ok(url.endsWith('/api/me'));
    return json({ email: old.metadata.email });
  });
  const result = await completeBrowserLogin('new-web-session', { directory });
  assert.equal(result.key, newKey);
  assert.equal(result.metadata.sessionToken, 'new-web-session');
  assert.equal(result.metadata.apiKeySource, 'custom');
  assert.equal(calls, 1);
});

test('malformed account storage is reported without exposing its contents', () => {
  const { directory, file } = store();
  writeFileSync(file, 'null');
  assert.throws(() => savedAccounts(directory), /存储格式异常/);
  writeFileSync(file, '{secret-broken');
  assert.throws(() => savedAccounts(directory), error => !error.message.includes('secret'));
});
