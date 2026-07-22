import { OpenAiCompatibleClient } from "./openai-compatible.js";
import type { ProviderConfig } from "./openai-compatible.js";

export { OpenAiCompatibleClient, type ProviderConfig, LlmCallError } from "./openai-compatible.js";

export type ProviderFactory = (config: ProviderConfig) => OpenAiCompatibleClient;

export type ProviderSpec = {
  name: string;
  envKey: string;
  baseUrl: string;
  factory: (config: ProviderConfig) => OpenAiCompatibleClient;
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
    factory: (config) => new OpenAiCompatibleClient({ ...config, baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1" }),
  },
  deepseek: {
    name: "DeepSeek",
    envKey: "DEEPSEEK_API_KEY",
    baseUrl: "https://api.deepseek.com/v1",
    factory: (config) => new OpenAiCompatibleClient({ ...config, baseUrl: "https://api.deepseek.com/v1" }),
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

  const apiKey = config.apiKey ?? env[spec.envKey];
  if (!apiKey) throw new Error(`${spec.envKey} is not set in environment for provider "${provider}".`);

  const { apiKey: _ignoredKey, ...restConfig } = config;
  return spec.factory({
    apiKey,
    baseUrl: spec.baseUrl,
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
