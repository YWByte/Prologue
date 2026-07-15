import type { CanonicalTask, MemoryItem, ToolItem } from "@prologue/schemas";

export type PrologueContext = {
  intent: string;
  memory: MemoryItem[];
  tools: ToolItem[];
};

export type VerifierOutput = {
  score: number;
  missing: "intent" | "memory" | "tool" | "multiple" | "none";
};

export interface IntentClarifier {
  clarify(task: CanonicalTask): Promise<string>;
}

export interface MemoryGater {
  select(task: CanonicalTask, intent: string): Promise<MemoryItem[]>;
}

export interface ToolSelector {
  select(task: CanonicalTask, intent: string): Promise<ToolItem[]>;
}

export interface SufficiencyVerifier {
  verify(task: CanonicalTask, context: PrologueContext): Promise<VerifierOutput>;
}
