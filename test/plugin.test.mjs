import test from 'node:test';
import assert from 'node:assert/strict';
import { DawanFanPlugin } from '../index.mjs';
import { BASE_URL, loadModels, loadUsage, mapUsage } from '../lib/dawan.mjs';

const auth = (key = 'test-api-key', sessionToken) => ({
  type: 'api', key, ...(sessionToken ? { metadata: { sessionToken } } : {}),
});
const json = (body, status = 200) => Response.json(body, { status });
const fixture = {
  email: 'person@example.test',
  subscription: {
    used: 80, monthly: 100, plan: 'example', plan_name: '测试套餐',
    period_start: '2026-10-01T00:00:00Z', period_end: '2026-11-01T00:00:00Z',
  },
};

test('configuration preserves explicit provider settings', async () => {
  const hooks = await DawanFanPlugin({});
  const custom = { name: 'custom', models: { mine: {} } };
  const config = { provider: { dawanfan: custom, other: {} } };
  await hooks.config(config);
  assert.equal(config.provider.dawanfan, custom);
  assert.ok(config.provider.other);
});

test('model discovery uses API key and adds only entitled models', async (t) => {
  const provider = { models: { inaccessible: {}, 'model-a': { limit: { context: 999 } } } };
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    calls.push({ url, authorization: init.headers.authorization });
    if (url.endsWith('/v1/models')) return json({ data: [{ id: 'model-a' }, { id: 'route-a' }] });
    return json({
      models: [{ model_id: 'model-a', multiplier: 1.2, name: 'Model A' }, { model_id: 'inaccessible' }],
      routes: [{ virtual_model: 'route-a', multiplier: 4.5, name: 'Route A' }],
    });
  });
  const result = await loadModels(provider, auth('model-secret', 'web-secret'));
  assert.deepEqual(Object.keys(result), ['model-a', 'route-a']);
  assert.equal(result['model-a'].limit.context, 999);
  assert.equal(result['model-a'].rate, 1.2);
  assert.equal(result['route-a'].rate, 4.5);
  assert.equal(result['model-a'].api.url, BASE_URL);
  assert.deepEqual(calls, [
    { url: `${BASE_URL}/models`, authorization: 'Bearer model-secret' },
    { url: 'https://dawan.fan/api/me/models', authorization: 'Bearer web-secret' },
  ]);
});

test('API-key-only discovery never needs a web session', async (t) => {
  let count = 0;
  t.mock.method(globalThis, 'fetch', async () => { count++; return json({ data: [{ id: 'new-model' }] }); });
  const result = await loadModels({ models: {} }, auth());
  assert.equal(count, 1);
  assert.equal(result['new-model'].limit.context, 0);
  assert.equal(result['new-model'].name, 'new-model');
});

test('expired web metadata preserves working model discovery', async (t) => {
  t.mock.method(globalThis, 'fetch', async (url) => url.endsWith('/v1/models')
    ? json({ data: [{ id: 'a' }] }) : json({}, 401));
  assert.deepEqual(Object.keys(await loadModels({ models: {} }, auth('key', 'expired'))), ['a']);
});

test('invalid API key is marked expired', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => json({}, 401));
  await assert.rejects(loadModels({ models: {} }, auth()), (e) => e.signIn === 'expired');
});

test('network, rate limit and malformed discovery keep the previous list', async (t) => {
  const provider = { models: { saved: {} } };
  for (const response of [() => { throw new Error('offline'); }, () => json({}, 429), () => json({})]) {
    const mock = t.mock.method(globalThis, 'fetch', response);
    assert.equal(await loadModels(provider, auth()), provider.models);
    mock.mock.restore();
  }
});

test('empty successful entitlement list removes old models', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => json({ data: [] }));
  assert.deepEqual(await loadModels({ models: { old: {} } }, auth()), {});
});

test('quota maps request counts and exact billing period', () => {
  const result = mapUsage(fixture);
  assert.equal(result.user, 'person@example.test');
  assert.equal(result.balance, '20 次');
  assert.equal(result.until, '2026-11-01T00:00:00.000Z');
  assert.deepEqual(result.windows, [{
    name: '本月用量', used: 80, amount: 80, limit: 100, unit: '次', display: '80 / 100 次',
    resetsAt: '2026-11-01T00:00:00.000Z', span: 31 * 86400,
  }]);
});

