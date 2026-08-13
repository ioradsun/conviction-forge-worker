/**
 * OpenRouter — the model provider, server side only.
 *
 * This is the worker's copy of the app's `openrouter.server.ts`, with one
 * difference: the worker is handed concrete model ids in the job
 * (builderModel / challengerModel / escalationModel), so it calls a model by
 * id rather than resolving a role registry. The key never leaves this runtime
 * and never appears in a log line.
 */
import { config } from "../config.ts";

export type ChatMessage = { role: "system" | "user" | "assistant"; content: string };

export type ModelResult = {
  text: string;
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
  modelId: string;
};

export class OpenRouterNotConfigured extends Error {
  constructor() {
    super("OPENROUTER_API_KEY is not configured.");
    this.name = "OpenRouterNotConfigured";
  }
}

export function openRouterConfigured(): boolean {
  return Boolean(config.openRouterApiKey);
}

export async function callModel(
  modelId: string,
  messages: ChatMessage[],
  opts: { timeoutMs?: number; maxTokens?: number; temperature?: number } = {},
): Promise<ModelResult> {
  const key = config.openRouterApiKey;
  if (!key) throw new OpenRouterNotConfigured();

  const started = Date.now();
  const controller = new AbortController();
  // Reasoning calls over repo context are slow; these run in background phases,
  // not under the 60s request cap, so give them real room.
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 240_000);

  try {
    const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${key}`,
        "content-type": "application/json",
        "X-Title": "Conviction Forge Worker",
      },
      body: JSON.stringify({
        model: modelId,
        messages,
        max_tokens: opts.maxTokens ?? 4096,
        temperature: opts.temperature ?? 0.3,
      }),
    });

    if (!res.ok) {
      const body = (await res.text()).slice(0, 400);
      throw new Error(`OpenRouter ${res.status}: ${body}`);
    }

    const jsonBody = (await res.json()) as {
      choices?: { message?: { content?: string } }[];
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };

    return {
      text: jsonBody.choices?.[0]?.message?.content ?? "",
      inputTokens: jsonBody.usage?.prompt_tokens ?? 0,
      outputTokens: jsonBody.usage?.completion_tokens ?? 0,
      latencyMs: Date.now() - started,
      modelId,
    };
  } finally {
    clearTimeout(timer);
  }
}

/** Pull the first fenced or bare JSON object out of a model's prose reply. */
export function extractJson(text: string): unknown | null {
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  const candidate = fence?.[1] ?? text;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return null;
  try {
    return JSON.parse(candidate.slice(start, end + 1));
  } catch {
    return null;
  }
}
