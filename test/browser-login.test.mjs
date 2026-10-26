import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { authorizeBrowserLogin } from '../lib/browser-login.mjs';
import { LoginError } from '../lib/login.mjs';
import { DawanFanPlugin } from '../index.mjs';

function fakeBrowser(tokens = ['']) {
  const browser = new EventEmitter();
  const page = new EventEmitter();
  let closed = false;
  let contexts = 0;
  let reads = 0;
  let navigated;
  page.goto = async (url) => { navigated = url; };
  page.isClosed = () => closed;
  page.evaluate = async (_fn, origin) => {
    assert.equal(origin, 'https://dawan.fan');
    const next = tokens[Math.min(reads++, tokens.length - 1)];
    if (next instanceof Error) throw next;
    return next;
  };
  browser.newContext = async () => { contexts++; return { newPage: async () => page }; };
  browser.close = async () => { closed = true; browser.emit('disconnected'); };
  return { browser, page, state: () => ({ closed, contexts, reads, navigated }) };
}

test('browser sign-in is the only login method and asks for no key or session', async () => {
  const hooks = await DawanFanPlugin({});
  assert.equal(hooks.auth.methods.length, 1);
  const method = hooks.auth.methods[0];
  assert.equal(method.type, 'oauth');
  assert.equal(method.label, '网页登录');
  assert.equal(method.prompts, undefined);
});

test('browser login waits for the session, provisions automatically and closes the window', async () => {
  const fake = fakeBrowser(['', new Error('navigation destroyed execution context'), 'web-session']);
  let completions = 0;
  const flow = await authorizeBrowserLogin({
    launch: async () => fake.browser, pollInterval: 1, timeoutMs: 1000,
    complete: async (token, { signal }) => {
      assert.equal(token, 'web-session');
      assert.equal(signal.aborted, false);
      completions++;
      return { type: 'success', key: 'automatic-key', metadata: { sessionToken: token } };
    },
  });
  assert.equal(flow.method, 'auto');
  assert.equal(flow.opened, true);
  assert.equal(flow.url, '');
  const result = await flow.callback();
  assert.equal(result.key, 'automatic-key');
  assert.equal(completions, 1);
  assert.equal(fake.state().closed, true);
  assert.equal(fake.state().contexts, 1);
  assert.equal(fake.state().navigated, 'https://dawan.fan/login');
});

test('closing the login window cancels without key creation', async () => {
  const fake = fakeBrowser();
  let completes = 0;
  const flow = await authorizeBrowserLogin({
    launch: async () => fake.browser, timeoutMs: 1000,
    complete: async () => { completes++; },
  });
  fake.page.emit('close');
  const result = await flow.callback();
  assert.equal(result.type, 'failed');
  assert.match(result.error, /窗口已关闭/);
  assert.equal(completes, 0);
});

test('abandoned login times out and closes its browser even before callback is read', async () => {
  const fake = fakeBrowser();
  const flow = await authorizeBrowserLogin({ launch: async () => fake.browser, timeoutMs: 10, pollInterval: 1 });
  const result = await flow.callback();
  assert.equal(result.type, 'failed');
  assert.match(result.error, /超时/);
  assert.equal(fake.state().closed, true);
});

test('cancel during provisioning aborts and never saves a late successful result', async () => {
  const fake = fakeBrowser(['web-session']);
  let signal;
  let release;
  const flow = await authorizeBrowserLogin({
    launch: async () => fake.browser, timeoutMs: 1000,
    complete: async (_token, options) => {
      signal = options.signal;
      return new Promise((resolve) => { release = resolve; });
    },
  });
  await new Promise((resolve) => setImmediate(resolve));
  fake.page.emit('close');
  const result = await flow.callback();
  assert.equal(signal.aborted, true);
  assert.equal(result.type, 'failed');
  release({ type: 'success', key: 'too-late' });
  assert.equal((await flow.callback()).type, 'failed');
});

test('browser startup and API errors produce safe login failures', async () => {
  const missing = await authorizeBrowserLogin({ launch: async () => { throw new LoginError('请安装浏览器'); } });
  assert.match((await missing.callback()).error, /请安装浏览器/);
  const fake = fakeBrowser(['web-session']);
  const failed = await authorizeBrowserLogin({
    launch: async () => fake.browser,
    complete: async () => { throw new Error('unexpected error containing a secret'); },
  });
  assert.equal((await failed.callback()).error, '网页登录失败，请重试。');
  assert.equal(fake.state().closed, true);
});