test('quota permits overuse, handles zero limits and rejects invalid numbers', () => {
  const over = mapUsage({ subscription: { monthly: 100, used: 125 } });
  assert.equal(over.windows[0].used, 125);
  assert.equal(over.balance, '0 次');
  const zero = mapUsage({ subscription: { monthly: 0, used: 0 } });
  assert.equal(zero.windows[0].used, undefined);
  assert.equal(zero.windows[0].resetsAt, undefined);
  assert.equal(mapUsage({ subscription: null }).plan, '暂无套餐');
  assert.throws(() => mapUsage({ subscription: { monthly: '100', used: 0 } }));
});

test('API-key-only quota explains web authentication without network or blocking models', async (t) => {
  t.mock.method(globalThis, 'fetch', () => { throw new Error('must not call'); });
  const result = await loadUsage(auth());
  assert.equal(result.signIn, 'kept');
  assert.match(result.error, /网页登录/);
});

test('quota uses only the web session credential', async (t) => {
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    assert.equal(url, 'https://dawan.fan/api/me');
    assert.equal(init.headers.authorization, 'Bearer session-secret');
    assert.equal(init.redirect, 'error');
    return json(fixture);
  });
  const result = await loadUsage(auth('api-secret', 'session-secret'));
  assert.equal(result.windows[0].used, 80);
});

test('quota session failures never expire an API key or echo upstream secrets', async (t) => {
  for (const status of [401, 403, 500]) {
    const mock = t.mock.method(globalThis, 'fetch', async () => json({ message: 'secret-reflected-here' }, status));
    const result = await loadUsage(auth('api-secret', 'web-secret'));
    assert.equal(result.signIn, 'kept');
    assert.doesNotMatch(result.error, /secret/);
    mock.mock.restore();
  }
});

test('loader isolates accounts, reads current key and passes streaming response untouched', async (t) => {
  const hooks = await DawanFanPlugin({});
  let first = auth('first-key', 'first-web-session');
  const a = await hooks.auth.loader(async () => first);
  const b = await hooks.auth.loader(async () => auth('second-key', 'second-web-session'));
  const controller = new AbortController();
  const stream = new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode('data: [DONE]\n\n')); c.close(); } });
  const response = new Response(stream, { headers: { 'content-type': 'text/event-stream' } });
  const seen = [];
  t.mock.method(globalThis, 'fetch', async (request) => {
    seen.push(request);
    return response;
  });
  const init = {
    method: 'POST', body: '{"model":"a","stream":true}', signal: controller.signal,
    headers: { authorization: 'Bearer wrong', cookie: 'private-cookie', 'x-api-key': 'wrong-key' },
  };
  const actual = await a.fetch(`${BASE_URL}/chat/completions`, init);
  assert.equal(actual, response);
  assert.equal(seen[0].headers.get('authorization'), 'Bearer first-key');
  assert.equal(seen[0].headers.get('cookie'), null);
  assert.equal(seen[0].headers.get('x-api-key'), null);
  assert.equal(await seen[0].text(), init.body);
  await b.fetch(`${BASE_URL}/chat/completions`, init);
  assert.equal(seen[1].headers.get('authorization'), 'Bearer second-key');
  first = auth('rotated-key');
  await a.fetch(new Request(`${BASE_URL}/responses`, init));
  assert.equal(seen[2].headers.get('authorization'), 'Bearer rotated-key');
  controller.abort();
  assert.equal(seen[0].signal.aborted, true);
});

test('loader refuses credential forwarding to another origin or management endpoint', async (t) => {
  const hooks = await DawanFanPlugin({});
  const loader = await hooks.auth.loader(async () => auth());
  t.mock.method(globalThis, 'fetch', () => { throw new Error('must not call'); });
  for (const url of ['https://example.test/v1/chat/completions', 'https://dawan.fan/api/me', 'http://dawan.fan/v1/models']) {
    await assert.rejects(loader.fetch(url), /只接受/);
  }
});

test('upstream errors and tool stream chunks pass through unchanged', async (t) => {
  const hooks = await DawanFanPlugin({});
  const loader = await hooks.auth.loader(async () => auth());
  const upstream = new Response('data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"name":"test","arguments":"{}"}}]}}]}\n\n', {
    status: 429, headers: { 'retry-after': '20' },
  });
  t.mock.method(globalThis, 'fetch', async () => upstream);
  const result = await loader.fetch(`${BASE_URL}/chat/completions`);
  assert.equal(result, upstream);
  assert.equal(result.status, 429);
  assert.equal(result.headers.get('retry-after'), '20');
});
