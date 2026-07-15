export type TokenUsage = {
  input: number;
  output: number;
  total: number;
};

export type LlmCallInput = {
  model: string;
  messages: Array<{ role: string; content: string }>;
  temperature?: number;
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
