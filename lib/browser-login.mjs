import { setTimeout as delay } from 'node:timers/promises';
import { ORIGIN } from './dawan.mjs';
import { completeBrowserLogin, LoginError } from './login.mjs';

export async function launchBrowser(channel) {
  const { chromium } = await import('playwright-core');
  const channels = channel ? [channel] : process.platform === 'win32' ? ['msedge', 'chrome'] : ['chrome', 'msedge'];
  if (channels.some((value) => !['chrome', 'msedge'].includes(value))) {
    throw new LoginError('browserChannel 仅支持 chrome 或 msedge。');
  }
  for (const candidate of channels) {
    try {
      // Playwright owns an ephemeral profile. No existing browser profile,
      // password store, cookies or browsing history are read or modified.
      return await chromium.launch({ channel: candidate, headless: false, timeout: 20_000 });
    } catch { /* Try the other installed browser. */ }
  }
  throw new LoginError('无法打开登录窗口，请安装 Chrome 或 Microsoft Edge 后重试。');
}

export async function authorizeBrowserLogin({
  browserChannel,
  launch = launchBrowser,
  complete = completeBrowserLogin,
  timeoutMs = 10 * 60_000,
  pollInterval = 300,
} = {}) {
  let browser;
  let page;
  let timer;
  let finished = false;
  const controller = new AbortController();
  let resolveResult;
  const result = new Promise((resolve) => { resolveResult = resolve; });

  const finish = async (value) => {
    if (finished) return;
    finished = true;
    clearTimeout(timer);
    controller.abort();
    try { await browser?.close(); } catch { /* It may already be closed. */ }
    resolveResult(value);
  };
  const fail = (error) => finish({
    type: 'failed',
    error: error instanceof LoginError ? error.message : '网页登录失败，请重试。',
  });
  const description = {
    // This plugin has already opened its isolated browser window. An empty
    // URL also prevents older hosts from opening a second, unobserved tab.
    url: '',
    opened: true,
    instructions: '请在打开的大碗饭窗口完成登录。',
    method: 'auto',
    async callback() { return result; },
  };

  try {
    browser = await launch(browserChannel);
    browser.on('disconnected', () => {
      void finish({ type: 'failed', error: '登录窗口已关闭，请重新登录。' });
    });
    const context = await browser.newContext({ viewport: { width: 1000, height: 760 } });
    page = await context.newPage();
    page.on('close', () => {
      void finish({ type: 'failed', error: '登录窗口已关闭，请重新登录。' });
    });
    timer = setTimeout(() => {
      void finish({ type: 'failed', error: '网页登录已超时，请重新登录。' });
    }, timeoutMs);
    await page.goto(`${ORIGIN}/login`, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  } catch (error) {
    await fail(error);
    return description;
  }

  // The operation starts immediately, even if the host delays callback().
  // The deadline also closes abandoned windows when a host cancels its UI.
  void (async () => {
    try {
      while (!finished) {
        let sessionToken;
        try {
          sessionToken = await page.evaluate((origin) => {
            if (window.location.origin !== origin) return '';
            return window.localStorage.getItem('zt_token') || '';
          }, ORIGIN);
        } catch {
          // A successful sign-in can navigate while storage is being read.
          if (page.isClosed()) {
            await finish({ type: 'failed', error: '登录窗口已关闭，请重新登录。' });
            return;
          }
        }
        if (sessionToken) {
          const value = await complete(sessionToken, { signal: controller.signal });
          await finish(value);
          return;
        }
        await delay(pollInterval, undefined, { signal: controller.signal });
      }
    } catch (error) {
      if (!finished) await fail(error);
    }
  })();
  return description;
}
