import assert from 'node:assert/strict';
import { authorizeBrowserLogin, launchBrowser } from '../lib/browser-login.mjs';

// Exercise the real installed browser and lifecycle without a real account.
// All dawan.fan requests are intercepted by this fixture; no key is created.
let browser;
let completions = 0;
const flow = await authorizeBrowserLogin({
  timeoutMs: 15_000,
  launch: async () => {
    browser = await launchBrowser();
    return {
      on: (...args) => browser.on(...args),
      close: () => browser.close(),
      async newContext(options) {
        const context = await browser.newContext(options);
        await context.route('https://dawan.fan/**', (route) => route.fulfill({
          status: 200,
          contentType: 'text/html',
          body: '<!doctype html><html lang="zh-CN"><title>登录测试</title><body><script>setTimeout(()=>localStorage.setItem("zt_token","fixture-session"),100)</script></body></html>',
        }));
        return context;
      },
    };
  },
  async complete(token, { signal }) {
    assert.equal(token, 'fixture-session');
    assert.equal(signal.aborted, false);
    completions++;
    return { type: 'success', key: 'fixture-key', metadata: { sessionToken: token } };
  },
});
const result = await flow.callback();
assert.equal(result.type, 'success', result.error);
assert.equal(result.key, 'fixture-key');
assert.equal(completions, 1);
assert.equal(browser.isConnected(), false);
console.log('真实浏览器窗口：会话检测、自动接入及关闭检查通过（使用虚构账号数据）。');
