import { ORIGIN } from './dawan.mjs';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export const MANAGED_KEY_NAME = 'magpie';
const pendingKeys = new Map();

export class LoginError extends Error {
  constructor(message) { super(message); this.name = 'DawanLoginError'; }
}

export function savedAccounts(directory) {
  if (typeof directory !== 'string' || !directory) return [];
  let stored;
  try { stored = JSON.parse(readFileSync(join(directory, 'plugin-auth.json'), 'utf8')); }
  catch (error) {
    if (error.code === 'ENOENT') return [];
    throw new LoginError('无法读取已登录账号，请重试。');
  }
  if (!stored || typeof stored !== 'object' || Array.isArray(stored)) {
    throw new LoginError('已登录账号的存储格式异常，请重试。');
  }
  return Object.entries(stored).filter(([id, auth]) =>
    (id === 'dawanfan' || id.startsWith('dawanfan#'))
    && auth?.type === 'api' && keyValue(auth.key) && typeof auth.metadata?.email === 'string'
  ).map(([id, auth]) => ({ id, auth }));
}

export async function accountAPI(path, sessionToken, { method = 'GET', body, signal } = {}) {
  let response;
  try {
    response = await fetch(`${ORIGIN}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${sessionToken}`,
        accept: 'application/json',
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      redirect: 'error',
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000),
    });
  } catch {
    throw new LoginError('连接大碗饭失败，请检查网络后重试。');
  }
  if (response.status === 401) throw new LoginError(path.startsWith('/v1/')
    ? 'API Key 无效，请检查后重试。' : '官网登录会话无效或已过期，请重新登录。');
  if (!response.ok) throw new LoginError(`大碗饭接口返回 HTTP ${response.status}，请重试。`);
  try { return await response.json(); }
  catch { throw new LoginError('大碗饭返回的数据格式异常，请重试。'); }
}

function keyValue(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

async function reveal(key, sessionToken, signal) {
  if ((typeof key.id !== 'number' && typeof key.id !== 'string') || !String(key.id)) {
    throw new LoginError('magpie 密钥缺少有效的 ID，无法读取。');
  }
  const value = await accountAPI(`/api/keys/${encodeURIComponent(key.id)}/reveal`, sessionToken, { signal });
  const secret = keyValue(value?.key);
  if (!secret) throw new LoginError('无法读取已有的 magpie 密钥，请在官网检查该密钥。');
  return secret;
}

async function ensureKey(sessionToken, signal) {
  const keys = await accountAPI('/api/keys', sessionToken, { signal });
  if (!Array.isArray(keys)) throw new LoginError('大碗饭密钥列表格式异常，请重试。');
  const matching = keys.filter((key) => key?.name === MANAGED_KEY_NAME && key.status === 'active');
  // Prefer a retrievable entry if an account has several keys with this name.
  const existing = matching.find((key) => key.has_enc !== false) ?? matching[0];
  if (existing) return reveal(existing, sessionToken, signal);

  // Never retry this POST automatically: if its response is lost, the next
  // sign-in will list the keys again instead of creating another blindly.
  const created = await accountAPI('/api/keys', sessionToken, {
    method: 'POST', body: { name: MANAGED_KEY_NAME }, signal,
  });
  return keyValue(created?.key) ?? reveal(created ?? {}, sessionToken, signal);
}

export async function completeBrowserLogin(sessionToken, { signal, directory } = {}) {
  if (!keyValue(sessionToken)) throw new LoginError('没有取得官网登录会话，请重试。');
  const profile = await accountAPI('/api/me', sessionToken, { signal });
  if (typeof profile?.email !== 'string' || !profile.email) {
    throw new LoginError('无法确认登录账号，请重新登录。');
  }
  const custom = savedAccounts(directory).find(({ auth }) =>
    auth.metadata.email === profile.email && auth.metadata.apiKeySource === 'custom');
  if (custom) return {
    type: 'success', key: custom.auth.key,
    metadata: { ...custom.auth.metadata, email: profile.email, sessionToken },
  };
  // Serialize provisioning for the same verified account, including concurrent
  // login windows. Different accounts never share keys or session tokens.
  const account = JSON.stringify([profile.id ?? null, profile.email]);
  let pending = pendingKeys.get(account);
  if (!pending) {
    pending = ensureKey(sessionToken, signal);
    pendingKeys.set(account, pending);
    pending.finally(() => { if (pendingKeys.get(account) === pending) pendingKeys.delete(account); }).catch(() => {});
  }
  const key = await pending;
  return {
    type: 'success',
    key,
    metadata: {
      email: profile.email,
      sessionToken,
      managedKeyName: MANAGED_KEY_NAME,
    },
  };
}
