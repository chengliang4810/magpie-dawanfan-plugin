import { timingSafeEqual } from 'node:crypto';
import { accountAPI, LoginError, savedAccounts } from './login.mjs';

function sameKey(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const left = Buffer.from(a), right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

export async function changeAPIKey(directory, inputs) {
  const account = savedAccounts(directory).find(({ id }) => id === inputs?.account);
  if (!account) throw new LoginError('所选账号已不存在，请先进行网页登录。');
  const key = typeof inputs?.apiKey === 'string' ? inputs.apiKey.trim() : '';
  if (!key || /[\r\n]/.test(key)) throw new LoginError('请填写有效的 API Key。');
  const { metadata } = account.auth;
  const sessionToken = metadata.sessionToken;
  if (typeof sessionToken !== 'string' || !sessionToken) throw new LoginError('请先进行网页登录以确认账号。');
  const signal = AbortSignal.timeout(30_000);
  const profile = await accountAPI('/api/me', sessionToken, { signal });
  if (profile?.email !== metadata.email) throw new LoginError('官网会话与所选账号不一致，请重新进行网页登录。');
  const keys = await accountAPI('/api/keys', sessionToken, { signal });
  if (!Array.isArray(keys)) throw new LoginError('大碗饭密钥列表格式异常，请重试。');
  const candidates = keys.filter((item) => item?.status === 'active'
    && typeof item.prefix === 'string' && item.prefix && key.startsWith(item.prefix));
  let matched;
  for (const candidate of candidates) {
    if (!['string', 'number'].includes(typeof candidate.id)) continue;
    const revealed = await accountAPI(`/api/keys/${encodeURIComponent(candidate.id)}/reveal`, sessionToken, { signal });
    if (sameKey(key, revealed?.key)) { matched = candidate; break; }
  }
  if (!matched) throw new LoginError('该 API Key 不属于所选账号、已停用或无法验证，请在官网确认。');
  // Ownership is checked before using the key, so usage and model requests
  // cannot silently belong to different accounts.
  const models = await accountAPI('/v1/models', key, { signal });
  if (!Array.isArray(models?.data)) throw new LoginError('无法验证该 API Key 的模型权限，请重试。');
  // Re-read before returning a replacement to the host: do not resurrect an
  // account that was removed or replace a newly renewed web session.
  const current = savedAccounts(directory).find(({ id }) => id === account.id);
  if (!current || current.auth.metadata.email !== metadata.email) {
    throw new LoginError('账号已发生变化，请重新选择账号。');
  }
  return {
    type: 'success', key,
    metadata: { ...current.auth.metadata, apiKeySource: 'custom', keyName: matched.name || '' },
  };
}

export function changeKeyMethod(directory) {
  return {
    type: 'oauth',
    label: '更换 API Key',
    get prompts() {
      return [
        { type: 'select', key: 'account', message: '账号', options: savedAccounts(directory)
          .map(({ id, auth }) => ({ value: id, label: auth.metadata.email })) },
        { type: 'password', key: 'apiKey', message: '新的 API Key', placeholder: 'sk-mp-…',
          validate: (value) => typeof value === 'string' && value.trim() && !/[\r\n]/.test(value)
            ? undefined : '请填写有效的 API Key。' },
      ];
    },
    async authorize(inputs) {
      return {
        url: '', method: 'auto', instructions: '',
        async callback() {
          try { return await changeAPIKey(directory, inputs); }
          catch (error) { return { type: 'failed', error: error instanceof LoginError
            ? error.message : '更换 API Key 失败，请重试。' }; }
        },
      };
    },
  };
}
