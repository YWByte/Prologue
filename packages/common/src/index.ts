export type TokenUsage = {
  input: number;
  output: number;
  total: number;
};

export type LlmMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
};

export type LlmCallInput = {
  model: string;
  messages: LlmMessage[];
  temperature?: number;
  maxTokens?: number;
  stop?: string[];
  enableThinking?: boolean;
};

export type LlmCallOutput = {
  content: string;
  tokenUsage?: TokenUsage;
  raw?: unknown;
};

export interface LlmClient {
  call(input: LlmCallInput): Promise<LlmCallOutput>;
}

export type EvalResult = {
  success: boolean;
  score?: number;
  reason?: string;
};

export {
  OpenAiCompatibleClient,
  type ProviderConfig,
  type VllmConfig,
  LlmCallError,
  createVllmClient,
  createVllmClientFromEnv,
  VLLM_DEFAULT_BASE_URL,
  VLLM_DEFAULT_API_KEY,
  VLLM_DEFAULT_MODEL,
  createClient,
  createClientFromEnv,
  registerProvider,
  listProviders,
  PROVIDERS,
  type ProviderFactory,
  type ProviderSpec,
} from "./providers/index.js";

export { loadEnvFile, loadEnvIntoProcess } from "./env.js";
