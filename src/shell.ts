/**
 * Subprocess execution — the only place the worker runs anything.
 *
 * Rules that make this safe against untrusted repository content:
 *   - Commands are argv arrays, never shell strings. There is no shell to
 *     inject into: a filename like `$(rm -rf ~)` is just an argument.
 *   - The environment is curated, not inherited. `baseEnv()` carries no
 *     secrets, so a repo build script (`check:*`, `build`) that reads
 *     `process.env` sees no worker/GitHub/OpenRouter credentials. Callers that
 *     legitimately need a secret (git push, OpenCode) opt it in explicitly.
 *   - Every run is bounded by a timeout and its captured output is capped, so a
 *     runaway or noisy command cannot exhaust memory or hang a request.
 */
import { log } from "./logging.ts";

export type RunResult = {
  code: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  durationMs: number;
};

export type RunOptions = {
  cwd: string;
  /** Extra environment on top of `baseEnv()`. Values of `undefined` are dropped. */
  env?: Record<string, string | undefined>;
  timeoutMs?: number;
  /** Data piped to stdin. */
  input?: string;
  /** Max bytes kept from each of stdout/stderr (head+tail). Default 64 KiB. */
  maxOutputBytes?: number;
};

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_OUTPUT = 64 * 1024;

/**
 * A minimal, secret-free environment. Everything a normal Unix tool needs to
 * find binaries and a home directory — and nothing sensitive.
 */
export function baseEnv(): Record<string, string> {
  const passthrough = [
    "PATH",
    "HOME",
    "LANG",
    "LC_ALL",
    "TERM",
    "TMPDIR",
    "SHELL",
    "USER",
    // Networking + TLS. Not secret, and required for git/fetch to work behind a
    // proxy or with a custom CA bundle (corporate networks, this sandbox). A
    // curated env must not silently break outbound HTTPS.
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "ALL_PROXY",
    "NO_PROXY",
    "http_proxy",
    "https_proxy",
    "all_proxy",
    "no_proxy",
    "GIT_SSL_CAINFO",
    "SSL_CERT_FILE",
    "SSL_CERT_DIR",
    "NODE_EXTRA_CA_CERTS",
    "CURL_CA_BUNDLE",
    "REQUESTS_CA_BUNDLE",
    "NIX_SSL_CERT_FILE",
  ];
  const out: Record<string, string> = {};
  for (const key of passthrough) {
    const v = process.env[key];
    if (v) out[key] = v;
  }
  // Non-interactive by default: no editor pager, no credential prompts.
  out.GIT_TERMINAL_PROMPT = "0";
  out.GIT_PAGER = "cat";
  out.PAGER = "cat";
  out.CI = "1";
  return out;
}

function capOutput(s: string, max: number): string {
  if (s.length <= max) return s;
  const half = Math.floor(max / 2);
  return `${s.slice(0, half)}\n…[${s.length - max} bytes truncated]…\n${s.slice(s.length - half)}`;
}

export async function run(cmd: string[], opts: RunOptions): Promise<RunResult> {
  const started = Date.now();
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxOutput = opts.maxOutputBytes ?? DEFAULT_MAX_OUTPUT;

  const env: Record<string, string> = baseEnv();
  if (opts.env) {
    for (const [k, v] of Object.entries(opts.env)) {
      if (v !== undefined) env[k] = v;
    }
  }

  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  log.debug("run", { cmd: cmd.join(" "), cwd: opts.cwd, timeoutMs });

  try {
    const proc = Bun.spawn(cmd, {
      cwd: opts.cwd,
      env,
      stdin: opts.input ? new TextEncoder().encode(opts.input) : "ignore",
      stdout: "pipe",
      stderr: "pipe",
      signal: controller.signal,
    });

    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);

    return {
      code: timedOut ? 124 : code,
      stdout: capOutput(stdout, maxOutput),
      stderr: capOutput(stderr, maxOutput),
      timedOut,
      durationMs: Date.now() - started,
    };
  } catch (err) {
    // Spawn failure (e.g. binary not found) or abort.
    const message = err instanceof Error ? err.message : String(err);
    return {
      code: timedOut ? 124 : 127,
      stdout: "",
      stderr: timedOut ? `Timed out after ${timeoutMs}ms` : message,
      timedOut,
      durationMs: Date.now() - started,
    };
  } finally {
    clearTimeout(timer);
  }
}

/** Convenience: run and return whether it exited 0. */
export async function runOk(cmd: string[], opts: RunOptions): Promise<boolean> {
  const r = await run(cmd, opts);
  return r.code === 0;
}
