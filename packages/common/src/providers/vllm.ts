import { OpenAiCompatibleClient } from "./openai-compatible.js";
import type { ProviderConfig } from "./openai-compatible.js";

export { OpenAiCompatibleClient, type ProviderConfig } from "./openai-compatible.js";

/**
 * Local vLLM OpenAI-compatible endpoint configuration.
 *
 * vLLM by default does not validate the API key (unless `--api-key` is set
 * on the server), so `apiKey` defaults to the placeholder `"EMPTY"`. Set
 * `VLLM_API_KEY` if your vLLM server was started with `--api-key`.
 *
 * `baseUrl` defaults to `http://localhost:4000/v1` (the port used by
 * `start_vllm_qwen35.sh`). Override with `VLLM_BASE_URL` for other setups.
 */
export type VllmConfig = Partial<ProviderConfig> & {
  apiKey?: string;
  baseUrl?: string;
};

export const VLLM_DEFAULT_BASE_URL = "http://localhost:4000/v1";
export const VLLM_DEFAULT_API_KEY = "EMPTY";
export const VLLM_DEFAULT_MODEL = "qwen3.5-27b";

export function createVllmClient(config: VllmConfig = {}): OpenAiCompatibleClient {
  const baseUrl = config.baseUrl ?? process.env.VLLM_BASE_URL ?? VLLM_DEFAULT_BASE_URL;
  const apiKey = config.apiKey ?? process.env.VLLM_API_KEY ?? VLLM_DEFAULT_API_KEY;
  const defaultModel = config.defaultModel ?? VLLM_DEFAULT_MODEL;
  const { apiKey: _ignoredKey, baseUrl: _ignoredUrl, defaultModel: _ignoredModel, ...restConfig } = config;
  return new OpenAiCompatibleClient({
    ...restConfig,
    baseUrl,
    apiKey,
    defaultModel,
  });
}

export function createVllmClientFromEnv(env: Record<string, string | undefined> = process.env): OpenAiCompatibleClient {
  return createVllmClient({
    apiKey: env.VLLM_API_KEY,
    baseUrl: env.VLLM_BASE_URL,
  });
}
