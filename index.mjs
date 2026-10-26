import { readFileSync } from 'node:fs';
import {
  BASE_URL, PROVIDER, credentials, loadModels, loadUsage, forwardRequest,
} from './lib/dawan.mjs';
import { authorizeBrowserLogin } from './lib/browser-login.mjs';

const icon = `data:image/svg+xml;base64,${readFileSync(new URL('./assets/logo.svg', import.meta.url)).toString('base64')}`;

export const DawanFanPlugin = async (_input, options = {}) => ({
  async config(config) {
    config.provider ??= {};
    config.provider[PROVIDER] ??= {
      name: '大碗饭',
      npm: '@ai-sdk/openai-compatible',
      api: BASE_URL,
      models: {
        'deepseek-v4.1-flash': {
          name: 'DeepSeek V4.1 Flash',
          limit: { context: 0, output: 0 },
          tool_call: true,
          reasoning: true,
        },
      },
    };
  },
  auth: {
    provider: PROVIDER,
    icon,
    methods: [
      {
        type: 'oauth',
        label: '网页登录',
        authorize: () => authorizeBrowserLogin({ browserChannel: options.browserChannel }),
      },
    ],
    async loader(getAuth) {
      const auth = credentials(await getAuth());
      if (!auth) return {};
      return {
        baseURL: BASE_URL,
        apiKey: auth.key,
        async fetch(input, init) {
          // Read the account on each request; do not retain a different account's key.
          const current = credentials(await getAuth());
          if (!current) throw Object.assign(new Error('请先进行大碗饭网页登录。'), { signIn: 'expired' });
          return forwardRequest(input, init, current.key);
        },
      };
    },
    async usage(getAuth) {
      return loadUsage(await getAuth());
    },
  },
  provider: {
    id: PROVIDER,
    async models(provider, { auth } = {}) {
      return loadModels(provider, auth);
    },
  },
});
