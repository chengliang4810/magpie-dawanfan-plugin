export const PROVIDER = 'dawanfan';
export const ORIGIN = 'https://dawan.fan';
export const BASE_URL = `${ORIGIN}/v1`;
const TIMEOUT = 15_000;
const INFERENCE_PATHS = new Set(['/v1/chat/completions', '/v1/responses', '/v1/messages', '/v1/models']);

export function credentials(auth) {
  if (auth?.type !== 'api' || typeof auth.key !== 'string' || !auth.key.trim()) return null;
  return {
    key: auth.key.trim(),
    sessionToken: typeof auth.metadata?.sessionToken === 'string' ? auth.metadata.sessionToken.trim() : '',
  };
}

class ServiceError extends Error {
  constructor(status) {
    super(`大碗饭接口返回 HTTP ${status}。`);
    this.status = status;
  }
}

async function readJSON(path, token) {
  const response = await fetch(`${ORIGIN}${path}`, {
    headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
    redirect: 'error',
    signal: AbortSignal.timeout(TIMEOUT),
  });
  if (!response.ok) throw new ServiceError(response.status);
  return response.json();
}

export async function forwardRequest(input, init, key) {
  const request = new Request(input, init);
  const url = new URL(request.url);
  if (url.origin !== ORIGIN || url.username || url.password || !INFERENCE_PATHS.has(url.pathname)) {
    throw new Error('大碗饭插件只接受 dawan.fan 的模型接口。');
  }
  const headers = new Headers(request.headers);
  headers.set('authorization', `Bearer ${key}`);
  headers.delete('cookie');
  headers.delete('x-api-key');
  headers.delete('x-goog-api-key');
  // Return the original Response so SSE, tool calls, errors and cancellation survive.
  return fetch(new Request(request, { headers, redirect: 'error' }));
}

export async function loadModels(provider, storedAuth) {
  const auth = credentials(storedAuth);
  if (!auth) return provider.models;
  let data;
  try {
    data = await readJSON('/v1/models', auth.key);
    if (!Array.isArray(data?.data)) throw new Error('模型列表格式异常');
  } catch (error) {
    if (error.status === 401) {
      throw Object.assign(new Error('大碗饭 API Key 无效，请重新进行网页登录。'), { signIn: 'expired' });
    }
    return provider.models;
  }

  const details = new Map();
  if (auth.sessionToken) {
    // Optional display metadata must never replace the API key's authoritative model list.
    try {
      const metadata = await readJSON('/api/me/models', auth.sessionToken);
      for (const model of metadata.models ?? []) details.set(model.model_id, model);
      for (const route of metadata.routes ?? []) details.set(route.virtual_model, route);
    } catch { /* An expired web session does not invalidate a working API key. */ }
  }

  return Object.fromEntries(data.data.filter((model) => typeof model?.id === 'string' && model.id).map((model) => {
    const id = model.id;
    const previous = provider.models?.[id];
    const detail = details.get(id);
    return [id, {
      ...previous,
      id,
      name: model.name || detail?.name || id,
      api: { ...previous?.api, id, url: BASE_URL, npm: '@ai-sdk/openai-compatible' },
      // The service does not publish limits/capabilities in /v1/models.
      // Zero is magpie's unknown limit; preserve explicit user configuration.
      limit: { context: 0, output: 0, ...previous?.limit },
      capabilities: {
        temperature: true, reasoning: false, toolcall: true, attachment: false,
        input: { text: true }, output: { text: true }, ...previous?.capabilities,
      },
      ...(typeof detail?.multiplier === 'number' && Number.isFinite(detail.multiplier)
        ? { rate: detail.multiplier } : {}),
    }];
  }));
}

function timestamp(value) {
  const date = new Date(value);
  return typeof value === 'string' && Number.isFinite(date.getTime()) ? date.toISOString() : undefined;
}

export function mapUsage(profile) {
  const subscription = profile?.subscription;
  const user = typeof profile?.email === 'string' ? profile.email : undefined;
  if (subscription == null) return { user, plan: '暂无套餐', windows: [], signIn: 'kept' };
  const { used, monthly } = subscription;
  if (!Number.isFinite(used) || used < 0 || !Number.isFinite(monthly) || monthly < 0) {
    throw new Error('套餐用量格式异常');
  }
  const end = timestamp(subscription.period_end);
  const start = timestamp(subscription.period_start);
  const span = start && end ? (Date.parse(end) - Date.parse(start)) / 1000 : 0;
  return {
    user,
    plan: subscription.plan_name || subscription.plan,
    ...(end ? { until: end } : {}),
    balance: `${Math.max(0, monthly - used)} 次`,
    signIn: 'kept',
    windows: [{
      name: '本月用量',
      ...(monthly > 0 ? { used: used / monthly * 100 } : {}),
      amount: used,
      limit: monthly,
      unit: '次',
      display: `${used} / ${monthly} 次`,
      ...(end ? { resetsAt: end } : {}),
      ...(span > 0 ? { span } : {}),
    }],
  };
}

export async function loadUsage(storedAuth) {
  const auth = credentials(storedAuth);
  if (!auth) return { error: '请先进行大碗饭网页登录。', signIn: 'expired' };
  if (!auth.sessionToken) return {
    error: '请使用“网页登录”连接账号，以自动获取套餐用量。',
    signIn: 'kept',
  };
  try {
    return mapUsage(await readJSON('/api/me', auth.sessionToken));
  } catch (error) {
    return {
      error: error.status === 401 || error.status === 403
        ? '官网登录已过期，请重新进行网页登录以查看用量。模型 API Key 可继续使用。'
        : error instanceof ServiceError ? error.message : '读取大碗饭用量失败，请稍后重试。',
      signIn: 'kept',
    };
  }
}
