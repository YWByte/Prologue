import { OpenAiCompatibleClient } from "./openai-compatible.js";
import type { ProviderConfig } from "./openai-compatible.js";

export { OpenAiCompatibleClient, type ProviderConfig } from "./openai-compatible.js";

export type SiliconFlowConfig = Partial<ProviderConfig> & {
  apiKey: string;
};

export function createSiliconFlowClient(config: SiliconFlowConfig): OpenAiCompatibleClient {
  return new OpenAiCompatibleClient({
    baseUrl: "https://api.siliconflow.cn/v1",
    ...config,
  });
}

export function createSiliconFlowClientFromEnv(env: Record<string, string | undefined> = process.env): OpenAiCompatibleClient {
  const apiKey = env.SILICONFLOW_API_KEY;
  if (!apiKey) throw new Error("SILICONFLOW_API_KEY is not set in environment.");
  return createSiliconFlowClient({ apiKey });
}
