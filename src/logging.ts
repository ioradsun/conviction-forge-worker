/**
 * Logging — structured, and blind to secrets by construction.
 *
 * `redact` runs over every string the logger emits. It removes the exact
 * secret values from config AND a set of shape-based patterns (bearer tokens,
 * GitHub/OpenAI-style keys, `https://user:pass@host` URLs), so a secret that
 * arrives from somewhere other than our own env — echoed in a subprocess's
 * error, say — is still scrubbed.
 */
import { secretValues } from "./config.ts";

const TOKEN_PATTERNS: RegExp[] = [
  /\bBearer\s+[A-Za-z0-9._~+/=-]{6,}/gi, // Authorization: Bearer ...
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g, // GitHub tokens (ghp_, gho_, ghu_, ghs_, ghr_)
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g, // GitHub fine-grained PATs
  /\bsk-[A-Za-z0-9-]{16,}/g, // OpenAI/OpenRouter-style keys
  /\bsk-or-[A-Za-z0-9-]{16,}/g, // OpenRouter keys
  /(https?:\/\/)[^/\s:@]+:[^/\s@]+@/g, // credentials embedded in a URL
];

export function redact(input: unknown): string {
  let s = typeof input === "string" ? input : safeStringify(input);
  for (const secret of secretValues()) {
    // Escape the secret for use in a RegExp, then replace all occurrences.
    s = s.split(secret).join("***");
  }
  for (const re of TOKEN_PATTERNS) {
    s = s.replace(re, (m, p1?: string) => (p1 ? `${p1}***@` : "***"));
  }
  return s;
}

function safeStringify(v: unknown): string {
  try {
    return typeof v === "object" ? JSON.stringify(v) : String(v);
  } catch {
    return String(v);
  }
}

type Level = "debug" | "info" | "warn" | "error";

function emit(level: Level, message: string, fields?: Record<string, unknown>) {
  const line: Record<string, unknown> = {
    ts: new Date().toISOString(),
    level,
    msg: redact(message),
  };
  if (fields) {
    for (const [k, v] of Object.entries(fields)) {
      line[k] = typeof v === "string" ? redact(v) : v;
    }
  }
  const out = JSON.stringify(line);
  if (level === "error" || level === "warn") console.error(out);
  else console.log(out);
}

export const log = {
  debug: (message: string, fields?: Record<string, unknown>) => emit("debug", message, fields),
  info: (message: string, fields?: Record<string, unknown>) => emit("info", message, fields),
  warn: (message: string, fields?: Record<string, unknown>) => emit("warn", message, fields),
  error: (message: string, fields?: Record<string, unknown>) => emit("error", message, fields),
};
