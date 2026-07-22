import { createVllmClient, createVllmClientFromEnv, VLLM_DEFAULT_API_KEY, VLLM_DEFAULT_BASE_URL } from "./vllm.js";
import { OpenAiCompatibleClient } from "./openai-compatible.js";
import type { ProviderConfig } from "./openai-compatible.js";

export { OpenAiCompatibleClient, type ProviderConfig, LlmCallError } from "./openai-compatible.js";
export {
  createVllmClient,
  createVllmClientFromEnv,
  type VllmConfig,
  VLLM_DEFAULT_BASE_URL,
  VLLM_DEFAULT_API_KEY,
  VLLM_DEFAULT_MODEL,
} from "./vllm.js";

export type ProviderFactory = (config: ProviderConfig) => OpenAiCompatibleClient;

export type ProviderSpec = {
  name: string;
  envKey: string;
  baseUrl: string;
  factory: (config: ProviderConfig) => OpenAiCompatibleClient;
  /**
   * When true, the provider does not require an API key in the environment
   * (e.g. local vLLM server with `--api-key` not set). The factory receives
   * a placeholder key (`"EMPTY"`) so the OpenAI-compatible `Authorization`
   * header can still be sent.
   */
  optionalApiKey?: boolean;
  /**
   * Optional env var name that overrides `baseUrl` at factory time. Useful
   * for local providers where the port/host may vary between setups.
   */
  baseUrlEnvKey?: string;
};

export const PROVIDERS: Record<string, ProviderSpec> = {
  siliconflow: {
    name: "SiliconFlow",
    envKey: "SILICONFLOW_API_KEY",
    baseUrl: "https://api.siliconflow.cn/v1",
    factory: (config) => new OpenAiCompatibleClient({ ...config, baseUrl: "https://api.siliconflow.cn/v1" }),
  },
  openai: {
    name: "OpenAI",
    envKey: "OPENAI_API_KEY",
    baseUrl: "https://api.openai.com/v1",
    factory: (config) => new OpenAiCompatibleClient({ ...config, baseUrl: "https://api.openai.com/v1" }),
  },
  dashscope: {
    name: "DashScope (Aliyun)",
    envKey: "DASHSCOPE_API_KEY",
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    factory: (config) =>
      new OpenAiCompatibleClient({ ...config, baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1" }),
  },
  deepseek: {
    name: "DeepSeek",
    envKey: "DEEPSEEK_API_KEY",
    baseUrl: "https://api.deepseek.com/v1",
    factory: (config) => new OpenAiCompatibleClient({ ...config, baseUrl: "https://api.deepseek.com/v1" }),
  },
  vllm: {
    name: "Local vLLM (OpenAI-compatible)",
    envKey: "VLLM_API_KEY",
    baseUrl: VLLM_DEFAULT_BASE_URL,
    optionalApiKey: true,
    baseUrlEnvKey: "VLLM_BASE_URL",
    factory: (config) =>
      createVllmClient({
        ...config,
        apiKey: config.apiKey,
        baseUrl: config.baseUrl,
      }),
  },
};

export function registerProvider(name: string, spec: ProviderSpec): void {
  PROVIDERS[name] = spec;
}

export function listProviders(): string[] {
  return Object.keys(PROVIDERS);
}

export function createClient(
  provider: string,
  config: { apiKey?: string; defaultModel?: string } & Partial<ProviderConfig> = {},
  env: Record<string, string | undefined> = process.env,
): OpenAiCompatibleClient {
  const spec = PROVIDERS[provider];
  if (!spec) throw new Error(`Unknown provider: ${provider}. Available: ${listProviders().join(", ")}`);

  let apiKey = config.apiKey ?? env[spec.envKey];
  if (!apiKey) {
    if (spec.optionalApiKey) {
      apiKey = VLLM_DEFAULT_API_KEY;
    } else {
      throw new Error(`${spec.envKey} is not set in environment for provider "${provider}".`);
    }
  }

  const baseUrl = (spec.baseUrlEnvKey && env[spec.baseUrlEnvKey]) || spec.baseUrl;
  const { apiKey: _ignoredKey, ...restConfig } = config;
  return spec.factory({
    apiKey,
    baseUrl,
    ...restConfig,
  });
}

export function createClientFromEnv(
  provider: string,
  config: { apiKey?: string; defaultModel?: string } & Partial<ProviderConfig> = {},
  env: Record<string, string | undefined> = process.env,
): OpenAiCompatibleClient {
  return createClient(provider, config, env);
}
